/**
 * Realtime voice bridge for the desktop pet, backed by the Gemini Live API.
 *
 *   pet  ──(ws://127.0.0.1:8787/v1/live: mic PCM16 16 kHz + JSON)──>  proxy  ──(wss)──>  Gemini Live
 *   pet  <──(PCM16 24 kHz audio + transcripts / state events)──────   proxy  <──       audio, tool calls
 *
 * Why a relay instead of letting the pet talk to Google directly:
 * - The Gemini API key never leaves this process (the pet only knows PROXY_API_KEY).
 * - Tool calls run here, with the same read-only news tools and host allowlist as the
 *   Copilot session, plus `ask_copilot`, which hands deeper questions to GitHub Copilot.
 *
 * Nothing spoken is logged. DEBUG_REQUESTS=1 prints event types, sizes and token counts only.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const INPUT_MIME = "audio/pcm;rate=16000";
const CONTEXT_TRIGGER_TOKENS = 25_000;
const CONTEXT_TARGET_TOKENS = 8_000;
const AUTH_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_MS = 90_000;
const FAST_RETRIES = 5; // then keep trying every SLOW_RETRY_MS, so the pet recovers after sleep or a network outage
const SLOW_RETRY_MS = 30_000;
const MAX_PET_MESSAGE_BYTES = 1024 * 1024;

/** Gemini's OpenAPI-style schema subset for function parameters. */
export interface GeminiSchema {
  type: "OBJECT" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY";
  description?: string;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
}

/** Per-session choices the pet sends with its hello (from its settings window). Always validated by the proxy. */
export interface SessionOptions {
  /** Language the pet speaks (and asks Copilot to answer in). */
  language: "ja" | "en";
  voice: string;
  /** Silence (ms) after which Gemini's voice activity detection ends the user's turn. */
  silenceMs: number;
  /** How much room noise is ignored: the pet's own speech gate, plus Gemini's start-of-speech detection. */
  noiseFilter: NoiseFilter;
  /** Custom character description; empty means the default for the language. */
  persona: string;
  /** Enabled news feed ids. */
  feeds: string[];
  /** Offer the ask_copilot tool. */
  useCopilot: boolean;
  /** companion: talk about anything; english: English conversation practice; focus: quiet, short answers. */
  mode: "companion" | "english" | "focus";
  /** The language of the pet's menus and captions (for notes shown to the user, such as correction cards). */
  uiLanguage: "ja" | "en";
}

/** What a tool can do besides answering the model. */
export interface ToolContext {
  /** Shows something in the pet (for example a correction card). Sent as { type: "display", ...event }. */
  display(event: Record<string, unknown>): void;
}

export interface LiveTool {
  name: string;
  description: string;
  parameters?: GeminiSchema;
  run(args: Record<string, unknown>, signal: AbortSignal, options: SessionOptions, context: ToolContext): Promise<unknown>;
}

/** Something the proxy wants the pet to say on its own, such as a reminder that came due. */
export interface Announcement {
  /** Sent to the model as a short user turn that asks it to speak. */
  prompt: string;
  /** Sent to the pet as { type: "announce", ...event } (the pet can show it and play a sound). */
  event: Record<string, unknown>;
  /** Receives what the pet said in answer (its output transcript), for example to keep a history. */
  capture?: (spokenText: string) => void;
}

const CAPTURE_QUIET_MS = 2500; // the answer is complete after the model's turn ends and nothing follows for this long
const CAPTURE_MAX_MS = 120_000;

/** A ready live session, as seen by the proxy. */
export interface LiveSession {
  readonly options: SessionOptions;
  /** Returns false when the session cannot take it right now. */
  announce(announcement: Announcement): boolean;
}

export interface LiveConfig {
  apiKey: string;
  model: string;
  /** Turns the (untrusted) options from the pet's hello into valid options, filling in defaults. */
  sessionOptions(raw: unknown): SessionOptions;
  instructions(options: SessionOptions): string;
  tools(options: SessionOptions): LiveTool[];
  /** Constant-time check of the PROXY_API_KEY the pet presents. */
  checkKey(presented: string): boolean;
  debug: boolean;
  /** Test hook: a mock server instead of Google. */
  upstreamUrl?: string;
  /** Called whenever a session becomes ready (also after reconnects), for example to announce waiting reminders. */
  onSessionReady?(session: LiveSession): void;
  /** Usage counters (numbers only): Gemini's per-turn token counts, transcript text length, seconds of mic audio. */
  usage?: {
    addTurn(usage: UsageMetadata): void;
    addTranscription(text: string): void;
    addListening(seconds: number): void;
  };
}

// ---------------------------------------------------------------------------
// Wire types (only the fields we use)
// ---------------------------------------------------------------------------
interface FunctionCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}
interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
  toolCall?: { functionCalls?: FunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: UsageMetadata;
}

/** Token counts Gemini reports (per turn); only numbers and modality names, never content. */
export interface UsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  [key: string]: unknown;
}

type PetState = "connecting" | "ready" | "reconnecting" | "error";

/** Messages the pet sends as text frames. Binary frames are always mic audio. */
type PetMessage =
  | { type: "hello"; key: string; options?: unknown }
  | { type: "audio_end" }
  | { type: "text"; text: string }
  | { type: "reset" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Browsers attach an Origin header to WebSocket handshakes and CORS does not apply to them,
 * so any web page could try to connect to 127.0.0.1. Only accept the pet app and local pages.
 * (The API key check still applies to everyone.)
 */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // native clients (Node scripts, tests)
  if (origin === "pet://app" || origin === "file://" || origin === "null") return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Close reasons from Google are short status texts; keep them short and single-line for the pet. */
function describeClose(code: number, reason: Buffer): string {
  const text = reason.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 200);
  return text ? `${code} ${text}` : String(code);
}

/** Errors that will not go away by reconnecting (bad key, bad setup, quota). */
function isPermanent(code: number, reason: string): boolean {
  return code === 1007 || code === 1008 || /quota|exhausted|api key|permission|denied|invalid|not found|billing/i.test(reason);
}

export type NoiseFilter = "light" | "standard" | "strong";
/**
 * Gemini's start-of-speech detection per noise filter. LOW sensitivity starts a turn less often; prefixPaddingMs is
 * how long speech must be detected before the start is committed, so short noises (a click, a cough) do not count.
 * "light" keeps Gemini's defaults (the behavior before 2026-09-28).
 */
const START_OF_SPEECH: Record<NoiseFilter, Record<string, unknown>> = {
  light: {},
  standard: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", prefixPaddingMs: 200 },
  strong: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW", prefixPaddingMs: 350 },
};

export function buildSetup(config: LiveConfig, options: SessionOptions, tools: LiveTool[], handle: string | undefined): unknown {
  return {
    setup: {
      model: `models/${config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voice } } },
      },
      systemInstruction: { parts: [{ text: config.instructions(options) }] },
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            behavior: "NON_BLOCKING", // keep talking while the tool runs (the default on 3.8 Live, set explicitly)
            ...(tool.parameters ? { parameters: tool.parameters } : {}),
          })),
        },
      ],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: options.silenceMs, ...START_OF_SPEECH[options.noiseFilter] },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS", // barge-in: speaking over the pet stops it
      },
      // Lifts the 15-minute audio session limit, and caps cost: every turn is billed for the whole context, so it is
      // cut back to 8K tokens once it reaches 25K (the values Google's Live API best practices suggest). The default
      // trigger is 80% of the model's context window, which would make each turn of a long chat far more expensive.
      contextWindowCompression: { triggerTokens: CONTEXT_TRIGGER_TOKENS, slidingWindow: { targetTokens: CONTEXT_TARGET_TOKENS } },
      sessionResumption: handle ? { handle } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// One pet connection = one Gemini Live session (resumed across upstream reconnects)
// ---------------------------------------------------------------------------
class PetConnection implements LiveSession {
  private upstream: WebSocket | undefined;
  private generation = 0;
  private ready = false;
  private authed = false;
  private closed = false;
  private handle: string | undefined;
  private reconnects = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readyGeneration = 0;
  private goAwayPending = false;
  private modelSpeaking = false;
  private readonly runningTools = new Map<string, AbortController>();
  options!: SessionOptions; // set when the pet says hello
  private tools: LiveTool[] = [];
  private readonly authTimer: NodeJS.Timeout;
  private audioFramesIn = 0;
  private capture: { callback: (text: string) => void; text: string; quiet?: NodeJS.Timeout; hardStop: NodeJS.Timeout } | undefined;

  constructor(
    private readonly pet: WebSocket,
    private readonly config: LiveConfig,
    private readonly onClose: () => void,
  ) {
    pet.on("message", (data, isBinary) => this.onPetMessage(data, isBinary));
    pet.on("close", () => this.shutdown());
    pet.on("error", (error) => this.log(`pet socket error: ${error.message}`));
    this.authTimer = setTimeout(() => {
      if (!this.authed) pet.close(4401, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);
  }

  private log(message: string): void {
    if (this.config.debug) console.log(`[live] ${message}`);
  }

  private sendPet(message: Record<string, unknown>): void {
    if (this.pet.readyState === WebSocket.OPEN) this.pet.send(JSON.stringify(message));
  }

  private status(state: PetState, message?: string): void {
    this.sendPet({ type: "status", state, ...(message ? { message } : {}) });
  }

  private sendUp(message: unknown): void {
    if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(message));
  }

  // --- pet -> proxy -------------------------------------------------------
  private onPetMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      // Mic audio: 16-bit little-endian PCM, 16 kHz, mono. Dropped until the session is ready.
      if (!this.authed || !this.ready) return;
      this.audioFramesIn++;
      const audio = toBuffer(data);
      this.config.usage?.addListening(audio.length / 32_000); // 16 kHz x 2 bytes per second
      this.sendUp({ realtimeInput: { audio: { data: audio.toString("base64"), mimeType: INPUT_MIME } } });
      return;
    }

    let message: PetMessage;
    try {
      message = JSON.parse(toBuffer(data).toString("utf8")) as PetMessage;
    } catch {
      return;
    }

    if (!this.authed) {
      if (message.type === "hello" && typeof message.key === "string" && this.config.checkKey(message.key)) {
        this.authed = true;
        clearTimeout(this.authTimer);
        this.options = this.config.sessionOptions(message.options);
        this.tools = this.config.tools(this.options);
        this.log(
          `session options: mode=${this.options.mode} language=${this.options.language} voice=${this.options.voice} ` +
            `feeds=${this.options.feeds.length} copilot=${this.options.useCopilot} tools=${this.tools.map((tool) => tool.name).join(",")}`,
        );
        this.status("connecting");
        this.connectUpstream();
      } else {
        this.pet.close(4401, "Invalid API key");
      }
      return;
    }

    switch (message.type) {
      case "audio_end": // the mic was muted: let voice activity detection finish the turn
        if (this.ready) this.sendUp({ realtimeInput: { audioStreamEnd: true } });
        break;
      case "text":
        if (this.ready && typeof message.text === "string" && message.text.trim()) {
          this.sendUp({ clientContent: { turns: [{ role: "user", parts: [{ text: message.text.slice(0, 4000) }] }], turnComplete: true } });
        }
        break;
      case "reset": // start over with a fresh conversation
        this.handle = undefined;
        this.reconnects = 0;
        this.status("connecting");
        this.connectUpstream();
        break;
    }
  }

  // --- proxy -> Gemini ----------------------------------------------------
  private connectUpstream(): void {
    clearTimeout(this.reconnectTimer);
    this.abortTools();
    const previous = this.upstream;
    const generation = ++this.generation;
    this.ready = false;
    this.goAwayPending = false;
    this.modelSpeaking = false;
    previous?.removeAllListeners();
    previous?.on("error", () => {}); // a late error from the old socket must not crash the process
    previous?.close(1000);

    const base = this.config.upstreamUrl ?? GEMINI_LIVE_URL;
    const upstream = new WebSocket(`${base}?key=${encodeURIComponent(this.config.apiKey)}`, { maxPayload: 16 * 1024 * 1024 });
    this.upstream = upstream;
    const resuming = this.handle !== undefined;
    this.log(`connecting upstream (generation ${generation}${resuming ? ", resuming" : ""})`);

    upstream.on("open", () => upstream.send(JSON.stringify(buildSetup(this.config, this.options, this.tools, this.handle))));
    upstream.on("message", (data) => {
      if (generation !== this.generation) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(toBuffer(data).toString("utf8")) as ServerMessage; // Google sends JSON in binary frames too
      } catch {
        return;
      }
      this.onUpstreamMessage(message, generation);
    });
    // Never include the error object itself in logs: some carry the request URL, which holds the key.
    upstream.on("error", (error) => this.log(`upstream error: ${error.message.replace(/key=[^&\s]+/g, "key=***")}`));
    upstream.on("close", (code, reason) => {
      if (generation !== this.generation || this.closed) return;
      this.ready = false;
      const description = describeClose(code, reason);
      this.log(`upstream closed: ${description}`);

      if (isPermanent(code, description)) {
        console.error(`[live] Gemini closed the session: ${description}`);
        this.status("error", description);
        return;
      }
      // A resumption handle can go stale (seen after the Mac slept: every resume failed with 1011).
      // If resuming did not get as far as setupComplete, or keeps failing, start a fresh conversation instead.
      if (this.handle && (this.readyGeneration !== generation || this.reconnects >= 2)) {
        this.log("dropping the resumption handle; the next connection starts a fresh session");
        this.handle = undefined;
      }
      const delay = this.goAwayPending ? 0 : this.reconnects < FAST_RETRIES ? Math.min(1000 * 2 ** this.reconnects, 10_000) : SLOW_RETRY_MS;
      if (this.reconnects === FAST_RETRIES) console.error(`[live] Gemini is unreachable (${description}); retrying every ${SLOW_RETRY_MS / 1000} s`);
      this.reconnects++;
      this.status("reconnecting", this.reconnects > FAST_RETRIES ? "Gemini に接続できません。30 秒ごとに再接続を試しています。" : undefined);
      this.reconnectTimer = setTimeout(() => this.connectUpstream(), delay);
    });
  }

  // --- Gemini -> proxy ----------------------------------------------------
  private onUpstreamMessage(message: ServerMessage, generation: number): void {
    if (message.setupComplete !== undefined) {
      this.ready = true;
      this.readyGeneration = generation;
      this.reconnects = 0;
      this.log(`session ready (${this.handle ? "resumed" : "new"})`);
      this.status("ready");
      this.config.onSessionReady?.(this);
    }

    const content = message.serverContent;
    if (content) {
      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData?.data;
        if (audio && (part.inlineData?.mimeType ?? "audio/pcm").startsWith("audio/")) {
          this.modelSpeaking = true;
          if (this.pet.readyState === WebSocket.OPEN) this.pet.send(Buffer.from(audio, "base64"), { binary: true });
        }
      }
      if (content.inputTranscription?.text) {
        this.sendPet({ type: "transcript", role: "user", text: content.inputTranscription.text });
        this.config.usage?.addTranscription(content.inputTranscription.text); // only its length is used
      }
      if (content.outputTranscription?.text) {
        this.config.usage?.addTranscription(content.outputTranscription.text);
        this.sendPet({ type: "transcript", role: "model", text: content.outputTranscription.text });
        if (this.capture) {
          this.capture.text += content.outputTranscription.text;
          clearTimeout(this.capture.quiet);
        }
      }
      if (content.interrupted) {
        this.modelSpeaking = false;
        this.sendPet({ type: "interrupted" });
      }
      if (content.turnComplete) {
        this.modelSpeaking = false;
        this.sendPet({ type: "turn_complete" });
        // An announcement's answer is done once a turn ends with no tool still running and nothing follows.
        if (this.capture && this.runningTools.size === 0 && this.capture.text.trim()) {
          clearTimeout(this.capture.quiet);
          this.capture.quiet = setTimeout(() => this.finishCapture(), CAPTURE_QUIET_MS);
        }
        this.log(`turn complete (mic frames so far: ${this.audioFramesIn})`);
        this.maybeReconnectForGoAway();
      }
    }

    for (const call of message.toolCall?.functionCalls ?? []) void this.runTool(call, generation);
    for (const id of message.toolCallCancellation?.ids ?? []) {
      this.log(`tool call cancelled by the model`);
      this.runningTools.get(id)?.abort();
    }

    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.handle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.goAway) {
      // The connection ends soon (connections last about 10 minutes). Switch over at a quiet moment.
      this.log(`goAway received (time left: ${message.goAway.timeLeft ?? "?"})`);
      this.goAwayPending = true;
      this.maybeReconnectForGoAway();
    }
    if (message.usageMetadata) {
      // One report per turn (measured on 3.8 Live), covering the whole context re-read for that turn.
      this.config.usage?.addTurn(message.usageMetadata);
      this.log(`usage ${JSON.stringify(message.usageMetadata)}${message.serverContent?.turnComplete ? " (turnComplete)" : ""}`); // counts only
    }
  }

  private maybeReconnectForGoAway(): void {
    if (this.goAwayPending && !this.modelSpeaking && this.runningTools.size === 0 && this.handle) {
      this.log("switching to a fresh connection (session resumption)");
      this.connectUpstream();
    }
  }

  private async runTool(call: FunctionCall, generation: number): Promise<void> {
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    const controller = new AbortController();
    this.runningTools.set(call.id, controller);
    this.sendPet({ type: "tool", name: call.name, phase: "start" });
    const started = performance.now();

    let response: Record<string, unknown>;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("The tool took too long and was stopped."));
        }, TOOL_TIMEOUT_MS);
      });
      const context: ToolContext = { display: (event) => this.sendPet({ ...event, type: "display" }) };
      response = { output: await Promise.race([tool.run(call.args ?? {}, controller.signal, this.options, context), timeout]) };
    } catch (error) {
      response = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      this.runningTools.delete(call.id);
      this.sendPet({ type: "tool", name: call.name, phase: "end" });
    }
    this.log(`tool ${call.name} ${"error" in response ? "failed" : "ok"} in ${Math.round(performance.now() - started)} ms`);

    // Cancelled, or the upstream connection was replaced: the call id is no longer valid there.
    if (controller.signal.aborted || generation !== this.generation) return;
    this.sendUp({
      toolResponse: {
        // WHEN_IDLE: let the pet finish its current sentence ("ちょっと見てみますね") before using the result.
        functionResponses: [{ id: call.id, name: call.name, response, scheduling: "WHEN_IDLE" }],
      },
    });
    this.maybeReconnectForGoAway();
  }

  get isReady(): boolean {
    return this.authed && this.ready && !this.closed;
  }

  announce(announcement: Announcement): boolean {
    if (!this.isReady || this.upstream?.readyState !== WebSocket.OPEN) return false;
    this.finishCapture(); // one capture at a time
    if (announcement.capture) {
      this.capture = {
        callback: announcement.capture,
        text: "",
        hardStop: setTimeout(() => this.finishCapture(), CAPTURE_MAX_MS),
      };
    }
    this.sendPet({ ...announcement.event, type: "announce" });
    this.sendUp({ clientContent: { turns: [{ role: "user", parts: [{ text: announcement.prompt }] }], turnComplete: true } });
    this.log("announcement sent");
    return true;
  }

  private finishCapture(): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = undefined;
    clearTimeout(capture.quiet);
    clearTimeout(capture.hardStop);
    capture.callback(capture.text.trim());
  }

  private abortTools(): void {
    for (const controller of this.runningTools.values()) controller.abort();
    this.runningTools.clear();
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.finishCapture();
    clearTimeout(this.authTimer);
    clearTimeout(this.reconnectTimer);
    this.abortTools();
    this.upstream?.removeAllListeners();
    this.upstream?.on("error", () => {});
    this.upstream?.close(1000);
    if (this.pet.readyState === WebSocket.OPEN) this.pet.close(1001, "Server shutting down");
    this.log("pet disconnected");
    this.onClose();
  }
}

/** Adds the /v1/live WebSocket endpoint to the proxy's HTTP server. */
export function attachLive(
  server: Server,
  config: LiveConfig,
): { close(): void; announce(build: (session: LiveSession) => Announcement): number; readySessions(): LiveSession[] } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PET_MESSAGE_BYTES });
  const connections = new Set<PetConnection>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/v1/live" && path !== "/live") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      console.error(`[live] rejected a connection from origin ${req.headers.origin}`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: PetConnection = new PetConnection(ws, config, () => connections.delete(connection));
      connections.add(connection);
    });
  });

  return {
    close() {
      for (const connection of [...connections]) connection.shutdown();
      wss.close();
    },
    /** Sessions that can take an announcement right now (oldest first). */
    readySessions() {
      return [...connections].filter((connection) => connection.isReady);
    },
    /** Tells every ready session (in its own language); returns how many took it (0 = nobody is listening). */
    announce(build) {
      let delivered = 0;
      for (const connection of connections) if (connection.isReady && connection.announce(build(connection))) delivered++;
      return delivered;
    },
  };
}
