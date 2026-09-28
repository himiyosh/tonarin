/**
 * Smoke test for the realtime endpoint, no microphone needed:
 *   npm run live:check                      # a short greeting
 *   npm run live:check -- "最新のニュースを2つ教えて"   # exercises the news tools
 *   LIVE_LANGUAGE=en npm run live:check -- "What's new in tech today?"   # English session (English rules and feeds)
 *   LIVE_MODE=english npm run live:check -- "I goed to office yesterday"  # English practice (correction cards)
 *   npm run live:check -- "1分後にストレッチって教えて"                        # reminders (keep it running to hear it)
 *
 * Sends one text turn to ws://127.0.0.1:$PORT/v1/live and reports latency, audio size,
 * tool calls and the spoken reply (transcript). The proxy must be running.
 */
import WebSocket from "ws";

const port = process.env.PORT ?? 8787;
const mode = ["companion", "english", "focus"].includes(process.env.LIVE_MODE) ? process.env.LIVE_MODE : "companion";
const language = process.env.LIVE_LANGUAGE === "en" || mode === "english" ? "en" : "ja";
const prompt = process.argv[2] ?? (language === "en" ? "Hi! Introduce yourself in one sentence." : "こんにちは。ひとことで自己紹介してください。");
const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`);

let sentAt;
let firstAudioMs;
let audioBytes = 0;
let transcript = "";
let toolsRunning = 0;
let lastToolEndAt = 0;
let lastAudioAt = 0;
const events = [];

function finish(code = 0) {
  const seconds = (audioBytes / 2 / 24000).toFixed(1);
  console.log(`events     : ${events.join(" ")}`);
  console.log(`first audio: ${firstAudioMs ?? "-"} ms after sending`);
  console.log(`audio      : ${audioBytes} bytes (${seconds} s at 24 kHz)`);
  console.log(`transcript : ${transcript.trim() || "(none)"}`);
  ws.close();
  process.exit(code);
}

// Session options are what the pet sends from its settings; missing fields fall back to the proxy's defaults.
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", key: process.env.PROXY_API_KEY ?? "", options: { language, mode, uiLanguage: "ja", noiseFilter: process.env.LIVE_NOISE_FILTER } })));
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    audioBytes += data.length;
    lastAudioAt = Date.now();
    firstAudioMs ??= lastAudioAt - sentAt;
    return;
  }
  const message = JSON.parse(data.toString());
  events.push([message.type, message.state, message.name, message.phase].filter(Boolean).join(":"));
  if (message.type === "status" && message.state === "ready" && !sentAt) {
    sentAt = Date.now();
    ws.send(JSON.stringify({ type: "text", text: prompt }));
  }
  if (message.type === "status" && message.state === "error") {
    console.log(`error      : ${message.message}`);
    finish(1);
  }
  if (message.type === "tool") {
    toolsRunning += message.phase === "start" ? 1 : -1;
    if (message.phase === "end") lastToolEndAt = Date.now();
  }
  if (message.type === "transcript" && message.role === "model") transcript += message.text;
  if (message.type === "display" || message.type === "announce") console.log(`${message.type.padEnd(11)}: ${JSON.stringify(message)}`);
  // After a tool call, the answer comes in a later turn: wait until audio arrived after the tool finished.
  if (message.type === "turn_complete" && toolsRunning === 0 && lastAudioAt > lastToolEndAt) finish();
});
ws.on("close", (code, reason) => {
  if (code === 4401) console.log("error      : invalid PROXY_API_KEY");
  else if (!sentAt) console.log(`error      : closed before ready (${code} ${reason})`);
});
ws.on("error", (error) => {
  console.log(`error      : ${error.message} (is the proxy running?)`);
  process.exit(1);
});
setTimeout(() => {
  console.log("timeout    : no complete reply within 60 s");
  finish(1);
}, 60_000);
