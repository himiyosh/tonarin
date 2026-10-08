import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import {
  acceptLocalTranscript,
  attachCopilotLive,
  copilotVoiceErrorCode,
  selectVoiceBackend,
} from "../src/copilot-live.ts";

const options = {
  language: "ja",
  uiLanguage: "ja",
  voice: "local",
  silenceMs: 700,
  noiseFilter: "standard",
  persona: "",
  feeds: [],
  useCopilot: true,
  mode: "companion",
};

test("voice backend selection preserves existing Gemini users and honors explicit local privacy", () => {
  assert.equal(selectVoiceBackend("auto", true, true), "gemini");
  assert.equal(selectVoiceBackend("auto", true, false), "copilot-local");
  assert.equal(selectVoiceBackend("local", true, true), "copilot-local");
  assert.equal(selectVoiceBackend("local", false, true), undefined);
  assert.equal(selectVoiceBackend("gemini", true, false), undefined);
});

test("local transcript validation removes classic silence hallucinations without rejecting strong short speech", () => {
  const weak = { durationMs: 1800, voicedMs: 160, voiceRatio: 0.08, maxThresholdRatio: 1.1 };
  const strong = { durationMs: 1400, voicedMs: 600, voiceRatio: 0.35, maxThresholdRatio: 1.8 };
  assert.equal(acceptLocalTranscript("ご視聴ありがとうございました", strong), false);
  assert.equal(acceptLocalTranscript("ふぅーはい。はい。次の動画でお会いしましょう。朝7時になりました。", strong), false);
  assert.equal(acceptLocalTranscript("See you in the next video. It is now 7 AM.", strong), false);
  assert.equal(acceptLocalTranscript("♪", strong), false);
  assert.equal(acceptLocalTranscript("音楽", weak), false);
  assert.equal(acceptLocalTranscript("音楽", strong), true);
  assert.equal(acceptLocalTranscript("小さい声です", weak), true);
});

test("Copilot SDK idle timeout has a stable backend-aware error code", () => {
  assert.equal(copilotVoiceErrorCode(new Error("Timeout after 120000ms waiting for session.idle")), "copilot-timeout");
  assert.equal(copilotVoiceErrorCode(new Error("not signed in")), "copilot-unavailable");
  assert.equal(copilotVoiceErrorCode(new Error("request failed")), "copilot-turn");
});

function messages(ws) {
  const queued = [];
  const waiting = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });
  return async () => queued.shift() ?? new Promise((resolve) => waiting.push(resolve));
}

async function nextWhere(next, predicate) {
  for (;;) {
    const message = await next();
    if (predicate(message)) return message;
  }
}

test("local Copilot voice emits final input, partial output, completion, and interruption", async (t) => {
  const server = http.createServer();
  let aborted = 0;
  const bridge = attachCopilotLive(server, {
    checkKey: (key) => key === "test-key",
    sessionOptions: () => options,
    debug: false,
    transcribe: async (pcm) => {
      assert.equal(pcm.length, 640);
      return "こんにちは";
    },
    createConversation: async () => ({
      async send(prompt, signal, onDelta) {
        if (prompt === "slow") {
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        assert.equal(prompt, "こんにちは");
        onDelta("返");
        onDelta("事");
        return "返事";
      },
      async abort() {
        aborted++;
      },
      async disconnect() {},
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: "pet://app" });
  const next = messages(ws);
  await once(ws, "open");
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: "hello", key: "test-key", options }));
  await nextWhere(next, (message) => message.type === "status" && message.state === "ready");

  ws.send(Buffer.alloc(640));
  ws.send(JSON.stringify({ type: "audio_end" }));
  const seen = [];
  for (;;) {
    const message = await next();
    seen.push(message);
    if (message.type === "turn_complete") break;
  }
  assert.ok(seen.some((message) => message.type === "transcript" && message.role === "user" && message.phase === "final" && message.text === "こんにちは"));
  assert.deepEqual(
    seen.filter((message) => message.type === "transcript" && message.role === "model" && message.phase === "partial").map((message) => message.text),
    ["返", "事"],
  );
  assert.ok(seen.some((message) => message.type === "transcript" && message.role === "model" && message.phase === "final"));

  ws.send(JSON.stringify({ type: "text", text: "slow" }));
  await nextWhere(next, (message) => message.type === "tool" && message.name === "copilot_voice" && message.phase === "start");
  ws.send(JSON.stringify({ type: "interrupt" }));
  await nextWhere(next, (message) => message.type === "interrupted");
  assert.ok(aborted > 0);
});

test("local Copilot voice rejects web origins", async (t) => {
  const server = http.createServer();
  const bridge = attachCopilotLive(server, {
    checkKey: () => true,
    sessionOptions: () => options,
    debug: false,
    transcribe: async () => "",
    createConversation: async () => {
      throw new Error("must not be called");
    },
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: "https://example.com" });
  const [error] = await once(ws, "error");
  assert.match(error.message, /403/);
});

test("false ASR utterances do not interrupt an active reply, while a valid utterance interrupts once", async (t) => {
  const server = http.createServer();
  let aborted = 0;
  let transcription = 0;
  const bridge = attachCopilotLive(server, {
    checkKey: () => true,
    sessionOptions: () => options,
    debug: false,
    transcribe: async () => ["ご視聴ありがとうございました", "音楽", "次の質問"][transcription++],
    createConversation: async () => ({
      async send(prompt, signal, onDelta) {
        if (prompt === "slow") {
          onDelta("考");
          await new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        onDelta("答");
        return "答え";
      },
      async abort() {
        aborted++;
      },
      async disconnect() {},
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: "pet://app" });
  const next = messages(ws);
  await once(ws, "open");
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: "hello", key: "test-key", options }));
  await nextWhere(next, (message) => message.type === "status" && message.state === "ready");
  ws.send(JSON.stringify({ type: "text", text: "slow" }));
  await nextWhere(next, (message) => message.type === "tool" && message.name === "copilot_voice" && message.phase === "start");

  const weak = { durationMs: 1800, voicedMs: 160, voiceRatio: 0.08, maxThresholdRatio: 1.1 };
  for (let i = 0; i < 2; i++) {
    ws.send(Buffer.alloc(640));
    ws.send(JSON.stringify({ type: "audio_end", evidence: weak }));
    await nextWhere(next, (message) => message.type === "tool" && message.name === "local_transcription" && message.phase === "end");
  }
  assert.equal(aborted, 0);

  ws.send(Buffer.alloc(640));
  ws.send(JSON.stringify({ type: "audio_end", evidence: {
    durationMs: 1600, voicedMs: 720, voiceRatio: 0.4, maxThresholdRatio: 1.8,
  } }));
  const accepted = [];
  for (;;) {
    const message = await next();
    accepted.push(message);
    if (message.type === "transcript" && message.role === "user") break;
  }
  assert.equal(aborted, 1);
  assert.ok(accepted.some((message) => message.type === "interrupted"),
    "the renderer closes the interrupted reply before showing the accepted user transcript");
  await nextWhere(next, (message) => message.type === "turn_complete");
});

test("Copilot idle timeout reports the local backend, rebuilds the conversation, and accepts the next turn", async (t) => {
  const server = http.createServer();
  let conversations = 0;
  const bridge = attachCopilotLive(server, {
    checkKey: () => true,
    sessionOptions: () => options,
    debug: false,
    transcribe: async () => "",
    createConversation: async () => {
      const id = ++conversations;
      return {
        async send(prompt, _signal, onDelta) {
          if (id === 1) throw new Error("Timeout after 120000ms waiting for session.idle");
          onDelta(`recovered:${prompt}`);
          return `recovered:${prompt}`;
        },
        async abort() {},
        async disconnect() {},
      };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: "pet://app" });
  const next = messages(ws);
  await once(ws, "open");
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: "hello", key: "test-key", options }));
  await nextWhere(next, (message) => message.type === "status" && message.state === "ready");
  ws.send(JSON.stringify({ type: "text", text: "first" }));
  const error = await nextWhere(next, (message) => message.type === "error");
  assert.equal(error.backend, "copilot-local");
  assert.equal(error.code, "copilot-timeout");
  assert.equal(error.recoverable, true);
  await nextWhere(next, (message) => message.type === "status" && message.state === "ready");

  ws.send(JSON.stringify({ type: "text", text: "second" }));
  const recovered = await nextWhere(next, (message) =>
    message.type === "transcript" && message.role === "model" && message.text === "recovered:second");
  assert.equal(recovered.backend, undefined);
  await nextWhere(next, (message) => message.type === "turn_complete");
  assert.equal(conversations, 2);
});
