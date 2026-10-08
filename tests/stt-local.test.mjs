import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("local PCM transcription sends a WAV utterance to whisper-server", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tonarin-whisper-test-"));
  const binary = join(dir, "whisper-server");
  const model = join(dir, "model.bin");
  await writeFile(model, "test");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (!body.includes(Buffer.from("RIFF")) || !body.includes(Buffer.from("WAVE"))) {
    res.writeHead(400).end("missing wav");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ text: "こんにちは" }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
  await chmod(binary, 0o755);

  const old = {
    PATH: process.env.PATH,
    WHISPER_MODEL: process.env.WHISPER_MODEL,
    WHISPER_PORT: process.env.WHISPER_PORT,
  };
  process.env.PATH = `${dir}:${old.PATH ?? ""}`;
  process.env.WHISPER_MODEL = model;
  process.env.WHISPER_PORT = "18788";
  const stt = await import(`../src/stt.ts?test=${Date.now()}`);
  try {
    assert.match(stt.startWhisper(), /POST \/v1\/audio\/transcriptions/);
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        assert.equal(await stt.transcribePcm(Buffer.alloc(640), "ja"), "こんにちは");
        return;
      } catch (error) {
        if (attempt === 29) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } finally {
    stt.stopWhisper();
    process.env.PATH = old.PATH;
    if (old.WHISPER_MODEL === undefined) delete process.env.WHISPER_MODEL;
    else process.env.WHISPER_MODEL = old.WHISPER_MODEL;
    if (old.WHISPER_PORT === undefined) delete process.env.WHISPER_PORT;
    else process.env.WHISPER_PORT = old.WHISPER_PORT;
  }
});
