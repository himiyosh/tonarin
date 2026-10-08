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
import { connect } from "node:net";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL_PATH = process.env.WHISPER_MODEL ?? join(PROJECT_ROOT, "models", "ggml-large-v3-turbo-q5_0.bin");
const PORT = Number(process.env.WHISPER_PORT ?? 8788);
const LANGUAGE = process.env.WHISPER_LANGUAGE ?? "ja";
const THREADS = process.env.WHISPER_THREADS ?? "4";
const LOG_PATH = process.env.WHISPER_LOG ?? join(PROJECT_ROOT, "logs", "whisper.log");
// Initial prompt that biases recognition toward the vocabulary of tech-news conversations.
const PROMPT = process.env.WHISPER_PROMPT ?? "AI、GitHub Copilot、OpenAI、Google、Microsoft などのテック系ニュースについての会話です。";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // same limit as the OpenAI API

let child: ChildProcess | undefined;

function findBinary(name: string): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
  const names = process.platform === "win32" && !extname(name) ? [name, `${name}.exe`] : [name];
  return dirs.flatMap((dir) => names.map((candidate) => join(dir, candidate))).find((candidate) => existsSync(candidate));
}

/** Starts whisper-server if the binary and model are present. Returns a status line for the startup log. */
export function startWhisper(): string {
  // The desktop pet talks through Gemini Live and does not need local speech recognition (it would load a large model).
  if (process.env.WHISPER === "off") return "off (not needed by the desktop pet)";
  const binary = findBinary("whisper-server");
  if (!binary) return "unavailable (install with `brew install whisper-cpp`)";
  if (!existsSync(MODEL_PATH)) return `unavailable (model not found: ${MODEL_PATH})`;

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const log = openSync(LOG_PATH, "a");
  child = spawn(
    binary,
    ["-m", MODEL_PATH, "--host", "127.0.0.1", "--port", String(PORT), "-l", LANGUAGE, "-t", THREADS, "-nt", "--prompt", PROMPT],
    { stdio: ["ignore", log, log] },
  );
  child.on("exit", (code, signal) => {
    if (child) console.error(`[whisper] exited (code=${code}, signal=${signal}); see ${LOG_PATH}`);
    child = undefined;
  });
  child.on("error", (error) => {
    console.error(`[whisper] could not start: ${error.message}; see ${LOG_PATH}`);
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

export async function waitForWhisperReady(timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (child && Date.now() < until) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect(PORT, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function pcm16Wav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Transcribes one complete 16 kHz mono PCM utterance with the local whisper.cpp server. */
export async function transcribePcm(pcm: Buffer, language: string, signal?: AbortSignal): Promise<string> {
  if (!child) throw new Error("Local speech recognition is not running");
  if (!pcm.length) return "";
  if (pcm.length > MAX_UPLOAD_BYTES) throw new Error("Audio upload too large");

  const form = new FormData();
  const wav = Uint8Array.from(pcm16Wav(pcm));
  form.set("file", new Blob([wav.buffer], { type: "audio/wav" }), "utterance.wav");
  form.set("language", language === "en" ? "en" : "ja");
  form.set("response_format", "json");
  const upstream = await fetch(`http://127.0.0.1:${PORT}/inference`, {
    method: "POST",
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const raw = await upstream.text();
  if (!upstream.ok) throw new Error(`Local speech recognition failed (HTTP ${upstream.status})`);
  try {
    const payload = JSON.parse(raw) as { text?: unknown };
    return typeof payload.text === "string" ? payload.text.trim() : "";
  } catch {
    return raw.trim();
  }
}

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
