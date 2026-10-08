import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const settingsUi = readFileSync(new URL("../pet/ui/settings.js", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../pet/ui/renderer.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../pet/main.cjs", import.meta.url), "utf8");

test("normal settings omit News and gate the Mail mock", () => {
  assert.match(settingsUi, /const CORE_SECTIONS = \["general", "character", "voice", "automations", "mcp", "connection", "usage", "about"\]/);
  assert.match(settingsUi, /snap\.features\?\.mailMock \? ALL_SECTIONS : CORE_SECTIONS/);
  assert.doesNotMatch(settingsUi, /sectionNews|news: sectionNews/);
  assert.match(main, /env\("TONARIN_ENABLE_MAIL_MOCK"\) === "1"/);
  assert.match(main, /if \(!MAIL_MOCK_ENABLED\) return \{ ok: false, code: "unavailable" \}/);
});

test("legacy news preferences are preserved in storage but cannot change runtime source selection", () => {
  assert.match(main, /customFeeds: _newsSites, feeds: _newsSelection/);
  assert.match(main, /feeds: null,\s+customFeeds: \[\]/);
  assert.match(renderer, /feeds: \[\.\.\.snap\.catalog\.defaultFeeds\[language\]\]/);
  assert.doesNotMatch(renderer, /values\.customFeeds\.filter/);
});

test("usage guidance remains a read-only settings section", () => {
  assert.match(settingsUi, /function sectionUsage\(\)/);
  assert.match(settingsUi, /usage-explainer/);
  assert.match(settingsUi, /usage\.billed\.intro/);
  assert.doesNotMatch(
    settingsUi.split("function sectionUsage()")[1].split("const BUILDERS")[0],
    /save\(|toggle\(|select\(/,
  );
});
