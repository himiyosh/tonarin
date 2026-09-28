/**
 * Automations: tasks the pet runs on a schedule ("every weekday at 8:30, brief me", "every Monday, ask Copilot to
 * sum up the GitHub Blog", "every hour from 10 to 18, nudge me to take a break", "tell me when an article mentions
 * Copilot"). This file holds the data: validation, the next run time, keyword-watch state and the run history.
 * Running them (the pet, Copilot, the feeds) is in server.ts.
 *
 * Saved in AUTOMATIONS_FILE (the app passes a path in its settings folder). The prompts and results are the user's
 * own content: they stay in that file and are never logged.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Trigger =
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; everyMinutes: number; from: string; to: string; days: number[] }
  | { type: "keyword"; keywords: string[]; everyMinutes: number };

/** pet: the pet does it live (with its tools) and speaks. copilot: Copilot works on it first, then the pet reports. */
export type Engine = "pet" | "copilot";

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  /** What to do, in the user's words. */
  prompt: string;
  engine: Engine;
  language: "ja" | "en";
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

export type RunStatus = "running" | "waiting" | "spoken" | "missed" | "error";

export interface HistoryEntry {
  id: string;
  automationId: string;
  name: string;
  at: number;
  status: RunStatus;
  /** What the pet said, or Copilot's result, or the articles found. */
  text: string;
}

export const LIMITS = {
  automations: 30,
  name: 60,
  prompt: 1000,
  keywords: 10,
  keyword: 40,
  minEvery: 15,
  maxEvery: 720,
  history: 100,
  historyText: 4000,
  seen: 300,
};
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const CATCH_UP_MS = 2 * 60 * 60_000; // a daily run missed by less than 2 hours (the Mac was asleep) still runs

export class ValidationError extends Error {}

const minutesOf = (hhmm: string): number => {
  const [, h, m] = HHMM.exec(hhmm)!;
  return Number(h) * 60 + Number(m);
};
const normTime = (value: unknown, field: string): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!HHMM.test(text)) throw new ValidationError(`${field} must be a time like 08:30.`);
  const minutes = minutesOf(text);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
const normDays = (value: unknown): number[] => {
  const days = [...new Set((Array.isArray(value) ? value : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!days.length) throw new ValidationError("Pick at least one day.");
  return days.sort();
};
const normEvery = (value: unknown): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < LIMITS.minEvery || n > LIMITS.maxEvery) {
    throw new ValidationError(`The interval must be ${LIMITS.minEvery}-${LIMITS.maxEvery} minutes.`);
  }
  return n;
};

/** Turns untrusted input (settings window, voice tool) into a valid automation. Throws ValidationError. */
export function validateAutomation(input: unknown, existing?: Automation): Automation {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ").slice(0, LIMITS.name) : "";
  if (!name) throw new ValidationError("Give the automation a name.");
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, LIMITS.prompt) : "";
  const triggerIn = (raw.trigger && typeof raw.trigger === "object" ? raw.trigger : {}) as Record<string, unknown>;
  let trigger: Trigger;
  switch (triggerIn.type) {
    case "daily":
      trigger = { type: "daily", time: normTime(triggerIn.time, "time"), days: normDays(triggerIn.days) };
      break;
    case "interval": {
      const from = normTime(triggerIn.from, "from");
      const to = normTime(triggerIn.to, "to");
      if (minutesOf(to) <= minutesOf(from)) throw new ValidationError("The end time must be after the start time.");
      trigger = { type: "interval", everyMinutes: normEvery(triggerIn.everyMinutes), from, to, days: normDays(triggerIn.days) };
      break;
    }
    case "keyword": {
      const list = Array.isArray(triggerIn.keywords) ? triggerIn.keywords : String(triggerIn.keywords ?? "").split(/[,、，\n]/);
      const keywords = [...new Set(list.map((k) => String(k).trim().slice(0, LIMITS.keyword)).filter(Boolean))].slice(0, LIMITS.keywords);
      if (!keywords.length) throw new ValidationError("Add at least one keyword.");
      trigger = { type: "keyword", keywords, everyMinutes: normEvery(triggerIn.everyMinutes ?? 30) };
      break;
    }
    default:
      throw new ValidationError("Choose when it runs (daily, interval or keyword).");
  }
  if (!prompt && trigger.type !== "keyword") throw new ValidationError("Describe what the pet should do.");
  const now = Date.now();
  const automation: Automation = {
    id: existing?.id ?? randomUUID().slice(0, 8),
    name,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : (existing?.enabled ?? true),
    trigger,
    prompt,
    engine: raw.engine === "copilot" ? "copilot" : "pet",
    language: raw.language === "en" ? "en" : raw.language === "ja" ? "ja" : (existing?.language ?? "ja"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
  };
  automation.nextRunAt = nextRun(automation, now);
  return automation;
}

/** The next time an automation should run after `after` (undefined when disabled). */
export function nextRun(automation: Automation, after = Date.now()): number | undefined {
  if (!automation.enabled) return undefined;
  const trigger = automation.trigger;
  if (trigger.type === "keyword") {
    // Check soon after it is created, then every N minutes.
    return automation.lastRunAt ? Math.max(automation.lastRunAt + trigger.everyMinutes * 60_000, after) : after + 60_000;
  }
  const start = new Date(after);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (!trigger.days.includes(day.getDay())) continue;
    const slots =
      trigger.type === "daily"
        ? [minutesOf(trigger.time)]
        : Array.from(
            { length: Math.floor((minutesOf(trigger.to) - minutesOf(trigger.from)) / trigger.everyMinutes) + 1 },
            (_, i) => minutesOf(trigger.from) + i * trigger.everyMinutes,
          );
    for (const minute of slots) {
      const time = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60).getTime();
      if (time > after) return time;
    }
  }
  return undefined;
}

/** The latest scheduled daily time at or before `now` (for catching up after the Mac slept through it). */
function previousDaily(trigger: Extract<Trigger, { type: "daily" }>, now: number): number | undefined {
  const today = new Date(now);
  for (let offset = 0; offset <= 1; offset++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    if (!trigger.days.includes(day.getDay())) continue;
    const minute = minutesOf(trigger.time);
    const time = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60).getTime();
    if (time <= now) return time;
  }
  return undefined;
}

interface StoreFile {
  automations?: Automation[];
  history?: HistoryEntry[];
  seen?: Record<string, string[]>;
}

export class AutomationStore extends EventEmitter<{ change: [] }> {
  private automations: Automation[] = [];
  private history: HistoryEntry[] = [];
  /** Keyword watches: article URLs already reported (the first check only records what is there). */
  private seen: Record<string, string[]> = {};

  constructor(private readonly file?: string) {
    super();
    this.load();
  }

  list(): Automation[] {
    return this.automations.map((a) => ({ ...a }));
  }

  get(id: string): Automation | undefined {
    const found = this.automations.find((a) => a.id === id);
    return found && { ...found };
  }

  /** Creates or updates (when input.id matches an existing automation). */
  save(input: unknown): Automation {
    const id = input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id : "";
    const existing = this.automations.find((a) => a.id === id);
    if (!existing && this.automations.length >= LIMITS.automations) {
      throw new ValidationError(`There are already ${LIMITS.automations} automations.`);
    }
    const automation = validateAutomation(input, existing);
    // A changed keyword list starts watching afresh.
    if (existing && JSON.stringify(existing.trigger) !== JSON.stringify(automation.trigger)) delete this.seen[automation.id];
    this.automations = existing ? this.automations.map((a) => (a.id === existing.id ? automation : a)) : [...this.automations, automation];
    this.persist();
    return { ...automation };
  }

  remove(id: string): boolean {
    const before = this.automations.length;
    this.automations = this.automations.filter((a) => a.id !== id);
    delete this.seen[id];
    if (this.automations.length === before) return false;
    this.persist();
    return true;
  }

  setEnabled(id: string, enabled: boolean): Automation | undefined {
    const automation = this.automations.find((a) => a.id === id);
    if (!automation) return undefined;
    automation.enabled = enabled;
    automation.updatedAt = Date.now();
    automation.nextRunAt = nextRun(automation);
    this.persist();
    return { ...automation };
  }

  /** Automations whose time has come. */
  due(now = Date.now()): Automation[] {
    return this.automations.filter((a) => a.enabled && a.nextRunAt !== undefined && a.nextRunAt <= now).map((a) => ({ ...a }));
  }

  markRun(id: string, at = Date.now()): void {
    const automation = this.automations.find((a) => a.id === id);
    if (!automation) return;
    automation.lastRunAt = at;
    automation.nextRunAt = nextRun(automation, at);
    this.persist();
  }

  // --- history ------------------------------------------------------------
  listHistory(): HistoryEntry[] {
    return [...this.history].sort((a, b) => b.at - a.at);
  }

  addHistory(automation: Automation, status: RunStatus, text = ""): HistoryEntry {
    const entry: HistoryEntry = {
      id: randomUUID().slice(0, 8),
      automationId: automation.id,
      name: automation.name,
      at: Date.now(),
      status,
      text: text.slice(0, LIMITS.historyText),
    };
    this.history = [...this.history, entry].slice(-LIMITS.history);
    this.persist();
    return { ...entry };
  }

  updateHistory(id: string, patch: { status?: RunStatus; text?: string }): void {
    const entry = this.history.find((h) => h.id === id);
    if (!entry) return;
    if (patch.status) entry.status = patch.status;
    if (patch.text !== undefined) entry.text = patch.text.slice(0, LIMITS.historyText);
    this.persist();
  }

  clearHistory(): void {
    this.history = [];
    this.persist();
  }

  // --- keyword watch state --------------------------------------------------
  seenFor(id: string): Set<string> | undefined {
    return this.seen[id] ? new Set(this.seen[id]) : undefined;
  }

  setSeen(id: string, urls: Iterable<string>): void {
    this.seen[id] = [...urls].slice(-LIMITS.seen);
    this.persist(false);
  }

  // --- persistence ------------------------------------------------------------
  private load(): void {
    if (!this.file) return;
    let data: StoreFile;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    } catch {
      return; // no file yet
    }
    const now = Date.now();
    for (const saved of Array.isArray(data.automations) ? data.automations.slice(0, LIMITS.automations) : []) {
      try {
        const automation = validateAutomation(saved, saved);
        automation.updatedAt = saved.updatedAt ?? automation.updatedAt;
        // Daily runs the Mac slept through (less than 2 hours ago) run now; everything else waits for its next time.
        if (automation.enabled && automation.trigger.type === "daily") {
          const previous = previousDaily(automation.trigger, now);
          if (previous && now - previous < CATCH_UP_MS && (automation.lastRunAt ?? automation.createdAt) < previous) {
            automation.nextRunAt = now;
          }
        }
        this.automations.push(automation);
      } catch {
        // skip entries that are no longer valid
      }
    }
    this.history = (Array.isArray(data.history) ? data.history : [])
      .filter((h) => typeof h?.id === "string" && typeof h?.at === "number" && typeof h?.text === "string")
      .map((h) => (h.status === "running" || h.status === "waiting" ? { ...h, status: "missed" as const } : h))
      .slice(-LIMITS.history);
    const ids = new Set(this.automations.map((a) => a.id));
    for (const [id, urls] of Object.entries(data.seen ?? {})) if (ids.has(id) && Array.isArray(urls)) this.seen[id] = urls.slice(-LIMITS.seen);
  }

  private persist(notify = true): void {
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        writeFileSync(temp, JSON.stringify({ automations: this.automations, history: this.history, seen: this.seen }), { mode: 0o600 });
        renameSync(temp, this.file);
      } catch (error) {
        console.error(`[automations] could not save: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (notify) this.emit("change");
  }
}

/** "weekdays", "everyday", "weekends", "mon,wed", "月水金" -> day numbers (0 = Sunday). */
export function parseDays(value: unknown): number[] {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/曜日?/g, "");
  if (!text || /^(every ?day|daily|all|毎日)$/.test(text)) return [0, 1, 2, 3, 4, 5, 6];
  if (/^(weekdays?|平日)$/.test(text)) return [1, 2, 3, 4, 5];
  if (/^(weekends?|週末|土日)$/.test(text)) return [0, 6];
  const names: Array<[RegExp, number]> = [
    [/sun|日/, 0],
    [/mon|月/, 1],
    [/tue|火/, 2],
    [/wed|水/, 3],
    [/thu|木/, 4],
    [/fri|金/, 5],
    [/sat|土/, 6],
  ];
  const days = text
    .split(/[\s,、，・]+|(?=[日月火水木金土])/)
    .filter(Boolean)
    .flatMap((part) => names.filter(([pattern]) => pattern.test(part)).map(([, day]) => day));
  return [...new Set(days)].sort();
}

/** A short description of when it runs, for the pet to say or the history. */
export function describeTrigger(trigger: Trigger, language: "ja" | "en"): string {
  const ja = language === "ja";
  const dayNames = ja ? ["日", "月", "火", "水", "木", "金", "土"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = (list: number[]) =>
    list.length === 7 ? (ja ? "毎日" : "every day") : list.join() === "1,2,3,4,5" ? (ja ? "平日" : "weekdays") : list.join() === "0,6" ? (ja ? "週末" : "weekends") : list.map((d) => dayNames[d]).join(ja ? "・" : ", ");
  switch (trigger.type) {
    case "daily":
      return ja ? `${days(trigger.days)} ${trigger.time}` : `${days(trigger.days)} at ${trigger.time}`;
    case "interval":
      return ja
        ? `${days(trigger.days)} ${trigger.from}〜${trigger.to} に ${trigger.everyMinutes} 分ごと`
        : `${days(trigger.days)}, every ${trigger.everyMinutes} min from ${trigger.from} to ${trigger.to}`;
    case "keyword":
      return ja
        ? `「${trigger.keywords.join("」「")}」の記事が出たら (${trigger.everyMinutes} 分ごとに確認)`
        : `when an article mentions ${trigger.keywords.map((k) => `"${k}"`).join(", ")} (checked every ${trigger.everyMinutes} min)`;
  }
}
