/**
 * How much the pet used Gemini Live, per local day, so the settings window can show what a paid plan would cost.
 *
 * Gemini reports token counts once per turn (usageMetadata with turnComplete). Measured on 2026-09-27: the prompt
 * count of each turn includes the whole conversation so far (the system instruction and tool declarations as text,
 * and every earlier turn's audio), which is how Google bills the Live API ("charges per turn for all tokens in the
 * session context window"). Streaming silence alone produced no usage report.
 *
 * Also counted: seconds of microphone audio sent to Gemini. Google says that with proactive audio (always on for
 * Gemini 3.8 Live) input is charged the entire time the Live API is listening, so the estimate shows that time too.
 *
 * Only numbers are kept (never content). USAGE_FILE (the app passes a path in its settings folder) keeps 31 days.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageMetadata } from "./live.js";

export interface DayUsage {
  /** Local date, YYYY-MM-DD. */
  date: string;
  turns: number;
  inputText: number;
  inputAudio: number;
  inputOther: number;
  outputAudio: number;
  outputText: number;
  thoughts: number;
  /** Transcription text Gemini wrote (billed at the text output rate), estimated from the transcript length. */
  transcription: number;
  /** Seconds of microphone audio streamed to Gemini. */
  listeningSeconds: number;
  /** Questions and automation runs sent to Copilot (they use the Copilot plan's AI Credits, not Gemini). */
  copilotRequests: number;
}

/** Paid-tier prices for gemini-3.8-live in USD per 1M tokens (ai.google.dev/gemini-api/docs/pricing, 2026-09-26). */
export const PAID_PRICES = {
  model: "gemini-3.8-live",
  checked: "2026-09-26",
  inputText: 0.75,
  inputAudio: 3.0,
  inputOther: 1.0, // image / video
  outputText: 4.5, // also thinking and transcription text
  outputAudio: 12.0,
  listeningPerMinute: 0.005, // "$3.00 or $0.005/min (audio)"
};

const KEEP_DAYS = 31;

export function estimateUsd(day: DayUsage): { turns: number; listening: number; total: number } {
  const p = PAID_PRICES;
  const turns =
    (day.inputText * p.inputText +
      day.inputAudio * p.inputAudio +
      day.inputOther * p.inputOther +
      (day.outputText + day.thoughts + day.transcription) * p.outputText +
      day.outputAudio * p.outputAudio) /
    1_000_000;
  const listening = (day.listeningSeconds / 60) * p.listeningPerMinute;
  return { turns, listening, total: turns + listening };
}

/** Rough token count for transcript text: about one token per CJK character, four ASCII characters per token. */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return other + Math.ceil(ascii / 4);
}

export class UsageStore {
  private days: DayUsage[] = [];
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly file?: string) {
    this.load();
  }

  addTurn(usage: UsageMetadata): void {
    const day = this.today();
    const byModality = (list: UsageMetadata["promptTokensDetails"]) => {
      const counts = { TEXT: 0, AUDIO: 0, OTHER: 0 };
      for (const item of Array.isArray(list) ? list : []) {
        const count = Number(item?.tokenCount) || 0;
        if (item?.modality === "TEXT") counts.TEXT += count;
        else if (item?.modality === "AUDIO") counts.AUDIO += count;
        else counts.OTHER += count;
      }
      return counts;
    };
    const prompt = byModality(usage.promptTokensDetails);
    const response = byModality(usage.responseTokensDetails);
    const promptTotal = Number(usage.promptTokenCount) || 0;
    const responseTotal = Number(usage.responseTokenCount) || 0;
    // Part of the prompt count is not broken down by modality: count it as text (the cheapest input rate).
    const unlistedPrompt = Math.max(0, promptTotal - prompt.TEXT - prompt.AUDIO - prompt.OTHER);
    const unlistedResponse = Math.max(0, responseTotal - response.TEXT - response.AUDIO - response.OTHER);
    day.turns += 1;
    day.inputText += prompt.TEXT + unlistedPrompt;
    day.inputAudio += prompt.AUDIO;
    day.inputOther += prompt.OTHER;
    day.outputAudio += response.AUDIO;
    day.outputText += response.TEXT + response.OTHER + unlistedResponse;
    day.thoughts += Number(usage.thoughtsTokenCount) || 0;
    this.saveSoon();
  }

  addTranscription(text: string): void {
    this.today().transcription += estimateTextTokens(text);
    this.saveSoon();
  }

  addCopilot(): void {
    this.today().copilotRequests += 1;
    this.saveSoon();
  }

  addListening(seconds: number): void {
    if (!(seconds > 0)) return;
    this.today().listeningSeconds += seconds;
    this.saveSoon();
  }

  /** Newest first. */
  list(): DayUsage[] {
    return [...this.days].sort((a, b) => b.date.localeCompare(a.date)).map((day) => ({ ...day, listeningSeconds: Math.round(day.listeningSeconds) }));
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.save();
  }

  private today(): DayUsage {
    const date = localDate(new Date());
    let day = this.days.find((d) => d.date === date);
    if (!day) {
      day = emptyDay(date);
      this.days.push(day);
      this.days = this.days.sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
    }
    return day;
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 5000);
    this.saveTimer.unref?.();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { days?: unknown };
      const days = Array.isArray(data.days) ? data.days : [];
      this.days = days
        .filter((d): d is DayUsage => typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map((d) => ({ ...emptyDay(d.date), ...pickNumbers(d) }))
        .slice(0, KEEP_DAYS);
    } catch {
      // no file yet, or unreadable: start empty
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({ days: this.days }), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      console.error(`[usage] could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function emptyDay(date: string): DayUsage {
  return {
    date,
    turns: 0,
    inputText: 0,
    inputAudio: 0,
    inputOther: 0,
    outputAudio: 0,
    outputText: 0,
    thoughts: 0,
    transcription: 0,
    listeningSeconds: 0,
    copilotRequests: 0,
  };
}

function pickNumbers(value: DayUsage): Partial<DayUsage> {
  const out: Partial<Record<keyof DayUsage, number>> = {};
  for (const key of Object.keys(emptyDay("")) as (keyof DayUsage)[]) {
    if (key !== "date" && Number.isFinite(value[key]) && Number(value[key]) >= 0) out[key] = Number(value[key]);
  }
  return out as Partial<DayUsage>;
}

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
