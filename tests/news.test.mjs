import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import {
  CATALOG, FEED_IDS, asUntrustedNewsData, configureNewsSources, discoverNewsFeed, enabledFeedIds,
  fetchArticle, fetchHeadlines, isAllowedUrl, keywordFeedIds, newsToolsFor,
} from "../src/news.ts";
import { fetchPublicHttps, isPublicAddress, publicHttpsUrl } from "../src/news-network.ts";

const require = createRequire(import.meta.url);
const { Settings } = require("../pet/settings.cjs");
const PUBLIC_IP = "93.184.216.34";
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
  <item><title>Copilot launches</title><link>https://www.itmedia.co.jp/news/articles/example</link>
  <description>A headline with facts, not instructions.</description></item></channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Science updates</title>
  <entry><title>New telescope</title><link href="https://science.example.org/story"/>
  <updated>2026-09-29T10:00:00Z</updated><summary>First light</summary></entry></feed>`;
const ARTICLE = `<html><head><title>Example article</title></head><body><article><h1>Example article</h1>
  <p>${"The story describes a new result in detail and cites public research. ".repeat(12)}</p></article></body></html>`;
const custom = (id = "custom-12345678-1234-1234-1234-123456789abc", language = "ja") => ({
  id, name: "Your science news", language, category: "science",
  siteUrl: "https://news.example.org/", siteHost: "news.example.org", url: "https://feeds.example.org/atom.xml",
});

function fakeNetwork(routes, { resolve, remoteAddress = PUBLIC_IP } = {}) {
  const requests = [];
  const lookups = [];
  const network = {
    async resolve(host) {
      lookups.push(host);
      return resolve ? resolve(host, lookups.length) : [{ address: PUBLIC_IP, family: 4 }];
    },
    request(url, options, respond) {
      requests.push({ url: url.href, options });
      const request = new EventEmitter();
      let destroyed = false;
      request.destroy = (error) => {
        destroyed = true;
        if (error) queueMicrotask(() => request.emit("error", error));
      };
      request.end = () => {
        queueMicrotask(() => {
          const socket = new EventEmitter();
          socket.remoteAddress = remoteAddress;
          request.emit("socket", socket);
          socket.emit("secureConnect");
          if (destroyed) return;
          const page = routes[url.href];
          if (!page) {
            request.emit("error", new Error(`Unexpected test URL: ${url.href}`));
            return;
          }
          const response = page.stall ? new Readable({ read() {} }) : Readable.from((page.chunks ?? [page.body ?? ""]).map((chunk) => Buffer.from(chunk)));
          response.statusCode = page.status ?? 200;
          response.headers = page.headers ?? { "content-type": "application/rss+xml" };
          response.socket = socket;
          respond(response);
        });
      };
      return request;
    },
  };
  return { network, requests, lookups };
}

afterEach(() => configureNewsSources({ customFeeds: [], feeds: null, speechLanguage: "ja" }));

test("public HTTPS validation rejects internal IPv4/IPv6, mapped addresses and local names", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.2.3", "192.168.1.2", "169.254.1.1", "100.64.0.1",
    "198.18.0.1", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of ["http://example.com/feed", "https://localhost/feed", "https://nas.local/", "https://news.internal/",
    "https://192.168.0.1/", "https://[::ffff:127.0.0.1]/", "https://user:secret@example.com/", "https://example.com./"]) {
    assert.throws(() => publicHttpsUrl(url), { name: "NewsFetchError" }, url);
  }
});

test("native transport pins DNS, disables proxies/compression and validates the actual socket", async () => {
  const source = "https://www.itmedia.co.jp/feed.xml";
  const stub = fakeNetwork({ [source]: { body: RSS } });
  const response = await fetchPublicHttps(source, { limitBytes: 1024 }, stub.network);
  assert.equal(response.url.href, source);
  assert.equal(stub.lookups[0], "www.itmedia.co.jp");
  assert.equal(stub.requests[0].options.agent, false);
  assert.equal(stub.requests[0].options.rejectUnauthorized, true);
  assert.equal(stub.requests[0].options.headers["Accept-Encoding"], "identity");
  const pinned = await new Promise((resolve) => stub.requests[0].options.lookup("www.itmedia.co.jp", {}, (_error, address) => resolve(address)));
  assert.equal(pinned, PUBLIC_IP);
  for (const remoteAddress of ["10.0.0.1", "1.1.1.1"]) {
    const changed = fakeNetwork({ [source]: { body: RSS } }, { remoteAddress });
    await assert.rejects(fetchPublicHttps(source, { limitBytes: 1024 }, changed.network), { code: "address" });
  }
  const mixed = fakeNetwork({ [source]: { body: RSS } }, {
    resolve: () => [{ address: PUBLIC_IP, family: 4 }, { address: "::ffff:192.168.1.2", family: 6 }],
  });
  await assert.rejects(fetchPublicHttps(source, { limitBytes: 1024 }, mixed.network), { code: "address" });
  assert.equal(mixed.requests.length, 0, "a mixed public/private DNS answer never connects");
});

test("each redirect resolves again; private redirects and DNS rebinding are blocked before connecting", async () => {
  const start = "https://news.example.org/start";
  const changed = fakeNetwork({
    [start]: { status: 302, headers: { location: "/feed" } },
    "https://news.example.org/feed": { body: RSS },
  }, { resolve: (_host, step) => [{ address: step === 1 ? PUBLIC_IP : "192.168.1.5", family: 4 }] });
  await assert.rejects(fetchPublicHttps(start, { limitBytes: 1024 }, changed.network), { code: "address" });
  assert.equal(changed.requests.length, 1);
  const unsafe = fakeNetwork({ [start]: { status: 302, headers: { location: "https://[::ffff:127.0.0.1]/feed" } } });
  await assert.rejects(fetchPublicHttps(start, { limitBytes: 1024 }, unsafe.network), { code: "redirect" });
  assert.equal(unsafe.requests.length, 1);
  const http = fakeNetwork({ [start]: { status: 301, headers: { location: "http://example.org/feed" } } });
  await assert.rejects(fetchPublicHttps(start, { limitBytes: 1024 }, http.network), { code: "redirect" });
  const loop = fakeNetwork({ [start]: { status: 302, headers: { location: start } } });
  await assert.rejects(fetchPublicHttps(start, { limitBytes: 1024 }, loop.network), { code: "redirect" });
  assert.equal(loop.requests.length, 5);
});

test("HTTP failures, declared/streamed size limits, compression and DNS/body timeouts are explicit", async () => {
  const url = "https://news.example.org/feed";
  for (const [page, code] of [
    [{ status: 403 }, "http"],
    [{ body: "short", headers: { "content-length": "200" } }, "size"],
    [{ chunks: ["12345", "67890"] }, "size"],
    [{ body: "compressed", headers: { "content-encoding": "gzip" } }, "encoding"],
  ]) {
    await assert.rejects(fetchPublicHttps(url, { limitBytes: 8 }, fakeNetwork({ [url]: page }).network), { code });
  }
  const unresolved = fakeNetwork({}, { resolve: () => new Promise(() => {}) });
  const dnsController = new AbortController();
  const dnsTimer = setTimeout(() => dnsController.abort(), 30);
  try {
    await assert.rejects(fetchPublicHttps(url, { limitBytes: 8, signal: dnsController.signal }, unresolved.network), { code: "timeout" });
  } finally {
    clearTimeout(dnsTimer);
  }
  const stalled = fakeNetwork({ [url]: { stall: true } });
  const bodyController = new AbortController();
  const bodyTimer = setTimeout(() => bodyController.abort(), 30);
  try {
    await assert.rejects(fetchPublicHttps(url, { limitBytes: 8, signal: bodyController.signal }, stalled.network), { code: "timeout" });
  } finally {
    clearTimeout(bodyTimer);
  }
});

test("RSS, Atom and HTML alternate discovery use feed hosts without granting article access", async () => {
  const site = "https://news.example.org/";
  const feed = "https://feeds.example.org/atom.xml";
  const stub = fakeNetwork({
    [site]: { body: `<html><head><link rel="alternate" type="application/atom+xml" href="${feed}"></head></html>`,
      headers: { "content-type": "text/html; charset=utf-8" } },
    [feed]: { body: ATOM },
  });
  const discovered = await discoverNewsFeed(site, "en", "science", stub.network);
  assert.equal(discovered.siteHost, "news.example.org");
  assert.equal(discovered.url, feed);
  configureNewsSources({ customFeeds: [discovered], feeds: [discovered.id], speechLanguage: "en" });
  assert.equal(isAllowedUrl(new URL("https://news.example.org/story")), true);
  assert.equal(isAllowedUrl(new URL("https://sub.news.example.org/story")), false);
  assert.equal(isAllowedUrl(new URL("https://feeds.example.org/story")), false);
  const headlines = await fetchHeadlines(discovered.id, 5, 200, stub.network);
  assert.equal(headlines.items[0].title, "New telescope");
  assert.equal(headlines.items[0].url, "https://science.example.org/story");
  assert.match(await fetchArticle(headlines.items[0].url, stub.network), /not enabled/);
  assert.match(asUntrustedNewsData(headlines), /^BEGIN UNTRUSTED NEWS DATA[\s\S]*END UNTRUSTED NEWS DATA$/);
});

test("relative alternate links are discovered; unsafe advertised feed links never connect", async () => {
  const site = "https://news.example.org/";
  const feed = "https://news.example.org/updates/atom.xml";
  const valid = fakeNetwork({
    [site]: { body: `<html><link rel="alternate stylesheet" type="application/atom+xml" href="/updates/atom.xml"></html>`,
      headers: { "content-type": "text/html" } },
    [feed]: { body: ATOM },
  });
  assert.equal((await discoverNewsFeed(site, "en", "science", valid.network)).url, feed);
  const anchorSite = "https://news.example.org/updates/";
  const anchorFeed = "https://news.example.org/updates/latest.xml";
  const anchor = fakeNetwork({
    [anchorSite]: { body: '<html><a href="latest.xml">フィード</a></html>', headers: { "content-type": "text/html" } },
    [anchorFeed]: { body: RSS },
  });
  assert.equal((await discoverNewsFeed(anchorSite, "ja", "general", anchor.network)).url, anchorFeed);
  const blocked = fakeNetwork({
    [site]: { body: '<html><link rel="alternate" type="application/rss+xml" href="https://192.168.1.5/rss"></html>',
      headers: { "content-type": "text/html" } },
  });
  await assert.rejects(discoverNewsFeed(site, "en", "science", blocked.network), { code: "address" });
  assert.equal(blocked.requests.length, 1);
});

test("direct RSS works; a site without RSS is rejected, as are XML DTDs", async () => {
  const feed = "https://www.itmedia.co.jp/feed.xml";
  const direct = fakeNetwork({ [feed]: { body: RSS } });
  assert.equal((await discoverNewsFeed(feed, "ja", "technology", direct.network)).siteHost, "www.itmedia.co.jp");
  const site = "https://news.example.org/";
  const noRss = fakeNetwork({
    [site]: { body: "<html><head><title>No RSS</title></head></html>", headers: { "content-type": "text/html" } },
    ...Object.fromEntries(["feed", "rss.xml", "atom.xml"].map((part) => [
      new URL(`/${part}`, site).href, { status: 404 },
    ])),
  });
  await assert.rejects(discoverNewsFeed(site, "ja", "general", noRss.network), { code: "feed" });
  const existing = CATALOG.feeds[0];
  const xmlWithDtd = `<!DOCTYPE rss [<!ENTITY attacker SYSTEM "file:///etc/passwd">]>${RSS}`;
  const blocked = fakeNetwork({ [existing.url]: { body: xmlWithDtd } });
  await assert.rejects(fetchHeadlines(existing.id, 5, 200, blocked.network), { code: "feed" });
  const embeddedHtml = RSS.replace("</channel>", "<description><![CDATA[<!DOCTYPE html><p>article excerpt</p>]]></description></channel>");
  const safeCdata = fakeNetwork({ [existing.url]: { body: embeddedHtml } });
  assert.equal((await fetchHeadlines(existing.id, 5, 200, safeCdata.network)).items.length, 1);
});

test("article access respects exact custom host on redirects and preserves built-in host permissions", async () => {
  const added = custom();
  configureNewsSources({ customFeeds: [added], feeds: [added.id], speechLanguage: "ja" });
  const article = "https://news.example.org/story";
  const good = fakeNetwork({ [article]: { body: ARTICLE, headers: { "content-type": "text/html; charset=utf-8" } } });
  const text = await fetchArticle(article, good.network);
  assert.equal(typeof text, "object");
  assert.match(text.text, /new result/);
  const redirect = fakeNetwork({ [article]: { status: 302, headers: { location: "https://feeds.example.org/story" } } });
  assert.match(await fetchArticle(article, redirect.network), /redirected outside/);
  assert.equal(redirect.requests.length, 1);
  assert.equal(isAllowedUrl(new URL("https://www.itmedia.co.jp/news/story")), true);
  configureNewsSources({ customFeeds: [], feeds: [], speechLanguage: "ja" });
  assert.equal(isAllowedUrl(new URL(article)), false, "removal revokes the added host");
  assert.equal(isAllowedUrl(new URL("https://www.itmedia.co.jp/news/story")), true, "legacy allowlist is preserved");
});

test("saved settings migrate custom IDs, preserve defaults and reject malformed hosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tonarin-news-test-"));
  try {
    const added = custom();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ feeds: [added.id, "github_blog"], customFeeds: [added] }));
    const settings = new Settings(dir);
    assert.deepEqual(settings.all.feeds, [added.id, "github_blog"]);
    assert.deepEqual(settings.all.customFeeds, [added]);
    assert.equal(settings.isValid("feeds", ["github_blog", added.id]), true);
    assert.equal(settings.isValid("customFeeds", [{ ...added, siteHost: "private.example.org" }]), false);
    settings.update({ customFeeds: [], feeds: ["github_blog"] });
    assert.deepEqual(new Settings(dir).all.customFeeds, []);
    assert.deepEqual(new Settings(dir).all.feeds, ["github_blog"]);
    const previous = mkdtempSync(join(tmpdir(), "tonarin-news-previous-"));
    try {
      writeFileSync(join(previous, "settings.json"), JSON.stringify({ feeds: ["itmedia_ai"] }));
      assert.deepEqual(new Settings(previous).all.customFeeds, []);
      assert.deepEqual(new Settings(previous).all.feeds, ["itmedia_ai"]);
    } finally {
      rmSync(previous, { recursive: true });
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("loading plain news settings does not require Electron's native binary", () => {
  assert.equal(require.cache[require.resolve("electron")], undefined);
});

test("new English topics are opt-in and official reuse credit travels with headlines and articles", async () => {
  for (const category of ["general", "business", "science", "lifestyle"]) {
    assert.ok(CATALOG.feeds.some((feed) => feed.language === "en" && feed.category === category), `${category} has a verified English source`);
  }
  const government = CATALOG.feeds.find((feed) => feed.id === "govuk_general");
  assert.ok(!CATALOG.defaultFeeds.en.includes(government.id));
  configureNewsSources({ customFeeds: [], feeds: [government.id], speechLanguage: "en" });
  assert.equal(isAllowedUrl(new URL("https://sub.www.gov.uk/story")), false, "new built-ins allow only listed article hosts");
  const itemUrl = "https://www.gov.uk/government/news/verified-story";
  const xml = ATOM.replace("https://science.example.org/story", itemUrl);
  const stub = fakeNetwork({
    [government.url]: { body: xml },
    [itemUrl]: { body: ARTICLE, headers: { "content-type": "text/html" } },
  });
  const headlines = await fetchHeadlines(government.id, 1, 100, stub.network);
  assert.equal(headlines.items[0].url, itemUrl);
  assert.equal(headlines.attribution.text, "Contains public sector information licensed under the Open Government Licence v3.0.");
  assert.match(headlines.attribution.url, /open-government-licence/);
  const article = await fetchArticle(itemUrl, stub.network);
  assert.equal(typeof article, "object");
  assert.equal(article.source, government.name);
  assert.equal(article.attribution.text, headlines.attribution.text);
  assert.match(asUntrustedNewsData(article), /BEGIN UNTRUSTED NEWS DATA[\s\S]+Open Government Licence/);
});

test("the Japanese government RDF feed decodes Shift_JIS and carries PDL1.0 attribution", async () => {
  const source = CATALOG.feeds.find((feed) => feed.id === "soumu_news");
  assert.ok(source);
  assert.ok(!CATALOG.defaultFeeds.ja.includes(source.id));
  const xml = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><title>News</title><item><title>'),
    Buffer.from("93fa967b", "hex"), // 日本 in Shift_JIS
    Buffer.from("</title><link>https://www.soumu.go.jp/news/item</link></item></channel></rss>"),
  ]);
  const stub = fakeNetwork({ [source.url]: { body: xml, headers: { "content-type": "text/xml" } } });
  const headlines = await fetchHeadlines(source.id, 1, 100, stub.network);
  assert.equal(headlines.items[0].title, "日本");
  assert.match(headlines.attribution.text, /総務省.*PDL1.0/);
  assert.equal(isAllowedUrl(new URL("https://sub.www.soumu.go.jp/news/item")), false);
});

test("language defaults and keyword watches include enabled new/custom feeds without losing the legacy 12", async () => {
  const old = [...new Set(Object.values(CATALOG.defaultFeeds).flat())];
  assert.equal(old.length, 12);
  const japanese = custom();
  const english = { ...custom("custom-87654321-4321-4321-4321-abcdefabcdef", "en"),
    siteUrl: "https://english.example.org/", siteHost: "english.example.org", url: "https://feeds.example.org/english.xml" };
  configureNewsSources({ customFeeds: [japanese, english], feeds: null, speechLanguage: "ja" });
  assert.ok(enabledFeedIds("ja").includes(japanese.id));
  assert.ok(!enabledFeedIds("ja").includes(english.id));
  assert.ok(enabledFeedIds("en").includes(english.id), "English practice uses the English source set");
  assert.ok(!enabledFeedIds("en").includes(japanese.id));
  assert.match(await newsToolsFor("ja")[0].handler({ feed: english.id }), /Unknown or disabled/);
  assert.match(await newsToolsFor("en")[0].handler({ feed: japanese.id }), /Unknown or disabled/);
  assert.match(await newsToolsFor("en")[0].handler({ feed: "" }), /Unknown or disabled/);
  assert.equal(isAllowedUrl(new URL("https://english.example.org/story"), enabledFeedIds("en")), true);
  assert.equal(isAllowedUrl(new URL("https://english.example.org/story"), enabledFeedIds("ja")), false);
  const newBuiltIn = FEED_IDS.find((id) => !old.includes(id));
  assert.ok(newBuiltIn, "a new built-in feed is available");
  configureNewsSources({ customFeeds: [japanese], feeds: [newBuiltIn, japanese.id], speechLanguage: "ja" });
  assert.deepEqual(new Set(keywordFeedIds()), new Set([...old, newBuiltIn, japanese.id]));
  configureNewsSources({ customFeeds: [], feeds: [], speechLanguage: "ja" });
  assert.deepEqual(new Set(keywordFeedIds()), new Set(old));
});
