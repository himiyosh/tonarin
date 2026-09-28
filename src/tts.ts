/**
 * Free, local Japanese text-to-speech using the macOS built-in `say` command,
 * exposed in the OpenAI `/v1/audio/speech` shape so AIRI's "OpenAI Compatible" speech provider can use it.
 *
 * No network, no API cost. Voices come from System Settings > Accessibility > Spoken Content;
 * downloading an "Enhanced" or "Premium" Japanese voice there improves quality.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TTS_MODEL_ID = "macos-say";
const DEFAULT_VOICE = process.env.TTS_VOICE ?? "Kyoko";
const BASE_RATE_WPM = Number(process.env.TTS_RATE ?? 200); // `say -r` words per minute at speed 1.0
const MAX_INPUT_CHARS = 2000;
const SAMPLE_FORMAT = "LEI16@24000"; // 16-bit little-endian PCM, 24 kHz mono

export const ttsAvailable = process.platform === "darwin";

let cachedVoices: string[] | undefined;

/** Japanese voices installed on this Mac, e.g. ["Kyoko", "Eddy (Japanese (Japan))", ...]. */
export async function listJapaneseVoices(): Promise<string[]> {
  if (!ttsAvailable) return [];
  if (cachedVoices) return cachedVoices;
  const { stdout } = await execFileAsync("say", ["-v", "?"]);
  cachedVoices = stdout
    .split("\n")
    .map((line) => /^(.*?)\s+ja_JP\s+#/.exec(line)?.[1]?.trim())
    .filter((name): name is string => Boolean(name));
  return cachedVoices;
}

/** Removes things that should not be spoken: Markdown symbols, emoji, URLs and `say` embedded commands. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, " ") // `say` embedded commands such as [[slnc 500]]
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>|~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INPUT_CHARS);
}

async function resolveVoice(requested: string | undefined): Promise<string> {
  const voices = await listJapaneseVoices();
  if (requested) {
    const exact = voices.find((voice) => voice === requested);
    if (exact) return exact;
    const byName = voices.find((voice) => voice.split(" (")[0].toLowerCase() === requested.toLowerCase());
    if (byName) return byName;
  }
  // OpenAI voice names such as "alloy" land here.
  return voices.includes(DEFAULT_VOICE) ? DEFAULT_VOICE : (voices[0] ?? DEFAULT_VOICE);
}

/** Synthesizes speech and returns a WAV file. Text is passed on stdin, never on the command line. */
export async function synthesize(text: string, voice?: string, speed?: number): Promise<Buffer> {
  const input = cleanForSpeech(text);
  const outFile = join(tmpdir(), `copilot-proxy-tts-${randomUUID()}.wav`);
  const args = ["-v", await resolveVoice(voice), "-o", outFile, "--file-format=WAVE", `--data-format=${SAMPLE_FORMAT}`];
  if (speed && Number.isFinite(speed) && speed > 0 && speed !== 1) {
    args.push("-r", String(Math.round(BASE_RATE_WPM * Math.min(Math.max(speed, 0.5), 2))));
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited with ${code}: ${stderr.trim()}`))));
    child.stdin.end(input || " ");
  });

  try {
    return await readFile(outFile);
  } finally {
    await unlink(outFile).catch(() => {});
  }
}
