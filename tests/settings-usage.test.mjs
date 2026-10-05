import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";

test("usage guidance stays read-only and News settings explain the enabled scope in both languages", async (context) => {
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
  const snapshot = (uiLanguage, pet = { conn: "ready", muted: false, sleeping: false },
    { speechLanguage = "ja", customFeeds = [], feeds = [] } = {}) => ({
    uiLanguage,
    speechLanguage,
    appName: "Tonarin",
    version: "test",
    versions: { electron: "test", chrome: "test", node: "test" },
    values: { language: uiLanguage, character: "mochi", scale: 1, persona: "", voice: "Aoede", silenceMs: 700,
      noiseFilter: "standard", customFeeds, feeds, useCopilot: false },
    catalog,
    gemini: { source: "none" },
    proxy: { running: false, managed: false, status: null },
    pet,
    githubSignIn: false,
    mailMock: { enabled: false, provider: "gmail", status: "off", account: null, messages: [],
      remaining: 0, bodyOptIn: false, readAloud: false },
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
  const billedGroups = [
    ["conversation", keys.slice(0, 4)],
    ["automation", keys.slice(4, 6)],
    ["information", keys.slice(6)],
  ];
  const assertReadOnly = (language, state) => {
    const page = document.querySelector("#section-usage");
    assert.equal(document.documentElement.lang, language);
    assert.equal(page.querySelector("#usage-billed-heading").textContent, t("usage.billed"));
    assert.equal(page.querySelector(".usage-explainer-intro").textContent, t("usage.billed.intro"));
    assert.match(t("usage.billed.intro"), language === "ja" ? /設定を変更できません/ : /Nothing here changes your settings/);
    const groups = [...page.querySelectorAll(".usage-guide-group")];
    assert.equal(groups.length, billedGroups.length);
    const readingOrder = ["usage.billed"];
    groups.forEach((group, index) => {
      const [id, groupKeys] = billedGroups[index];
      const heading = group.querySelector("h3.usage-guide-title");
      const list = group.querySelector("ul.usage-explainer");
      assert.equal(heading.id, `usage-billed-${id}`);
      assert.equal(heading.textContent, t(`usage.billed.group.${id}`));
      assert.notEqual(heading.textContent, `usage.billed.group.${id}`, "group heading is translated");
      assert.equal(list.getAttribute("aria-labelledby"), heading.id);
      readingOrder.push(`usage.billed.group.${id}`);
      const items = [...list.children];
      assert.equal(items.length, groupKeys.length);
      items.forEach((item, itemIndex) => {
        const key = `usage.billed.${groupKeys[itemIndex]}`;
        const icon = item.querySelector(".usage-explainer-icon");
        assert.equal(icon.getAttribute("aria-hidden"), "true", "decorative icons are skipped by screen readers");
        assert.ok(icon.querySelector("svg"), "every explanation has a visible icon");
        assert.ok(item.firstElementChild === icon, "icon precedes explanatory text visually");
        assert.equal(item.querySelector("h4").textContent, t(key));
        assert.equal(item.querySelector(".usage-explainer-status").textContent, t(`${key}Pill`));
        assert.equal(item.querySelector("p").textContent, t(`${key}Desc`));
        assert.equal(item.textContent, `${t(key)}${t(`${key}Pill`)}${t(`${key}Desc`)}`,
          "the accessible text follows title, billing status, then explanation");
        readingOrder.push(key);
      });
    });
    assert.deepEqual([...page.querySelectorAll("#usage-billed-heading, .usage-guide-title, .usage-explainer h4")]
      .map((heading) => heading.textContent), readingOrder.map((key) => t(key)),
    "semantic headings read in visual order");
    assert.equal(page.querySelector(".usage-now h3").textContent, t(`usage.state.${state}`));
    assert.equal(page.querySelector(".usage-now p").textContent, t(`usage.state.${state}Desc`));
    assert.equal(page.querySelector(".usage-now .usage-explainer-status").textContent, t(`usage.state.${state}Pill`));
    for (const info of [page.querySelector(".usage-now"), ...groups]) {
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
  const site = (n, language) => ({
    id: `custom-${String(n).padStart(8, "0")}-1234-1234-1234-123456789abc`,
    name: `Site ${n}`, language, category: "science",
    siteUrl: `https://site${n}.example.org/`, siteHost: `site${n}.example.org`,
    url: `https://feeds.example.org/${n}.xml`,
  });
  const japaneseSite = site(1, "ja");
  const englishSite = site(2, "en");
  const newsPage = () => document.querySelector("#section-news");
  const addButton = () => newsPage().querySelector(".news-add-controls button");
  const customSwitches = () => [...newsPage().querySelector("#news-custom-heading").nextElementSibling.querySelectorAll("input[type=checkbox]")]
    .map((input) => input.checked);
  for (const language of ["ja", "en"]) {
    if (language === "en") onChanged(snapshot("en"));
    const news = newsPage();
    assert.equal(news.querySelector("p.lead").textContent, t("news.desc"));
    assert.match(t("news.desc"), /RSS\/Atom/);
    assert.match(t("news.desc"), language === "ja" ? /オンにした.*Web 全体/ : /sites you switch on.*wider web/i);
    assert.match(t("news.categoryDesc"), language === "ja" ? /オフにした.*キーワード通知.*確認しません/ : /keyword alerts skip sites you switch off/i);
    assert.match(t("auto.keywordsDesc"), language === "ja" ? /オンにした付属・追加.*すべてオフ/ : /sites switched on.*all sites off/i);
    assert.match(t("news.addDesc"), language === "ja" ? /HTTPS.*自動検出.*HTTPS URL/ : /HTTPS website URL.*automatically.*HTTPS RSS\/Atom URL/i);
    assert.match(t("news.hostLimit"), language === "ja"
      ? /利用条件.*正確なホスト.*robots.txt.*リンクのみ.*公開 RSS\/Atom/
      : /terms.*robots.txt.*exact host.*link only.*public RSS\/Atom/i);
    assert.deepEqual([...news.querySelectorAll("h2")].slice(0, 2).map((heading) => heading.textContent),
      [t("news.addTitle"), t("news.categories")], "the add form appears before topic switches");
    assert.equal(news.querySelector(".group input.news-url").closest("label").textContent.trim(), t("news.siteUrl"));
    for (const info of [news.querySelector(".news-scope"), news.querySelector(".news-capacity"), news.querySelector(".news-host-note")]) {
      assert.equal(info.querySelectorAll("button, a, input, select, textarea, [contenteditable], [role='button']").length, 0,
        "help text stays read-only");
    }
    assert.equal(news.querySelector(".news-scope").textContent, t("news.watching", { builtIn: 0, custom: 0 }));
    assert.equal(news.querySelector(".news-capacity").textContent, t("news.capacity", { count: 0, max: 10, remaining: 10 }));
    assert.equal(addButton().disabled, false);
    assert.equal(news.querySelector(".news-empty").hidden, false);
    assert.match(t("news.empty"), language === "ja" ? /キーワード通知.*確認しません/ : /keyword alerts won't check/i);

    onChanged(snapshot(language, undefined, { speechLanguage: "ja", customFeeds: [japaneseSite, englishSite], feeds: null }));
    assert.equal(newsPage().querySelector(".news-scope").textContent, t("news.watching", { builtIn: catalog.defaultFeeds.ja.length, custom: 1 }));
    assert.equal(newsPage().querySelector(".news-capacity").textContent, t("news.capacity", { count: 2, max: 10, remaining: 8 }));
    assert.deepEqual(customSwitches(), [true, false], "only the Japanese personal site is enabled with Japanese defaults");
    onChanged(snapshot(language, undefined, { speechLanguage: "en", customFeeds: [japaneseSite, englishSite], feeds: null }));
    assert.equal(newsPage().querySelector(".news-scope").textContent, t("news.watching", { builtIn: catalog.defaultFeeds.en.length, custom: 1 }));
    assert.deepEqual(customSwitches(), [false, true], "changing the pet's language updates the watched sources");
    assert.equal(newsPage().querySelector(".news-empty").hidden, true, "defaults hide the empty state");
    onChanged(snapshot(language));
    assert.equal(newsPage().querySelector(".news-empty").hidden, false, "turning off all sources shows the empty state");
  }

  onChanged(snapshot("en", undefined, { speechLanguage: "en", customFeeds: [japaneseSite, englishSite],
    feeds: [catalog.defaultFeeds.en[0], japaneseSite.id] }));
  assert.equal(newsPage().querySelector(".news-scope").textContent, t("news.watching", { builtIn: 1, custom: 1 }));
  assert.deepEqual(customSwitches(), [true, false], "the explicit selection, not the language, controls both personal sites");

  document.querySelector('#nav [data-section="news"]').dispatchEvent(new window.Event("click"));
  assert.equal(newsPage().hidden, false);
  const activeBefore = Object.getOwnPropertyDescriptor(document, "activeElement");
  const focusBefore = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "focus");
  let active;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  Object.defineProperty(window.HTMLElement.prototype, "focus", {
    configurable: true, value() { active = this; },
  });
  context.after(() => {
    if (activeBefore) Object.defineProperty(document, "activeElement", activeBefore);
    else delete document.activeElement;
    if (focusBefore) Object.defineProperty(window.HTMLElement.prototype, "focus", focusBefore);
    else delete window.HTMLElement.prototype.focus;
  });
  const url = newsPage().querySelector(".news-url");
  addButton().focus();
  addButton().dispatchEvent(new window.Event("click"));
  assert.ok(active === url, "invalid URLs return focus to the labeled field");
  assert.equal(newsPage().querySelector(".message.error").textContent, t("news.error.url"));

  const addedSite = site(3, "en");
  let addedUrl;
  pet.settings.news = {
    add: async ({ url: value }) => {
      addedUrl = value;
      return { ok: true, feed: addedSite, snapshot: snapshot("en", undefined, {
        speechLanguage: "en", customFeeds: [japaneseSite, englishSite, addedSite],
        feeds: [catalog.defaultFeeds.en[0], japaneseSite.id, addedSite.id],
      }) };
    },
    remove: async () => ({ ok: true, snapshot: snapshot("en", undefined, {
      speechLanguage: "en", customFeeds: [japaneseSite, englishSite],
      feeds: [catalog.defaultFeeds.en[0], japaneseSite.id],
    }) }),
  };
  url.value = "https://site3.example.org/";
  url.checkValidity = () => true;
  addButton().focus();
  addButton().dispatchEvent(new window.Event("click"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(addedUrl, "https://site3.example.org/");
  assert.ok(active === newsPage().querySelector(".news-url"), "adding a site returns focus to the fresh URL field");
  assert.equal(active.value, "");
  assert.equal(newsPage().querySelector(".news-capacity").textContent, t("news.capacity", { count: 3, max: 10, remaining: 7 }));
  assert.equal(newsPage().querySelector(".news-scope").textContent, t("news.watching", { builtIn: 1, custom: 2 }));

  window.confirm = () => true;
  const remove = [...newsPage().querySelector("#news-custom-heading").nextElementSibling.querySelectorAll(".row")]
    .find((row) => row.querySelector(".title").textContent === addedSite.name).querySelector("button");
  remove.focus();
  remove.dispatchEvent(new window.Event("click"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(active === newsPage().querySelector("#news-custom-heading"), "removing a site restores focus to the remaining site list");
  assert.equal(newsPage().querySelector(".news-capacity").textContent, t("news.capacity", { count: 2, max: 10, remaining: 8 }));

  onChanged(snapshot("en", undefined, { customFeeds: Array.from({ length: 10 }, (_, index) => site(index + 1, "en")), feeds: [] }));
  assert.equal(newsPage().querySelector(".news-capacity").textContent, t("news.capacity", { count: 10, max: 10, remaining: 0 }));
  assert.equal(addButton().disabled, true, "the existing 10-site cap disables further additions");
  onChanged(snapshot("en", undefined, { customFeeds: Array.from({ length: 9 }, (_, index) => site(index + 1, "en")), feeds: [] }));
  assert.equal(addButton().disabled, false, "removing a site frees a slot");
});
