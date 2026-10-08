import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const renderer = readFileSync(new URL("../pet/ui/renderer.js", import.meta.url), "utf8");
const micFlow = renderer.slice(renderer.indexOf("function onMicChunk"), renderer.indexOf("function onPlayerLevel"));

test("local microphone candidates wait for transcription before interrupting Copilot", () => {
  assert.match(micFlow, /cancelLocalSpeech\(\)/);
  assert.doesNotMatch(micFlow, /type:\s*"interrupt"/);
  assert.match(micFlow, /type:\s*"audio_end", evidence: utterance/);
});

test("overlong local microphone candidates are discarded instead of sent as complete utterances", () => {
  assert.match(micFlow, /if \(send\.length > remaining\) localUtteranceOverflow = true/);
  assert.match(micFlow, /if \(!overflowed\) \{\s+for \(const chunk of chunks\) ws\.send\(chunk\)/);
});
