import assert from "node:assert/strict";
import { test } from "node:test";
import { voiceErrorKey } from "../pet/ui/voice-errors.js";

test("local Copilot timeouts never fall through to Gemini copy", () => {
  assert.equal(voiceErrorKey({
    backend: "copilot-local",
    message: "Timeout after 120000ms waiting for session.idle",
  }), "pet.errorCopilotTimeout");
  assert.equal(voiceErrorKey({
    backend: "copilot-local",
    code: "copilot-timeout",
    message: "Timeout",
  }), "pet.errorCopilotTimeout");
  assert.equal(voiceErrorKey({
    backend: "copilot-local",
    message: "unexpected response failure",
  }), "pet.errorCopilotGeneric");
});

test("Gemini credential and quota guidance is limited to the Gemini backend", () => {
  assert.equal(voiceErrorKey({ backend: "gemini", message: "429 quota exhausted" }), "pet.errorQuota");
  assert.equal(voiceErrorKey({ backend: "gemini", message: "API key permission denied" }), "pet.errorKey");
  assert.equal(voiceErrorKey({ backend: "gemini", message: "socket closed" }), "pet.errorGemini");
  assert.equal(voiceErrorKey({ backend: "copilot-local", message: "429 quota exhausted" }), "pet.errorCopilotGeneric");
});
