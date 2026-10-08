/**
 * Gemini-free voice bridge:
 * pet PCM -> local ASR -> GitHub Copilot SDK -> response text -> local renderer TTS.
 *
 * Spoken audio stays on this computer. Only the final transcript and conversation context
 * are sent to GitHub Copilot. The renderer owns TTS so it can require an installed local voice.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { originAllowed, type Announcement, type LiveSession, type SessionOptions } from "./live.js";

const AUTH_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_UTTERANCE_BYTES = 16_000 * 2 * 120;

export function selectVoiceBackend(
  preference: "auto" | "local" | "gemini",
  localReady: boolean,
  geminiConfigured: boolean,
): "copilot-local" | "gemini" | undefined {
  if (preference === "local") return localReady ? "copilot-local" : undefined;
  if (preference === "gemini") return geminiConfigured ? "gemini" : undefined;
  if (geminiConfigured) return "gemini";
  return localReady ? "copilot-local" : undefined;
}

export interface CopilotVoiceConversation {
  send(prompt: string, signal: AbortSignal, onDelta: (text: string) => void): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotLiveConfig {
  checkKey(presented: string): boolean;
  sessionOptions(raw: unknown): SessionOptions;
  transcribe(pcm: Buffer, options: SessionOptions, signal: AbortSignal): Promise<string>;
  createConversation(options: SessionOptions, display: (event: Record<string, unknown>) => void): Promise<CopilotVoiceConversation>;
  debug: boolean;
  onSessionReady?(session: LiveSession): void;
}

type PetMessage =
  | { type: "hello"; key: string; options?: unknown }
  | { type: "audio_end" }
  | { type: "interrupt" }
  | { type: "text"; text: string }
  | { type: "reset" };

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

class CopilotVoiceConnection implements LiveSession {
  options!: SessionOptions;
  private authed = false;
  private ready = false;
  private closed = false;
  private audio: Buffer[] = [];
  private audioBytes = 0;
  private generation = 0;
  private active: AbortController | undefined;
  private conversation: CopilotVoiceConversation | undefined;
  private readonly authTimer: NodeJS.Timeout;

  constructor(
    private readonly pet: WebSocket,
    private readonly config: CopilotLiveConfig,
    private readonly onClose: () => void,
  ) {
    pet.on("message", (data, isBinary) => void this.onMessage(data, isBinary));
    pet.on("close", () => void this.shutdown());
    pet.on("error", (error) => this.log(`pet socket error: ${error.message}`));
    this.authTimer = setTimeout(() => {
      if (!this.authed) pet.close(4401, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);
  }

  private log(message: string): void {
    if (this.config.debug) console.log(`[copilot-live] ${message}`);
  }

  private send(message: Record<string, unknown>): void {
    if (this.pet.readyState === WebSocket.OPEN) this.pet.send(JSON.stringify(message));
  }

  private async onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      if (!this.authed || !this.ready || this.audioBytes >= MAX_UTTERANCE_BYTES) return;
      const chunk = toBuffer(data);
      const remaining = MAX_UTTERANCE_BYTES - this.audioBytes;
      const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      this.audio.push(accepted);
      this.audioBytes += accepted.length;
      return;
    }

    let message: PetMessage;
    try {
      message = JSON.parse(toBuffer(data).toString("utf8")) as PetMessage;
    } catch {
      return;
    }

    if (!this.authed) {
      if (message.type !== "hello" || typeof message.key !== "string" || !this.config.checkKey(message.key)) {
        this.pet.close(4401, "Invalid API key");
        return;
      }
      this.authed = true;
      clearTimeout(this.authTimer);
      this.options = this.config.sessionOptions(message.options);
      await this.startConversation();
      return;
    }

    switch (message.type) {
      case "audio_end": {
        const pcm = Buffer.concat(this.audio, this.audioBytes);
        this.audio = [];
        this.audioBytes = 0;
        if (pcm.length) void this.runAudio(pcm);
        break;
      }
      case "interrupt":
        await this.interrupt();
        break;
      case "text":
        if (typeof message.text === "string" && message.text.trim()) void this.runText(message.text.trim().slice(0, 4000));
        break;
      case "reset":
        await this.interrupt();
        await this.conversation?.disconnect().catch(() => {});
        this.conversation = undefined;
        await this.startConversation();
        break;
    }
  }

  private async startConversation(): Promise<void> {
    this.ready = false;
    this.send({ type: "status", state: "connecting", backend: "copilot-local" });
    try {
      this.conversation = await this.config.createConversation(this.options, (event) => this.send({ ...event, type: "display" }));
      this.ready = true;
      this.send({ type: "status", state: "ready", backend: "copilot-local" });
      this.config.onSessionReady?.(this);
    } catch (error) {
      this.send({ type: "status", state: "error", backend: "copilot-local", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async runAudio(pcm: Buffer): Promise<void> {
    await this.interrupt(false);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.active = controller;
    this.send({ type: "tool", name: "local_transcription", phase: "start" });
    try {
      const text = await this.config.transcribe(pcm, this.options, controller.signal);
      if (controller.signal.aborted || generation !== this.generation || !text) return;
      this.send({ type: "transcript", role: "user", text, phase: "final" });
      await this.runPrompt(text, controller, generation);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.send({ type: "status", state: "error", backend: "copilot-local", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.send({ type: "tool", name: "local_transcription", phase: "end" });
      if (this.active === controller) this.active = undefined;
    }
  }

  private async runText(prompt: string): Promise<void> {
    await this.interrupt(false);
    const controller = new AbortController();
    const generation = ++this.generation;
    this.active = controller;
    await this.runPrompt(prompt, controller, generation);
  }

  private async runPrompt(prompt: string, controller = new AbortController(), generation = ++this.generation): Promise<string> {
    if (!this.conversation || !this.ready) return "";
    this.active = controller;
    this.send({ type: "tool", name: "copilot_voice", phase: "start" });
    let streamed = "";
    try {
      const answer = await this.conversation.send(prompt, controller.signal, (delta) => {
        if (controller.signal.aborted || generation !== this.generation || !delta) return;
        streamed += delta;
        this.send({ type: "transcript", role: "model", text: delta, phase: "partial" });
      });
      if (controller.signal.aborted || generation !== this.generation) return "";
      if (!streamed && answer) this.send({ type: "transcript", role: "model", text: answer, phase: "final" });
      else this.send({ type: "transcript", role: "model", text: "", phase: "final" });
      this.send({ type: "turn_complete", backend: "copilot-local" });
      return answer;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.send({ type: "status", state: "error", backend: "copilot-local", message: error instanceof Error ? error.message : String(error) });
      }
      return "";
    } finally {
      this.send({ type: "tool", name: "copilot_voice", phase: "end" });
      if (this.active === controller) this.active = undefined;
    }
  }

  private async interrupt(notify = true): Promise<void> {
    this.generation++;
    const active = this.active;
    this.active = undefined;
    active?.abort();
    if (active) await this.conversation?.abort().catch(() => {});
    if (notify) this.send({ type: "interrupted", backend: "copilot-local" });
  }

  get isReady(): boolean {
    return this.authed && this.ready && !this.closed;
  }

  announce(announcement: Announcement): boolean {
    if (!this.isReady || this.active) return false;
    this.send({ ...announcement.event, type: "announce" });
    void this.runPrompt(announcement.prompt).then((answer) => announcement.capture?.(answer));
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    await this.interrupt(false);
    await this.conversation?.disconnect().catch(() => {});
    this.conversation = undefined;
    if (this.pet.readyState === WebSocket.OPEN) this.pet.close(1001, "Server shutting down");
    this.onClose();
  }
}

export function attachCopilotLive(
  server: Server,
  config: CopilotLiveConfig,
): { close(): void; announce(build: (session: LiveSession) => Announcement): number; readySessions(): LiveSession[] } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const connections = new Set<CopilotVoiceConnection>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/v1/live" && path !== "/live") return;
    if (!originAllowed(req.headers.origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new CopilotVoiceConnection(ws, config, () => connections.delete(connection));
      connections.add(connection);
    });
  });

  return {
    close() {
      for (const connection of [...connections]) void connection.shutdown();
      wss.close();
    },
    readySessions() {
      return [...connections].filter((connection) => connection.isReady);
    },
    announce(build) {
      let delivered = 0;
      for (const connection of connections) if (connection.isReady && connection.announce(build(connection))) delivered++;
      return delivered;
    },
  };
}
