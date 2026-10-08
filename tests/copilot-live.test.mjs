import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { attachCopilotLive, selectVoiceBackend } from "../src/copilot-live.ts";

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
