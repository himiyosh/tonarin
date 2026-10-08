const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Settings } = require("../pet/settings.cjs");

test("voice backend defaults to compatibility mode and validates explicit local selection", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tonarin-settings-voice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = new Settings(dir);
  assert.equal(settings.values.voiceBackend, "auto");
  assert.deepEqual(settings.update({ voiceBackend: "local" }), ["voiceBackend"]);
  assert.equal(settings.values.voiceBackend, "local");
  assert.deepEqual(settings.update({ voiceBackend: "remote-service" }), []);
  assert.equal(settings.values.voiceBackend, "local");
});
