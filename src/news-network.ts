import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

const BLOCKED_V4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(address, prefix, "ipv4");

const PUBLIC_V6 = new BlockList();
PUBLIC_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new BlockList();
for (const [address, prefix] of [
  ["::ffff:0:0", 96], // IPv4-mapped addresses must never bypass the IPv4 checks.
  ["2001::", 32], // Teredo
  ["2001:10::", 28], // ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
] as const) BLOCKED_V6.addSubnet(address, prefix, "ipv6");

const INTERNAL_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".test", ".invalid", ".example", ".arpa", ".onion"];
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12_000;
export const NEWS_USER_AGENT = "Tonarin-news/0.2 (RSS reader)";

export type NewsFetchCode = "url" | "address" | "dns" | "network" | "timeout" | "http" | "size" | "redirect" | "encoding" | "feed" | "config" | "rights" | "robots" | "paywall";

export class NewsFetchError extends Error {
  constructor(message: string, readonly code: NewsFetchCode, readonly httpStatus?: number) {
    super(message);
    this.name = "NewsFetchError";
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, "ipv4");
  if (family === 6) return PUBLIC_V6.check(address, "ipv6") && !BLOCKED_V6.check(address, "ipv6");
  return false;
}

/** Validate on entry and at every redirect, before resolving or connecting. */
export function publicHttpsUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new NewsFetchError("Enter a valid HTTPS site or feed URL.", "url");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.length > MAX_URL_LENGTH ||
    !hostname ||
    hostname.endsWith(".") ||
    (!isIP(hostname) && (!hostname.includes(".") || INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))))
  ) {
    throw new NewsFetchError("Only public HTTPS site or feed URLs without credentials are allowed.", "url");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new NewsFetchError("Private and local network addresses are not allowed.", "address");
  url.hash = "";
  return url;
}

export interface NewsNetwork {
  resolve(hostname: string): Promise<LookupAddress[]>;
  request(url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest;
}

const DEFAULT_NETWORK: NewsNetwork = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: (url, options, onResponse) => https.request(url, options, onResponse),
};

export interface NewsResource {
  url: URL;
  bytes: Buffer;
  contentType: string;
  headers: IncomingHttpHeaders;
}

export interface NewsRequest {
  limitBytes: number;
  signal?: AbortSignal;
  allowRedirect?: (url: URL) => boolean | Promise<boolean>;
}

function connectedToPinnedAddress(actual: string | undefined, pinned: LookupAddress): boolean {
  if (!actual || !isPublicAddress(actual) || isIP(actual) !== pinned.family) return false;
  const onlyPinned = new BlockList();
  onlyPinned.addAddress(pinned.address, pinned.family === 4 ? "ipv4" : "ipv6");
  return onlyPinned.check(actual, pinned.family === 4 ? "ipv4" : "ipv6");
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function readResponse(response: IncomingMessage, limitBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    throw new NewsFetchError("The site sent compressed data despite an identity-only request.", "encoding");
  }
  const declared = response.headers["content-length"];
  if (declared !== undefined && Number(declared) > limitBytes) throw new NewsFetchError("The news response is too large.", "size");
  const chunks: Buffer[] = [];
  let size = 0;
  const onAbort = () => response.destroy(new NewsFetchError("The news site took too long to respond.", "timeout"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for await (const chunk of response) {
      size += (chunk as Buffer).length;
      if (size > limitBytes) throw new NewsFetchError("The news response is too large.", "size");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Native HTTPS only: no proxy agent, automatic redirects or decompression; every socket is DNS-pinned and verified. */
export async function fetchPublicHttps(value: string | URL, options: NewsRequest, network: NewsNetwork = DEFAULT_NETWORK): Promise<NewsResource> {
  const signal = options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = publicHttpsUrl(value);
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw new NewsFetchError("The news site took too long to respond.", "timeout");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: LookupAddress[];
    try {
      addresses = await withAbort(network.resolve(hostname), signal);
    } catch {
      if (signal.aborted) throw new NewsFetchError("The news site took too long to respond.", "timeout");
      throw new NewsFetchError("Could not resolve the news site.", "dns");
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new NewsFetchError("The news site resolves to a private or local network address.", "address");
    }
    const pinned = addresses[0];
    let response: IncomingMessage;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = network.request(
          url,
          {
            method: "GET",
            agent: false,
            rejectUnauthorized: true,
            family: pinned.family,
            lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
            headers: { "User-Agent": NEWS_USER_AGENT, "Accept-Encoding": "identity", Connection: "close" },
            signal,
          },
          resolve,
        );
        request.once("socket", (socket) => {
          socket.once("secureConnect", () => {
            if (!connectedToPinnedAddress(socket.remoteAddress, pinned)) {
              request.destroy(new NewsFetchError("The connection did not use its checked public address.", "address"));
            }
          });
        });
        request.once("error", reject);
        request.end();
      });
      if (!connectedToPinnedAddress(response.socket.remoteAddress, pinned)) {
        response.destroy();
        throw new NewsFetchError("The connection did not use its checked public address.", "address");
      }
    } catch (error) {
      if (signal.aborted) throw new NewsFetchError("The news site took too long to respond.", "timeout");
      if (error instanceof NewsFetchError) throw error;
      throw new NewsFetchError("Could not connect securely to the news site.", "network");
    }
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.destroy();
      if (redirects >= MAX_REDIRECTS) throw new NewsFetchError("The news site redirected too many times.", "redirect");
      const location = response.headers.location;
      if (!location || Array.isArray(location)) throw new NewsFetchError("The news site sent an invalid redirect.", "redirect");
      try {
        url = publicHttpsUrl(new URL(location, url));
      } catch (error) {
        if (!(error instanceof NewsFetchError || error instanceof TypeError)) throw error;
        throw new NewsFetchError("The news site redirected to a non-public HTTPS address.", "redirect");
      }
      if (options.allowRedirect && !(await withAbort(Promise.resolve(options.allowRedirect(url)), signal))) {
        throw new NewsFetchError("The news resource redirected outside its allowed site.", "redirect");
      }
      continue;
    }
    if (status !== 200) {
      response.destroy();
      throw new NewsFetchError(`The news site returned HTTP ${status}.`, "http", status);
    }
    const contentType = String(response.headers["content-type"] ?? "");
    try {
      return { url, bytes: await readResponse(response, options.limitBytes, signal), contentType, headers: response.headers };
    } catch (error) {
      response.destroy();
      if (signal.aborted) throw new NewsFetchError("The news site took too long to respond.", "timeout");
      throw error;
    }
  }
}
