/**
 * Free, local Japanese speech recognition: the proxy starts whisper.cpp's `whisper-server`
 * as a child process and forwards OpenAI-style `/v1/audio/transcriptions` requests to it.
 *
 * Setup (macOS): `brew install whisper-cpp` and put a GGML model in ./models
 * (default: ggml-large-v3-turbo-q5_0.bin). Apple Silicon runs it on the GPU via Metal.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL_PATH = process.env.WHISPER_MODEL ?? join(PROJECT_ROOT, "models", "ggml-large-v3-turbo-q5_0.bin");
const PORT = Number(process.env.WHISPER_PORT ?? 8788);
const LANGUAGE = process.env.WHISPER_LANGUAGE ?? "ja";
const THREADS = process.env.WHISPER_THREADS ?? "4";
// Initial prompt that biases recognition toward the vocabulary of tech-news conversations.
const PROMPT = process.env.WHISPER_PROMPT ?? "AI、GitHub Copilot、OpenAI、Google、Microsoft などのテック系ニュースについての会話です。";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // same limit as the OpenAI API

let child: ChildProcess | undefined;

function findBinary(name: string): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
  return dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
}

/** Starts whisper-server if the binary and model are present. Returns a status line for the startup log. */
export function startWhisper(): string {
  // The desktop pet talks through Gemini Live and does not need local speech recognition (it would load a large model).
  if (process.env.WHISPER === "off") return "off (not needed by the desktop pet)";
  const binary = findBinary("whisper-server");
  if (!binary) return "unavailable (install with `brew install whisper-cpp`)";
  if (!existsSync(MODEL_PATH)) return `unavailable (model not found: ${MODEL_PATH})`;

  mkdirSync(join(PROJECT_ROOT, "logs"), { recursive: true });
  const log = openSync(join(PROJECT_ROOT, "logs", "whisper.log"), "a");
  child = spawn(
    binary,
    ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT), "-l", LANGUAGE, "-t", THREADS, "-nt", "--prompt", PROMPT],
    { stdio: ["ignore", log, log] },
  );
  child.on("exit", (code, signal) => {
    if (child) console.error(`[whisper] exited (code=${code}, signal=${signal}); see logs/whisper.log`);
    child = undefined;
  });
  return `POST /v1/audio/transcriptions (whisper.cpp on 127.0.0.1:${PORT}, language=${LANGUAGE})`;
}

export function stopWhisper(): void {
  const running = child;
  child = undefined;
  running?.kill("SIGTERM");
}

export const whisperRunning = (): boolean => child !== undefined;

/** Reads the part headers of a multipart upload (filename, content type). Never the audio itself. */
function describeUpload(body: Buffer): string {
  const head = body.subarray(0, 600).toString("latin1");
  const disposition = /filename="([^"]*)"/i.exec(head)?.[1] ?? "-";
  const type = /Content-Type:\s*([^\r\n]+)/i.exec(head.split("\r\n\r\n")[0] ?? "")?.[1] ?? "-";
  return `file=${disposition} type=${type} bytes=${body.length}`;
}

/**
 * Clients may send their own `language` field (AIRI sends "en"), which would make whisper decode
 * Japanese speech as English. Rewrite it to the configured language. Works on raw bytes (latin1 is 1:1),
 * so the audio part is untouched; multipart parts are delimited by boundaries, not lengths.
 */
export function forceLanguage(body: Buffer, language: string): Buffer {
  if (language === "auto") return body;
  const text = body.toString("latin1");
  const rewritten = text.replace(/(name="language"\r\n(?:[^\r\n]+\r\n)*\r\n)[^\r\n]*/i, `$1${language}`);
  return rewritten === text ? body : Buffer.from(rewritten, "latin1");
}

/** Forwards the multipart body to whisper-server's /inference endpoint, with the language pinned. */
export async function forwardTranscription(req: IncomingMessage, res: ServerResponse, debug: boolean): Promise<void> {
  if (!child) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Speech recognition is not running", type: "server_error" } }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) throw new Error("Audio upload too large");
    chunks.push(chunk as Buffer);
  }
  const body = forceLanguage(Buffer.concat(chunks), LANGUAGE);
  const started = performance.now();

  const upstream = await fetch(`http://127.0.0.1:${PORT}/inference`, {
    method: "POST",
    headers: { "Content-Type": req.headers["content-type"] ?? "application/octet-stream" },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = Buffer.from(await upstream.arrayBuffer());

  if (debug) {
    console.log(`[debug] stt ${describeUpload(body)} -> http=${upstream.status} ms=${Math.round(performance.now() - started)}`);
  }
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  res.end(payload);
}
