// Page wording per platform (pet/ui/i18n.js and pet/i18n.cjs): Windows gets no Mac-only words.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
// Mac-only words that must not reach a Windows screen. The Mac Calendar preset is only offered on macOS.
const MAC_ONLY = /keychain|キーチェーン|this Mac|この Mac|Mac に|your Mac|macOS|System Settings|システム設定|Control \+|~\//;
const MAC_ONLY_KEYS = /^mcp\.preset\.calendar/;

async function pageStrings(platform) {
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.pet = { platform };
  const i18n = await import(`../pet/ui/i18n.js?platform=${platform}`);
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../pet/ui/i18n.js", import.meta.url), "utf8"));
  const keys = [...new Set([...source.matchAll(/^\s+"([a-z][\w.]+)":/gm)].map((match) => match[1]))];
  const strings = {};
  for (const language of ["ja", "en"]) {
    i18n.setLanguage(language);
    strings[language] = Object.fromEntries(keys.map((key) => [key, i18n.t(key)]));
  }
  return { i18n, keys, strings, root: globalThis.document.documentElement };
}

test("the pages mark their platform and use Windows wording there", async () => {
  const { i18n, root, strings } = await pageStrings("win32");
  assert.equal(i18n.PLATFORM, "win32");
  assert.equal(root.dataset.platform, "win32");
  for (const language of ["ja", "en"]) {
    for (const [key, text] of Object.entries(strings[language])) {
      if (MAC_ONLY_KEYS.test(key)) continue;
      assert.doesNotMatch(text, MAC_ONLY, `${language} ${key}: ${text}`);
    }
  }
  assert.match(strings.en["connection.geminiDesc"], /DPAPI/);
  assert.match(strings.ja["pet.micError"], /デスクトップ アプリがマイクにアクセスできるようにする/);
});

test("every Windows wording replaces an existing string, in both languages", async () => {
  const { keys, strings } = await pageStrings("win32");
  const mac = await pageStrings("darwin");
  const changed = (language) => keys.filter((key) => strings[language][key] !== mac.strings[language][key]).sort();
  assert.ok(changed("ja").length >= 10, "Windows wording is in use");
  assert.deepEqual(changed("ja"), changed("en"), "the same keys differ in Japanese and English");
  assert.equal(mac.strings.en["connection.statusKeychain"], "Set (keychain)", "macOS keeps its wording");
});

test("the main process says Ctrl on Windows and Control on a Mac", () => {
  const { translator } = require("../pet/i18n.cjs");
  assert.match(translator("en", "win32")("pinchHint"), /Ctrl \+ scroll/);
  assert.match(translator("ja", "win32")("pinchHint"), /Ctrl \+ スクロール/);
  assert.match(translator("en", "darwin")("pinchHint"), /Control \+ scroll/);
  assert.equal(translator("en", "win32")("quit"), "Quit");
  for (const language of ["ja", "en"]) {
    const title = translator(language, "win32")("mailMockNotificationTitle");
    const body = translator(language, "win32")("mailMockNotificationBody", { sender: "Example", subject: "Sample" });
    assert.match(title, /MOCK\/DEMO/);
    assert.match(body, /Example/);
    assert.match(body, /Sample/);
  }
});

test("backend-aware voice errors exist in both languages without blaming Gemini for local failures", () => {
  const source = readFileSync(new URL("../pet/ui/i18n.js", import.meta.url), "utf8");
  const messages = source.slice(source.indexOf("const MESSAGES = {"), source.indexOf("const WINDOWS_MESSAGES = {"));
  const japanese = messages.slice(messages.indexOf("\n  ja: {"), messages.indexOf("\n  en: {"));
  const english = messages.slice(messages.indexOf("\n  en: {"));
  const keys = (text) => [...new Set([...text.matchAll(/^\s+"(pet\.error[\w.]+)":/gm)].map((match) => match[1]))].sort();
  assert.deepEqual(keys(japanese), keys(english));
  for (const key of ["pet.errorGeneric", "pet.errorGemini", "pet.errorLocalVoice", "pet.errorCopilotVoice",
    "pet.errorCopilotTimeout", "pet.errorCopilotGeneric"]) {
    assert.ok(keys(japanese).includes(key), `${key} is translated`);
  }
  assert.match(japanese, /"pet\.errorCopilotTimeout": "GitHub Copilot/);
  assert.doesNotMatch(japanese.match(/"pet\.errorCopilotTimeout":[^\n]+/)?.[0] ?? "", /Gemini/);
  assert.doesNotMatch(english.match(/"pet\.errorCopilotTimeout":[^\n]+/)?.[0] ?? "", /Gemini/);
});

test("mock mail labels and consent errors match in both languages without implying a real connection", () => {
  const source = readFileSync(new URL("../pet/ui/i18n.js", import.meta.url), "utf8");
  const messages = source.slice(source.indexOf("const MESSAGES = {"), source.indexOf("const WINDOWS_MESSAGES = {"));
  const japanese = messages.slice(messages.indexOf("\n  ja: {"), messages.indexOf("\n  en: {"));
  const english = messages.slice(messages.indexOf("\n  en: {"));
  const keys = (text) => [...new Set([...text.matchAll(/^\s+"(mailMock\.[\w.-]+)":/gm)].map((match) => match[1]))].sort();
  assert.deepEqual(keys(japanese), keys(english));
  for (const key of ["mailMock.warning", "mailMock.enable", "mailMock.status.connected",
    "mailMock.bodyOptIn", "mailMock.aiCheck", "mailMock.error.storage-unavailable"]) {
    assert.ok(keys(japanese).includes(key), `${key} is translated`);
  }
  assert.match(japanese, /"mailMock\.title": ".*MOCK\/DEMO/);
  assert.match(english, /"mailMock\.title": ".*MOCK\/DEMO/);
  assert.match(japanese, /"mailMock\.status\.connected": ".*架空/);
  assert.match(english, /"mailMock\.status\.connected": ".*fictional/);
  assert.match(japanese, /"mailMock\.readAloudDesc": "初期オフ/);
  assert.match(english, /"mailMock\.readAloudDesc": "Off by default/);
});
