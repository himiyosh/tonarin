import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { createMailMock } = require("../pet/mail-mock.cjs");

test("settings keeps the mock off, demonstrates finite notices/speech/consent, and isolates both providers in JA and EN", async (context) => {
  const html = readFileSync(new URL("../pet/ui/settings.html", import.meta.url), "utf8");
  const catalog = JSON.parse(readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"));
  const { document, window } = parseHTML(html);
  for (const node of document.querySelectorAll("[data-i18n]")) node.dataset.i18n = node.getAttribute("data-i18n");
  const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    ...selectValue,
    set(value) {
      for (const option of this.querySelectorAll("option")) option.selected = option.value === String(value);
    },
  });
  context.after(() => Object.defineProperty(window.HTMLSelectElement.prototype, "value", selectValue));

  const secrets = new Map();
  const stored = {
    values: { mailMockEnabled: false, mailMockProvider: "gmail" },
    hasSecret: (name) => secrets.has(name),
    getSecret: (name) => secrets.get(name),
    setSecret(name, value) { value ? secrets.set(name, value) : secrets.delete(name); },
    update(patch) { Object.assign(this.values, patch); },
  };
  const notices = [];
  const controller = createMailMock({ settings: stored, notify: (title, body) => {
    notices.push({ title, body });
    return true;
  }, translate: (key, vars = {}) => `MOCK/DEMO ${key} ${vars.subject ?? ""}` });
  let language = "en";
  let onChanged;
  const opened = [];
  const network = [];
  const spoken = [];
  const settingsSnapshot = () => ({
    uiLanguage: language,
    speechLanguage: language,
    appName: "Tonarin",
    version: "test",
    versions: { electron: "test", chrome: "test", node: "test" },
    values: { language, character: "mochi", scale: 1, persona: "", voice: "Aoede", silenceMs: 700,
      noiseFilter: "standard", customFeeds: [], feeds: [], useCopilot: false, ...stored.values },
    catalog,
    gemini: { source: "none" },
    proxy: { running: false, managed: false, status: null },
    pet: { conn: "ready", muted: false, sleeping: false },
    githubSignIn: false,
    mailMock: controller.snapshot(),
  });
  const invoke = (method, ...args) => Promise.resolve().then(() => {
    try {
      const data = controller[method](...args) ?? {};
      const result = { ok: true, ...data, snapshot: settingsSnapshot() };
      onChanged?.(result.snapshot);
      return result;
    } catch (error) {
      return { ok: false, code: error.code ?? "internal", snapshot: settingsSnapshot() };
    }
  });
  const pet = {
    platform: "win32",
    codexPets: async () => [],
    settings: {
      get: async () => settingsSnapshot(),
      onChanged: (fn) => { onChanged = fn; },
      onSection() {},
      open: (target) => opened.push(target),
      mailMock: {
        setEnabled: (value) => invoke("setEnabled", value),
        selectProvider: (value) => invoke("selectProvider", value),
        begin: () => invoke("begin"),
        approve: () => invoke("approve"),
        cancel: () => invoke("cancel"),
        disconnect: () => invoke("disconnect"),
        next: () => invoke("nextMail"),
        setBodyOptIn: (value) => invoke("setBodyOptIn", value),
        setReadAloud: (value) => invoke("setReadAloud", value),
        viewBody: (id) => invoke("viewBody", id),
        confirmAiTransfer: (id, confirmed) => invoke("confirmAiTransfer", id, confirmed),
      },
      github: { onEvent() {} },
      automations: { onChanged() {}, list: async () => ({ ok: true, data: { automations: [], history: [] } }) },
      mcp: { onChanged() {}, list: async () => ({ servers: [], status: null }) },
      usage: async () => ({ ok: true, data: { days: [] } }),
    },
  };
  window.pet = pet;
  const synthesis = {
    getVoices: () => [{ lang: "en-US", localService: true }, { lang: "ja-JP", localService: true }],
    cancel() {},
    speak: (utterance) => { spoken.push(utterance); utterance.onstart(); },
  };
  const globals = {
    document, window, pet, speechSynthesis: synthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    location: { hash: "#mailMock" },
    history: { replaceState() {} },
    fetch: async (url) => { network.push(url); return { text: async () => "<svg></svg>" }; },
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  context.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import("../pet/ui/settings.js");
  const { t } = await import("../pet/ui/i18n.js");
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const click = (element) => {
    assert.ok(element, "expected control is present");
    element.dispatchEvent(new window.Event("click"));
  };
  const change = async (element, value) => {
    assert.ok(element);
    if (element.getAttribute("type") === "checkbox") element.checked = value;
    else element.value = value;
    element.dispatchEvent(new window.Event("change"));
    await tick();
  };
  let page = document.querySelector("#section-mailMock");
  const button = (key) => [...page.querySelectorAll("button")].find((element) => element.textContent === t(key));
  assert.equal(document.documentElement.lang, "en");
  assert.match(document.querySelector('[data-section="mailMock"]').textContent, /MOCK/);
  assert.match(page.querySelector("h1").textContent, /MOCK\/DEMO/);
  assert.equal(controller.snapshot().status, "off");
  assert.equal(page.querySelector(".mail-list .mail-message"), null);
  assert.equal(page.querySelector('[aria-label="Enable the mock demo"]').checked, false);
  assert.equal(notices.length, 0);
  assert.equal(spoken.length, 0);

  await change(page.querySelector('[aria-label="Enable the mock demo"]'), true);
  assert.equal(controller.snapshot().status, "ready");
  click(button("mailMock.begin"));
  await tick();
  assert.equal(controller.snapshot().status, "pending");
  click(button("mailMock.approve"));
  await tick();
  assert.equal(page.querySelectorAll(".mail-message").length, 1);
  assert.match(page.querySelector(".mail-status").textContent, /fictional/);
  assert.equal(page.querySelector(".mail-body-panel").hidden, true);
  assert.equal(button("mailMock.viewBody"), undefined);

  await change(page.querySelector('[aria-label="Automatically read fictional sender and subject on mock new mail"]'), true);
  click(button("mailMock.next"));
  await tick();
  assert.equal(page.querySelectorAll(".mail-message").length, 2);
  assert.equal(notices.length, 1);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0].text, /Mock mail.*Fictional|Mock mail.*Sample/);
  assert.doesNotMatch(spoken[0].text, /This is a fictional Gmail-style message/);
  click(button("mailMock.next"));
  await tick();
  assert.equal(page.querySelectorAll(".mail-message").length, 3);
  assert.equal(notices.length, 2);
  assert.equal(button("mailMock.next").disabled, true);

  await change(page.querySelector('[aria-label="Show fictional bodies (this session only)"]'), true);
  click(button("mailMock.viewBody"));
  await tick();
  assert.equal(page.querySelector(".mail-body-panel").hidden, false);
  assert.match(page.querySelector(".mail-body-text").textContent, /fictional/);
  const aiCheck = page.querySelector(".mail-ai-confirm input");
  const aiConfirm = button("mailMock.aiConfirm");
  assert.equal(aiCheck.checked, false);
  assert.equal(aiConfirm.disabled, true);
  await change(aiCheck, true);
  assert.equal(aiConfirm.disabled, false);
  click(aiConfirm);
  await tick();
  assert.match(page.textContent, /No body was sent to AI/);
  assert.equal(aiCheck.checked, false);

  await change(page.querySelector('select[aria-label="Provider style to simulate"]'), "outlook");
  assert.equal(controller.snapshot().status, "ready");
  assert.equal(page.querySelector(".mail-body-panel").hidden, true);
  assert.equal(secrets.has("mailMock:gmail"), false);
  click(button("mailMock.begin"));
  await tick();
  click(button("mailMock.approve"));
  await tick();
  assert.equal(page.querySelectorAll(".mail-message").length, 1);
  assert.match(page.querySelector(".mail-list").textContent, /fictional introduction/);
  assert.doesNotMatch(page.querySelector(".mail-list").textContent, /fictional welcome/);
  assert.equal(controller.snapshot().bodyOptIn, false);
  assert.equal(controller.snapshot().readAloud, false);
  secrets.set("mailMock:outlook", "corrupt");
  onChanged(settingsSnapshot());
  assert.match(page.querySelector(".mail-status").textContent, /Storage or expiry problem/);
  assert.match(page.querySelector('[role="alert"]').textContent, /fake token cannot be read securely/);
  click(button("mailMock.disconnect"));
  await tick();
  assert.equal(controller.snapshot().status, "ready");
  click(button("mailMock.begin"));
  await tick();
  click(button("mailMock.approve"));
  await tick();
  language = "ja";
  onChanged(settingsSnapshot());
  page = document.querySelector("#section-mailMock");
  assert.equal(document.documentElement.lang, "ja");
  assert.match(page.querySelector("h1").textContent, /MOCK\/DEMO/);
  assert.match(page.querySelector(".mail-status").textContent, /架空/);
  assert.equal(page.querySelector(".mail-body-panel").hidden, true);
  await change(page.querySelector('input[aria-label="模擬デモを有効にする"]'), false);
  assert.equal(controller.snapshot().status, "off");
  assert.equal(secrets.size, 0);
  assert.equal(notices.length, 2);
  assert.deepEqual(opened, [], "the mock never opens real browser sign-in");
  assert.ok(network.every((url) => String(url).startsWith("characters/")), "only bundled character assets are fetched");
});
