import assert from "node:assert/strict";
import { test } from "node:test";
import { speakLocalMockMetadata } from "../pet/ui/mail-mock-speech.js";

test("read-aloud uses only a matching installed local voice and speaks metadata", async () => {
  const spoken = [];
  const remote = { lang: "en-US", localService: false };
  const local = { lang: "en-US", localService: true };
  const synthesis = {
    getVoices: () => [remote, { lang: "ja-JP", localService: true }, local],
    cancel: () => spoken.push("cancel"),
    speak: (utterance) => { spoken.push(utterance); utterance.onstart(); },
  };
  class Utterance {
    constructor(text) { this.text = text; }
  }
  let finished = false;
  await speakLocalMockMetadata("Mock mail. Fictional sender and subject.", "en", {
    synthesis, Utterance, onEnd: () => { finished = true; },
  });
  assert.equal(spoken.length, 2);
  assert.equal(spoken[0], "cancel");
  assert.equal(spoken[1].voice, local);
  assert.equal(spoken[1].text, "Mock mail. Fictional sender and subject.");
  spoken[1].onend();
  assert.equal(finished, true);
});

test("missing local voice or speech API fails explicitly; remote voices are never used", async () => {
  let called = false;
  const synthesis = {
    getVoices: () => [{ lang: "en-US", localService: false }],
    cancel: () => { called = true; },
    speak: () => { called = true; },
  };
  await assert.rejects(speakLocalMockMetadata("MOCK", "en", { synthesis, Utterance: class {} }),
    (error) => error.code === "no-local-voice");
  assert.equal(called, false);
  await assert.rejects(speakLocalMockMetadata("MOCK", "en", { synthesis: undefined, Utterance: undefined }),
    (error) => error.code === "unsupported");
  const broken = { ...synthesis, getVoices: () => [{ lang: "ja-JP", localService: true }],
    speak: () => { throw new Error("audio failed"); } };
  await assert.rejects(speakLocalMockMetadata("模擬", "ja", { synthesis: broken, Utterance: class {} }),
    (error) => error.code === "failed");
  const silent = { ...synthesis, getVoices: () => [{ lang: "en-US", localService: true }], speak() {} };
  await assert.rejects(speakLocalMockMetadata("MOCK", "en", {
    synthesis: silent, Utterance: class {}, startWaitMs: 5,
  }), (error) => error.code === "failed", "a silent speech engine is not success");
});

test("asynchronous speech failure surfaces unless playback was intentionally canceled", async () => {
  const spoken = [];
  const synthesis = {
    getVoices: () => [{ lang: "ja-JP", localService: true }],
    cancel() {},
    speak: (utterance) => { spoken.push(utterance); utterance.onstart(); },
  };
  let errors = 0;
  await speakLocalMockMetadata("模擬の差出人と件名", "ja", {
    synthesis, Utterance: class {}, onError: () => { errors++; },
  });
  spoken[0].onerror({ error: "canceled" });
  spoken[0].onerror({ error: "audio-busy" });
  assert.equal(errors, 1);
});

test("voice loading waits briefly for a local voice and aborts cleanly when the demo is switched off", async () => {
  const listeners = new Set();
  const spoken = [];
  let voices = [];
  const synthesis = {
    getVoices: () => voices,
    addEventListener: (_event, callback) => listeners.add(callback),
    removeEventListener: (_event, callback) => listeners.delete(callback),
    cancel() {},
    speak: (utterance) => { spoken.push(utterance); utterance.onstart(); },
  };
  const first = speakLocalMockMetadata("MOCK", "en", { synthesis, Utterance: class {}, voiceWaitMs: 50 });
  voices = [{ lang: "en-US", localService: false }];
  for (const listener of listeners) listener();
  assert.equal(spoken.length, 0);
  voices = [{ lang: "en-US", localService: true }];
  for (const listener of listeners) listener();
  await first;
  assert.equal(spoken.length, 1);
  assert.equal(listeners.size, 0);

  voices = [];
  const controller = new AbortController();
  const pending = speakLocalMockMetadata("MOCK", "en", {
    synthesis, Utterance: class {}, signal: controller.signal, voiceWaitMs: 50,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "canceled");
  assert.equal(spoken.length, 1);
  assert.equal(listeners.size, 0);
});
