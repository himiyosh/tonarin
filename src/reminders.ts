/**
 * Timers and reminders for the desktop pet ("tell me in 25 minutes", "remind me about the meeting at 3").
 *
 * The proxy owns them because the tools that create them run here. A due reminder is announced in every live
 * session; when none is connected (the pet is asleep), it waits in `due` until a session is ready, and the app
 * is told through /v1/events so it can wake the pet. Pending reminders are saved to REMINDERS_FILE (the app
 * passes a path in its settings folder) so they survive a restart. Labels are the user's own words: they are
 * stored locally and never logged.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Reminder {
  id: string;
  label: string;
  /** Epoch milliseconds. */
  dueAt: number;
}

const MAX_PENDING = 50;
const MAX_LABEL = 200;
const MAX_AHEAD_MS = 7 * 24 * 60 * 60_000; // a week
const STALE_AFTER_MS = 12 * 60 * 60_000; // due more than 12 hours ago while the app was closed: drop it
const MAX_TIMER_MS = 60 * 60_000; // re-check at least hourly (setTimeout drifts, and the Mac sleeps)

export class ReminderStore extends EventEmitter<{ due: [Reminder]; change: [] }> {
  private pending: Reminder[] = [];
  /** Reminders whose time has come but that no session has announced yet. */
  private due: Reminder[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file?: string) {
    super();
    this.load();
    this.schedule();
  }

  list(): Reminder[] {
    return [...this.pending].sort((a, b) => a.dueAt - b.dueAt);
  }

  add(label: string, dueAt: number): Reminder {
    const text = label.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL);
    if (!text) throw new Error("A reminder needs a label.");
    if (!Number.isFinite(dueAt) || dueAt < Date.now() - 1000) throw new Error("That time has already passed.");
    if (dueAt > Date.now() + MAX_AHEAD_MS) throw new Error("Reminders can be set up to 7 days ahead.");
    if (this.pending.length >= MAX_PENDING) throw new Error(`There are already ${MAX_PENDING} reminders.`);
    const reminder: Reminder = { id: randomUUID().slice(0, 8), label: text, dueAt };
    this.pending.push(reminder);
    this.saveAndSchedule();
    return reminder;
  }

  cancel(id: string): boolean {
    const before = this.pending.length;
    this.pending = this.pending.filter((reminder) => reminder.id !== id);
    if (this.pending.length === before) return false;
    this.saveAndSchedule();
    return true;
  }

  /** Due reminders not announced yet; the caller announces them and they are removed. */
  takeDue(): Reminder[] {
    const due = this.due;
    this.due = [];
    if (due.length) this.save();
    return due;
  }

  /** Puts reminders back when no session could announce them. */
  keepDue(reminders: Reminder[]): void {
    if (!reminders.length) return;
    this.due.push(...reminders);
    this.save();
  }

  get dueCount(): number {
    return this.due.length;
  }

  close(): void {
    clearTimeout(this.timer);
  }

  private fire(): void {
    const now = Date.now();
    const ready = this.pending.filter((reminder) => reminder.dueAt <= now + 500);
    if (ready.length) {
      this.pending = this.pending.filter((reminder) => reminder.dueAt > now + 500);
      this.save();
      for (const reminder of ready) this.emit("due", reminder);
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const next = Math.min(...this.pending.map((reminder) => reminder.dueAt));
    if (!Number.isFinite(next)) return;
    const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  private saveAndSchedule(): void {
    this.save();
    this.schedule();
    this.emit("change");
  }

  private load(): void {
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { pending?: unknown; due?: unknown };
      const valid = (value: unknown): Reminder[] =>
        (Array.isArray(value) ? value : []).filter(
          (r): r is Reminder =>
            typeof r?.id === "string" && typeof r?.label === "string" && typeof r?.dueAt === "number" && r.label.length <= MAX_LABEL,
        );
      const cutoff = Date.now() - STALE_AFTER_MS;
      const all = [...valid(data.pending), ...valid(data.due)].filter((r) => r.dueAt > cutoff).slice(0, MAX_PENDING);
      // Anything that came due while the app was closed is announced at the next chance.
      this.due = all.filter((r) => r.dueAt <= Date.now());
      this.pending = all.filter((r) => r.dueAt > Date.now());
    } catch {
      // no file yet, or unreadable: start empty
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify({ pending: this.pending, due: this.due }), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      console.error(`[reminders] could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Turns what the model asks for into a time. `inMinutes` wins; `at` accepts "HH:MM" (today, or tomorrow if that
 * time has passed) or an ISO 8601 date-time. Local time zone.
 */
export function resolveDueTime(args: { inMinutes?: unknown; at?: unknown }, now = new Date()): number {
  const minutes = Number(args.inMinutes);
  if (args.inMinutes !== undefined && args.inMinutes !== null && args.inMinutes !== "") {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("in_minutes must be a positive number.");
    return now.getTime() + Math.round(minutes * 60_000);
  }
  const at = typeof args.at === "string" ? args.at.trim() : "";
  const clock = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (clock) {
    const hours = Number(clock[1]);
    const mins = Number(clock[2]);
    if (hours > 23 || mins > 59) throw new Error("at must be a valid time like 15:00.");
    const due = new Date(now);
    due.setHours(hours, mins, 0, 0);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return due.getTime();
  }
  if (at) {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error('Give in_minutes, or at as "HH:MM" or an ISO date-time.');
}

/** "9月27日(日) 15:00" / "Sun, Sep 27, 3:00 PM" in the local time zone. */
export function formatLocal(time: number, language: "ja" | "en", withDate = true): string {
  const date = new Date(time);
  if (language === "ja") {
    const weekday = "日月火水木金土"[date.getDay()];
    const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
    return withDate ? `${date.getMonth() + 1}月${date.getDate()}日(${weekday}) ${clock}` : clock;
  }
  return date.toLocaleString("en-US", {
    ...(withDate ? { weekday: "short", month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}
