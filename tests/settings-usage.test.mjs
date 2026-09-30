import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";

test("usage billing guidance is read-only in both languages while real actions remain", async (context) => {
  const html = readFileSync(new URL("../pet/ui/settings.html", import.meta.url), "utf8");
  const catalog = JSON.parse(readFileSync(new URL("../src/catalog.json", import.meta.url), "utf8"));
  const { document, window } = parseHTML(html);
  for (const node of document.querySelectorAll("[data-i18n]")) node.dataset.i18n = node.getAttribute("data-i18n"); // linkedom misreads keys containing digits
  const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    ...selectValue,
    set(value) {
      for (const option of this.querySelectorAll("option")) option.selected = option.value === String(value);
    },
  }); // linkedom omits the browser's select.value setter
  context.after(() => Object.defineProperty(window.HTMLSelectElement.prototype, "value", selectValue));
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document,
    window,
    location: { hash: "#usage" },
    history: { replaceState() {} },
    fetch: async () => ({ text: async () => "<svg></svg>" }),
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  context.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const snapshot = (uiLanguage, pet = { conn: "ready", muted: false, sleeping: false }) => ({
    uiLanguage,
    speechLanguage: "ja",
    appName: "Tonarin",
    version: "test",
    versions: { electron: "test", chrome: "test", node: "test" },
    values: { language: uiLanguage, character: "mochi", scale: 1, persona: "", voice: "Aoede", silenceMs: 700,
      noiseFilter: "standard", customFeeds: [], feeds: [], useCopilot: false },
    catalog,
    gemini: { source: "none" },
    proxy: { running: false, managed: false, status: null },
    pet,
    githubSignIn: false,
  });
  let onChanged;
  let usageCalls = 0;
  const opened = [];
  const pet = {
    platform: "darwin",
    codexPets: async () => [],
    settings: {
      get: async () => snapshot("en"),
      onChanged: (fn) => (onChanged = fn),
      onSection() {},
      usage: async () => {
        usageCalls++;
        return { ok: true, data: { days: [{ date: today, turns: 1, inputAudio: 20, inputText: 5, inputOther: 0,
          outputAudio: 10, outputText: 3, thoughts: 0, transcription: 0, listeningSeconds: 60,
          copilotRequests: 0, estimate: { turns: 0.01, total: 0.02 } }] } };
      },
      open: (target) => opened.push(target),
      github: { onEvent() {} },
      automations: { onChanged() {}, list: async () => ({ ok: true, data: { automations: [], history: [] } }) },
      mcp: { onChanged() {}, list: async () => ({ servers: [], status: null }) },
    },
  };
  window.pet = pet;
  previous.set("pet", Object.getOwnPropertyDescriptor(globalThis, "pet"));
  Object.defineProperty(globalThis, "pet", { configurable: true, writable: true, value: pet });

  await import("../pet/ui/settings.js");
  const { t } = await import("../pet/ui/i18n.js");
  const page = document.querySelector("#section-usage");
  const keys = ["talk", "listening", "mute", "sleep", "scheduled", "quit", "copilot", "data"];
  const assertReadOnly = (language, state) => {
    const page = document.querySelector("#section-usage");
    assert.equal(document.documentElement.lang, language);
    assert.equal(page.querySelector("#usage-billed-heading").textContent, t("usage.billed"));
    assert.equal(page.querySelector(".usage-explainer-intro").textContent, t("usage.billed.intro"));
    assert.match(t("usage.billed.intro"), language === "ja" ? /設定を変更できません/ : /Nothing here changes your settings/);
    assert.equal(page.querySelector(".usage-explainer").getAttribute("aria-labelledby"), "usage-billed-heading");
    const items = [...page.querySelectorAll(".usage-explainer > li")];
    assert.equal(items.length, keys.length);
    items.forEach((item, index) => {
      const key = `usage.billed.${keys[index]}`;
      assert.equal(item.querySelector("h3").textContent, t(key));
      assert.equal(item.querySelector(".usage-explainer-status").textContent, t(`${key}Pill`));
      assert.equal(item.querySelector("p").textContent, t(`${key}Desc`));
    });
    assert.equal(page.querySelector(".usage-now h3").textContent, t(`usage.state.${state}`));
    assert.equal(page.querySelector(".usage-now p").textContent, t(`usage.state.${state}Desc`));
    assert.equal(page.querySelector(".usage-now .usage-explainer-status").textContent, t(`usage.state.${state}Pill`));
    for (const info of [page.querySelector(".usage-now"), page.querySelector(".usage-explainer")]) {
      assert.equal(info.querySelectorAll(".row, .control, .pill").length, 0);
      assert.equal(info.querySelectorAll("button, a, input, select, textarea, [tabindex], [contenteditable], [role='button'], [role='link'], [role='switch']").length, 0);
    }
  };

  assertReadOnly("en", "listening");
  assert.equal(page.querySelectorAll(".usage-row").length, 8);
  assert.equal(page.querySelectorAll(".section-head button").length, 1);
  assert.equal(page.querySelectorAll(".actions.spaced button").length, 4);
  const before = usageCalls;
  page.querySelector(".section-head button").dispatchEvent(new window.Event("click"));
  await Promise.resolve();
  assert.equal(usageCalls, before + 1, "Refresh still fetches usage");
  for (const button of page.querySelectorAll(".actions.spaced button")) button.dispatchEvent(new window.Event("click"));
  assert.deepEqual(opened, ["ai-studio-usage", "ai-studio-spend", "gemini-pricing", "live-billing"]);

  onChanged(snapshot("ja", { conn: "ready", muted: true, sleeping: false }));
  assertReadOnly("ja", "muted");
  onChanged(snapshot("ja", { conn: "ready", muted: false, sleeping: true }));
  assertReadOnly("ja", "sleeping");
  onChanged(snapshot("ja", { conn: "connecting", muted: false, sleeping: false }));
  assertReadOnly("ja", "offline");
  for (const language of ["ja", "en"]) {
    if (language === "en") onChanged(snapshot("en"));
    const news = document.querySelector("#section-news");
    assert.equal(news.querySelector("p.lead").textContent, t("news.desc"));
    assert.match(t("news.desc"), /RSS\/Atom/);
    assert.match(t("news.desc"), language === "ja" ? /有効にした.*Web 全体/ : /enabled.*wider web/i);
    assert.match(t("news.categoryDesc"), language === "ja" ? /キーワード通知.*日英の標準/ : /Keyword alerts.*both languages/);
    assert.match(t("auto.keywordsDesc"), language === "ja" ? /日英の標準.*有効にした/ : /default news sites in both languages.*enabled sources/);
    assert.match(t("news.addDesc"), /10/);
  }
});
