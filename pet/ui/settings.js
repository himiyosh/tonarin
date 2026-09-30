/**
 * Settings window. Every control reads from the settings snapshot the main process sends and writes back
 * through window.pet.settings.set(); the pet window receives the same snapshot and applies changes live.
 * The Gemini API key is write-only here: it goes to the main process (keychain) and is never read back.
 */
import { CHARACTERS, characterName } from "./characters.js";
import { applyI18n, getLanguage, PLATFORM, setLanguage, t } from "./i18n.js";
import { loadSprite } from "./sprite.js";

const api = window.pet.settings;
const nav = document.getElementById("nav");
const content = document.getElementById("content");

const SECTIONS = ["general", "character", "voice", "automations", "mcp", "news", "connection", "usage", "about"];
const ICONS = {
  general: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/><circle cx="12" cy="12" r="7.2"/></svg>',
  character: '<svg viewBox="0 0 24 24"><path d="M12 5c5 0 8 3.6 8 8.2S16.6 20 12 20s-8-2.2-8-6.8S7 5 12 5z"/><path d="M12 5c0-1.6.8-2.6 2.2-3"/><circle cx="9.3" cy="12.5" r=".9"/><circle cx="14.7" cy="12.5" r=".9"/></svg>',
  voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  automations: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 2.2M9.5 2.8h5M19 5.5l1.5 1.5"/></svg>',
  mcp: '<svg viewBox="0 0 24 24"><path d="M9 2.8v4.4M15 2.8v4.4M6.5 7.2h11v3.3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v5.2"/></svg>',
  news: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="14" height="15" rx="2"/><path d="M17.5 8.5h2a1 1 0 0 1 1 1v8a2 2 0 0 1-2 2M7 9h7M7 12.5h7M7 16h4"/></svg>',
  connection: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>',
  usage: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.3c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 1.9 0 1.2 1.1 1.7 2.6 2s2.6.8 2.6 2-1.1 2-2.6 2c-1.2 0-2.2-.6-2.7-1.5M12 6.1v1.8M12 16.1v1.8"/></svg>',
  about: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/></svg>',
};
const OSS = ["Electron", "ws", "@github/copilot-sdk", "@modelcontextprotocol/client", "@mozilla/readability", "linkedom", "robots-parser", "rss-parser", "zod", "tsx", "TypeScript"];

let snap;
let current = SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "general";
let syncers = []; // functions that refresh controls from the latest snapshot without rebuilding them
let codexPets = [];
const svgCache = new Map();
const NEWS_CATEGORIES = ["general", "business", "science", "lifestyle", "technology"];
const NEWS_ERRORS = new Set(["url", "address", "dns", "network", "timeout", "http", "size", "redirect", "encoding", "feed", "config", "rights", "duplicate", "limit", "selection"]);
const NEWS_CREDIT_LINKS = {
  "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/": "news-ogl",
  "https://www.nsf.gov/policies/digital": "news-nsf",
  "https://www.digital.go.jp/copyright-policy": "news-digital-policy",
  "https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html": "news-soumu-policy",
  "https://www.pref.osaka.lg.jp/o070050/koho/information/use.html": "news-osaka-policy",
};
let newsFeedback;
let newsMessage;

function newsSay(key, type = "ok", vars = {}) {
  newsFeedback = { key, type, vars };
  if (newsMessage) {
    newsMessage.className = `message ${type}`;
    newsMessage.textContent = t(key, vars);
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers (textContent only: nothing from settings is parsed as HTML)
// ---------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

const sync = (fn) => {
  syncers.push(fn);
  fn();
};
const save = (patch) => api.set(patch).then((next) => onSnapshot(next));

function row(title, desc, ...controls) {
  return el(
    "div",
    { class: "row" },
    el("div", { class: "label" }, el("div", { class: "title", text: title }), desc ? el("div", { class: "desc", text: desc }) : null),
    el("div", { class: "control" }, ...controls),
  );
}

function toggle(key, { disabled = false } = {}) {
  const input = el("input", { type: "checkbox", role: "switch", disabled, onchange: () => save({ [key]: input.checked }) });
  sync(() => (input.checked = Boolean(snap.values[key])));
  return el("label", { class: "switch" }, input, el("span", { class: "track" }));
}

function select(key, options, { onChange } = {}) {
  const node = el(
    "select",
    { onchange: () => (onChange ? onChange(node.value) : save({ [key]: parseValue(node.value) })) },
    options.map(([value, label]) => el("option", { value: String(value), text: label })),
  );
  sync(() => (node.value = String(snap.values[key])));
  return node;
}
const parseValue = (value) => (/^\d+$/.test(value) ? Number(value) : value);

function range(key, { min, max, step, format, toValue = (v) => v, fromValue = (v) => v }) {
  const output = el("output");
  let timer;
  const input = el("input", {
    type: "range",
    min: String(min),
    max: String(max),
    step: String(step),
    oninput: () => {
      output.textContent = format(Number(input.value));
      clearTimeout(timer);
      timer = setTimeout(() => save({ [key]: toValue(Number(input.value)) }), 120);
    },
  });
  sync(() => {
    if (document.activeElement === input) return;
    input.value = String(fromValue(snap.values[key]));
    output.textContent = format(Number(input.value));
  });
  return el("div", { class: "range" }, input, output);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function sectionGeneral() {
  const idleOptions = [0, 5, 10, 15, 30, 60].map((n) => [n, n === 0 ? t("general.idleOff") : t("general.minutes", { n })]);
  return [
    el("h1", { text: t("general.title") }),
    el(
      "div",
      { class: "group" },
      row(
        t("general.language"),
        t("general.languageDesc"),
        select("language", [
          ["auto", t("lang.auto")],
          ["ja", t("lang.ja")],
          ["en", t("lang.en")],
        ]),
      ),
    ),
    el("h2", { text: t("general.groupBubble") }),
    el(
      "div",
      { class: "group" },
      row(t("general.captions"), t("general.captionsDesc"), toggle("captions")),
      row(t("general.showYou"), t("general.showYouDesc"), toggle("showYou")),
    ),
    el("h2", { text: t("general.groupBehavior") }),
    el(
      "div",
      { class: "group" },
      row(t("general.idle"), t("general.idleDesc"), select("idleMinutes", idleOptions)),
      row(t("general.echoGuard"), t("general.echoGuardDesc"), toggle("echoGuard")),
      row(t("general.login"), snap.isPackaged ? t("general.loginDesc") : t("general.loginDev"), toggle("launchAtLogin", { disabled: !snap.isPackaged })),
    ),
  ];
}

function characterCard(id, name, fill) {
  const preview = el("div", { class: "preview" });
  const card = el(
    "button",
    { class: "char-card", type: "button", onclick: () => save({ character: id }) },
    preview,
    el("div", { class: "name", text: name, title: name }),
  );
  sync(() => {
    const selected = snap.values.character === id;
    card.setAttribute("aria-pressed", String(selected));
    card.querySelector(".in-use")?.remove();
    if (selected) card.append(el("span", { class: "in-use", text: t("character.selected") }));
  });
  void fill(preview);
  return card;
}

async function svgPreview(id, target) {
  if (!svgCache.has(id)) svgCache.set(id, fetch(`characters/${id}.svg`).then((r) => r.text()));
  target.innerHTML = await svgCache.get(id); // our own bundled files
}

function sectionCharacter() {
  const language = getLanguage();
  const builtin = el(
    "div",
    { class: "gallery" },
    CHARACTERS.map((c) => characterCard(c.id, characterName(c, language), (target) => svgPreview(c.id, target))),
  );
  const codexGallery = el("div", { class: "gallery" });
  const message = el("div", { class: "message" });
  const fillCodex = () => {
    codexGallery.replaceChildren(
      ...(codexPets.length
        ? codexPets.map((pet) =>
            characterCard(pet.id, pet.name, async (target) => {
              const player = await loadSprite(target, pet.url, 92);
              player.update(0, 0, { paused: true });
            }),
          )
        : [el("div", { class: "empty", text: t("character.codexEmpty") })]),
    );
  };
  fillCodex();
  void window.pet.codexPets().then((pets) => {
    codexPets = Array.isArray(pets) ? pets : [];
    fillCodex();
  });

  return [
    el("h1", { text: t("character.title") }),
    el("h2", { text: t("character.builtin") }),
    el("div", { class: "group" }, builtin),
    el("h2", { text: t("character.codex") }),
    el("p", { class: "lead", text: t("character.codexDesc") }),
    el(
      "div",
      { class: "group" },
      codexGallery,
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "actions" },
          el("button", { class: "btn", type: "button", text: t("character.find"), onclick: () => api.open("pet-gallery") }),
          el("button", {
            class: "btn primary",
            type: "button",
            text: t("character.add"),
            onclick: async () => {
              message.className = "message";
              message.textContent = "";
              const result = await api.installPet();
              if (result?.canceled) return;
              if (result?.ok) {
                codexPets = await window.pet.codexPets();
                fillCodex();
                message.className = "message ok";
                message.textContent = t("character.added", { name: result.name });
              } else {
                message.className = "message error";
                message.textContent = t("character.addFailed", { message: result?.message ?? "" });
              }
            },
          }),
          el("button", { class: "btn", type: "button", text: t("character.openFolder"), onclick: () => api.open("pets-folder") }),
        ),
        message,
      ),
    ),
    el("h2", { text: t("character.size") }),
    el(
      "div",
      { class: "group" },
      row(
        t("character.size"),
        t("character.sizeDesc"),
        range("scale", {
          min: 50,
          max: 200,
          step: 5,
          format: (v) => `${v}%`,
          toValue: (v) => v / 100,
          fromValue: (v) => Math.round(v * 100),
        }),
      ),
    ),
  ];
}

function sectionVoice() {
  const language = getLanguage();
  const persona = el("textarea", { rows: 5, maxLength: 2000, placeholder: t("voice.personaPlaceholder") });
  let personaTimer;
  persona.addEventListener("input", () => {
    clearTimeout(personaTimer);
    personaTimer = setTimeout(() => save({ persona: persona.value }), 800);
  });
  sync(() => {
    if (document.activeElement !== persona) persona.value = snap.values.persona;
  });
  return [
    el("h1", { text: t("voice.title") }),
    el("p", { class: "lead", text: t("voice.appliedNote") }),
    el(
      "div",
      { class: "group" },
      row(
        t("voice.speechLanguage"),
        t("voice.speechLanguageDesc"),
        select("speechLanguage", [
          ["auto", t("voice.speechAuto")],
          ["ja", t("lang.ja")],
          ["en", t("lang.en")],
        ]),
      ),
      row(
        t("voice.voice"),
        t("voice.voiceDesc"),
        select(
          "voice",
          snap.catalog.voices.map((voice) => [voice.id, `${voice.id} (${voice.style[language] ?? voice.style.en})`]),
        ),
      ),
      row(
        t("voice.silence"),
        t("voice.silenceDesc"),
        range("silenceMs", { min: 300, max: 1500, step: 50, format: (v) => `${v} ms` }),
      ),
      row(
        t("voice.noiseFilter"),
        t("voice.noiseFilterDesc"),
        select("noiseFilter", [
          ["light", t("voice.noiseLight")],
          ["standard", t("voice.noiseStandard")],
          ["strong", t("voice.noiseStrong")],
        ]),
      ),
    ),
    el("h2", { text: t("voice.persona") }),
    el(
      "div",
      { class: "group" },
      el(
        "div",
        { class: "row stack" },
        el("div", { class: "label" }, el("div", { class: "desc", text: t("voice.personaDesc") })),
        persona,
        el("div", { class: "actions" }, el("button", { class: "btn", type: "button", text: t("voice.personaReset"), onclick: () => save({ persona: "" }) })),
      ),
    ),
    el("h2", { text: "GitHub Copilot" }),
    el("div", { class: "group" }, row(t("voice.copilot"), t("voice.copilotDesc"), toggle("useCopilot"))),
  ];
}

function sectionNews() {
  const allFeeds = () => [...snap.catalog.feeds, ...snap.values.customFeeds];
  const enabled = () => snap.values.feeds ?? [
    ...snap.catalog.defaultFeeds[snap.speechLanguage],
    ...snap.values.customFeeds.filter((feed) => feed.language === snap.speechLanguage).map((feed) => feed.id),
  ];
  const inputs = [];
  const unavailable = new Set();
  let saving = false;
  const updateSelection = async (next) => {
    if (saving) return;
    if (next !== null && next.length > 30) {
      newsSay("news.error.selection", "error");
      for (const fn of syncers) fn();
      return;
    }
    saving = true;
    for (const input of inputs) input.disabled = true;
    try {
      onSnapshot(await api.set({ feeds: next }));
      newsSay("news.updated");
    } catch {
      newsSay("news.changeFailed", "error");
      onSnapshot(await api.get());
    } finally {
      saving = false;
      for (const input of inputs) input.disabled = unavailable.has(input);
      for (const fn of syncers) fn();
    }
  };
  const selection = (ids, checked) => {
    const chosen = new Set(enabled());
    for (const id of ids) checked ? chosen.add(id) : chosen.delete(id);
    return allFeeds().map((feed) => feed.id).filter((id) => chosen.has(id));
  };
  const feedRow = (feed) => {
    const input = el("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": t("news.toggle", { name: feed.name }),
      onchange: () => void updateSelection(selection([feed.id], input.checked)),
    });
    inputs.push(input);
    sync(() => (input.checked = enabled().includes(feed.id)));
    const details = [
      t(`news.category.${feed.category}`),
      "siteHost" in feed ? t("news.siteHost", { host: feed.siteHost }) : feed.hosts.join(", "),
      ...(!("siteHost" in feed) && feed.articleAccess === "feed-only" ? [t("news.feedOnly")] : []),
      ...("siteHost" in feed && new URL(feed.url).hostname !== feed.siteHost
        ? [t("news.feedHost", { host: new URL(feed.url).hostname })] : []),
    ].join(" · ");
    const controls = [el("label", { class: "switch" }, input, el("span", { class: "track" }))];
    if ("siteHost" in feed) {
      controls.push(el("button", {
        class: "btn small danger",
        type: "button",
        text: t("news.remove"),
        "aria-label": `${t("news.remove")} ${feed.name}`,
        onclick: async (event) => {
          if (!window.confirm(t("news.removeConfirm", { name: feed.name }))) return;
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await api.news.remove(feed.id);
            if (result.ok) newsFeedback = { key: "news.removed", type: "ok", vars: { name: feed.name } };
            if (result.snapshot) onSnapshot(result.snapshot);
            if (!result.ok) newsSay(result.saved ? "news.applyFailed" : "news.changeFailed", "error");
          } catch {
            newsSay("news.changeFailed", "error");
          } finally {
            button.disabled = false;
          }
        },
      }));
    }
    return row(feed.name, details, ...controls);
  };
  const categoryRow = (category) => {
    const feeds = allFeeds().filter((feed) => feed.category === category);
    const count = el("div", { class: "desc" });
    const input = el("input", {
      type: "checkbox",
      role: "switch",
      disabled: feeds.length === 0,
      "aria-label": t(`news.category.${category}`),
      onchange: () => void updateSelection(selection(feeds.map((feed) => feed.id), input.checked)),
    });
    if (!feeds.length) unavailable.add(input);
    inputs.push(input);
    sync(() => {
      const selected = feeds.filter((feed) => enabled().includes(feed.id)).length;
      input.checked = feeds.length > 0 && selected === feeds.length;
      input.indeterminate = selected > 0 && selected < feeds.length;
      count.textContent = t("news.categoryCount", { selected, total: feeds.length });
    });
    return el("div", { class: "row" },
      el("div", { class: "label" }, el("div", { class: "title", text: t(`news.category.${category}`) }), count),
      el("div", { class: "control" }, el("label", { class: "switch" }, input, el("span", { class: "track" }))),
    );
  };
  const builtInRows = (language) => {
    const feeds = snap.catalog.feeds.filter((feed) => feed.language === language);
    return [
      ...feeds.map(feedRow),
      ...NEWS_CATEGORIES.filter((category) => !feeds.some((feed) => feed.category === category)).map((category) => {
        const emptyRow = row(t(`news.category.${category}`), t("news.noCandidates"));
        emptyRow.dataset.newsEmptyCategory = category;
        return emptyRow;
      }),
    ];
  };
  const defaultsNote = el("div", { class: "notice info", text: t("news.usingDefaults") });
  sync(() => (defaultsNote.hidden = snap.values.feeds !== null));
  const empty = el("div", { class: "notice warn news-empty", text: t("news.empty") });
  sync(() => (empty.hidden = enabled().length !== 0));
  const syncNotice = el("div", { class: "notice warn" });
  const syncReason = el("div");
  const retry = el("button", {
    class: "btn small",
    type: "button",
    text: t("news.retry"),
    onclick: async () => {
      retry.disabled = true;
      retry.textContent = t("news.retrying");
      try {
        const result = await api.news.sync();
        if (result.snapshot) onSnapshot(result.snapshot);
        newsSay(result.ok ? "news.synced" : "news.applyFailed", result.ok ? "ok" : "error");
      } catch {
        newsSay("news.applyFailed", "error");
      } finally {
        retry.disabled = false;
        retry.textContent = t("news.retry");
      }
    },
  });
  syncNotice.append(el("div", { text: t("news.applyFailed") }), syncReason, retry);
  sync(() => {
    syncNotice.hidden = !snap.newsSyncError;
    syncReason.textContent = NEWS_ERRORS.has(snap.newsSyncCode) ? t(`news.error.${snap.newsSyncCode}`) : "";
  });
  newsMessage = el("div", { class: "message", role: "status", "aria-live": "polite" });
  sync(() => {
    if (newsFeedback) newsSay(newsFeedback.key, newsFeedback.type, newsFeedback.vars);
  });
  const url = el("input", {
    type: "url", class: "news-url", maxlength: "2048", required: true, spellcheck: false, autocomplete: "url",
    placeholder: t("news.sitePlaceholder"), "aria-label": t("news.siteUrl"),
  });
  const language = el("select", { "aria-label": t("news.siteLanguage") },
    ["ja", "en"].map((id) => el("option", { value: id, text: t(`lang.${id}`) })));
  language.value = snap.speechLanguage;
  const category = el("select", { "aria-label": t("news.siteCategory") },
    NEWS_CATEGORIES.map((id) => el("option", { value: id, text: t(`news.category.${id}`) })));
  const addButton = el("button", {
    class: "btn primary", type: "button", text: t("news.add"),
    onclick: async () => {
      if (!/^https:\/\//i.test(url.value.trim()) || !url.checkValidity()) {
        newsSay("news.error.url", "error");
        url.focus();
        return;
      }
      addButton.disabled = true;
      addButton.textContent = t("news.adding");
      try {
        const result = await api.news.add({ url: url.value.trim(), language: language.value, category: category.value });
        if (result.ok) newsFeedback = { key: "news.added", type: "ok", vars: { name: result.feed.name } };
        if (result.snapshot) onSnapshot(result.snapshot);
        if (!result.ok) {
          const key = NEWS_ERRORS.has(result.code) ? `news.error.${result.code}` : "news.addFailed";
          newsSay(result.saved ? "news.applyFailed" : key, "error", { message: result.message ?? "" });
        }
      } catch (error) {
        newsSay("news.addFailed", "error", { message: error instanceof Error ? error.message : String(error) });
      } finally {
        addButton.disabled = false;
        addButton.textContent = t("news.add");
      }
    },
  });
  const credits = [...new Map(snap.catalog.feeds.filter((feed) => feed.attribution)
    .map((feed) => [feed.attribution.url, feed.attribution])).values()];
  return [
    el("h1", { text: t("news.title") }),
    el("p", { class: "lead", text: t("news.desc") }),
    defaultsNote,
    syncNotice,
    empty,
    el("h2", { text: t("news.categories") }),
    el("p", { class: "lead small", text: t("news.categoryDesc") }),
    el("div", { class: "group" }, NEWS_CATEGORIES.map(categoryRow)),
    el("h2", { text: t("news.addTitle") }),
    el("p", { class: "lead small", text: t("news.addDesc") }),
    el("div", { class: "group" },
      el("div", { class: "row stack" },
        el("label", { class: "title", text: t("news.siteUrl") }, url),
        el("div", { class: "news-add-controls" }, language, category, addButton),
        newsMessage,
      )),
    el("p", { class: "lead small news-host-note", text: t("news.hostLimit") }),
    el("h2", { text: t("news.custom") }),
    el("div", { class: "group" },
      snap.values.customFeeds.length ? snap.values.customFeeds.map(feedRow) : el("div", { class: "empty", text: t("news.customEmpty") })),
    el("h2", { text: t("news.ja") }),
    el("div", { class: "group" }, builtInRows("ja")),
    el("h2", { text: t("news.en") }),
    el("div", { class: "group" }, builtInRows("en")),
    ...(credits.length ? [
      el("h2", { text: t("news.credits") }),
      el("div", { class: "group" }, credits.map((credit) =>
        row(credit.text, null,
          NEWS_CREDIT_LINKS[credit.url]
            ? el("button", { class: "link", type: "button", text: t("news.policy"), onclick: () => api.open(NEWS_CREDIT_LINKS[credit.url]) })
            : null),
      )),
    ] : []),
    el("div", { class: "actions spaced" }, el("button", { class: "btn", type: "button", text: t("news.reset"), onclick: () => void updateSelection(null) })),
  ];
}

function sectionConnection() {
  const status = el("span", { class: "pill" });
  const onboarding = el("div", { class: "notice warn", text: t("connection.onboarding") });
  const keyInput = el("input", { type: "password", class: "key", placeholder: t("connection.keyPlaceholder"), autocomplete: "off", spellcheck: false });
  const message = el("div", { class: "message" });
  const removeButton = el("button", {
    class: "btn danger",
    type: "button",
    text: t("connection.remove"),
    onclick: async () => {
      await api.clearGeminiKey();
      onSnapshot(await api.get());
    },
  });
  const say = (text, kind = "") => {
    message.className = `message ${kind}`.trim();
    message.textContent = text;
  };
  sync(() => {
    const source = snap.gemini.source;
    status.className = `pill ${source === "none" ? "off" : source === "env" ? "warn" : "ok"}`;
    status.textContent =
      source === "keychain" ? t("connection.statusKeychain") : source === "env" ? t("connection.statusEnv") : t("connection.statusNone");
    onboarding.hidden = source !== "none";
    removeButton.hidden = source !== "keychain";
  });

  // What the proxy reports: Copilot is optional (no license, or not signed in, is fine).
  const copilotStatus = el("span", { class: "pill" });
  const copilotHint = el("div", { class: "notice info spaced", text: t("connection.copilotSignIn") });
  const COPILOT_PILLS = {
    ready: ["ok", "connection.copilotReady"],
    starting: ["warn", "connection.copilotStarting"],
    "signed-out": ["warn", "connection.copilotSignedOut"],
    unavailable: ["off", "connection.copilotUnavailable"],
  };
  sync(() => {
    const state = snap.proxy.status?.copilot;
    const pill = COPILOT_PILLS[state];
    copilotStatus.hidden = !pill;
    if (pill) {
      copilotStatus.className = `pill ${pill[0]}`;
      copilotStatus.textContent = t(pill[1]);
    }
    copilotHint.hidden = state !== "signed-out" && state !== "unavailable";
  });

  const proxyStatus = el("span", { class: "pill" });
  const restartButton = el("button", {
    class: "btn",
    type: "button",
    text: t("connection.restart"),
    onclick: async () => {
      restartButton.disabled = true;
      await api.restartProxy();
      restartButton.disabled = false;
    },
  });
  sync(() => {
    const proxy = snap.proxy;
    proxyStatus.className = `pill ${proxy.running ? "ok" : "off"}`;
    proxyStatus.textContent = proxy.running
      ? t(proxy.managed ? "connection.proxyManaged" : "connection.proxyExternal", { port: proxy.port })
      : t("connection.proxyStopped");
    restartButton.disabled = !proxy.managed;
  });

  return [
    el("h1", { text: t("connection.title") }),
    onboarding,
    el("h2", { text: t("connection.gemini") }),
    el(
      "div",
      { class: "group" },
      row(t("connection.gemini"), t("connection.geminiDesc"), status),
      el(
        "div",
        { class: "row stack" },
        el(
          "div",
          { class: "actions" },
          keyInput,
          el("button", {
            class: "btn primary",
            type: "button",
            text: t("connection.save"),
            onclick: async () => {
              const result = await api.setGeminiKey(keyInput.value);
              if (!result?.ok) {
                say(t("connection.testFailed", { message: result?.message ?? "" }), "error");
                return;
              }
              keyInput.value = "";
              say(t("connection.saved"), "ok");
              onSnapshot(await api.get());
            },
          }),
          el("button", {
            class: "btn",
            type: "button",
            text: t("connection.test"),
            onclick: async () => {
              say(t("connection.testing"));
              const result = await api.testGeminiKey(keyInput.value);
              if (result?.ok) say(t("connection.testOk"), "ok");
              else say(t("connection.testFailed", { message: result?.message ?? "" }), "error");
            },
          }),
          removeButton,
        ),
        message,
        el("div", { class: "actions" }, el("button", { class: "link", type: "button", text: t("connection.getKey"), onclick: () => api.open("ai-studio") })),
      ),
    ),
    el("div", { class: "notice warn spaced", text: t("connection.freeTier") }),
    el("h2", { text: t("connection.proxy") }),
    el(
      "div",
      { class: "group" },
      row(t("connection.proxy"), t("connection.proxyDesc"), proxyStatus),
      el(
        "div",
        { class: "row" },
        el(
          "div",
          { class: "actions" },
          restartButton,
          el("button", { class: "btn", type: "button", text: t("connection.reconnect"), onclick: () => api.reconnect() }),
          el("button", { class: "btn", type: "button", text: t("connection.logs"), onclick: () => api.open("logs") }),
        ),
      ),
    ),
    el("h2", { text: t("connection.copilot") }),
    el("div", { class: "group" }, row(t("connection.copilot"), t("connection.copilotDesc"), copilotStatus, toggle("useCopilot"))),
    copilotHint,
  ];
}

function sectionAbout() {
  return [
    el(
      "div",
      { class: "about-head" },
      el("img", { src: "app-icon.png", width: "64", height: "64", alt: "" }),
      el(
        "div",
        {},
        el("h1", { text: snap.appName }),
        el("div", { class: "versions", text: t("about.version", { version: snap.version }) }),
        el("div", { class: "versions", text: `Electron ${snap.versions.electron} · Chromium ${snap.versions.chrome} · Node ${snap.versions.node}` }),
      ),
    ),
    el("h2", { text: t("about.privacy") }),
    el(
      "div",
      { class: "group" },
      el(
        "ul",
        { class: "plain" },
        ["about.privacyVoice", "about.privacyCopilot", "about.privacyApps", "about.privacyNews", "about.privacyLocal", "about.pets"].map((key) => el("li", { text: t(key) })),
      ),
    ),
    el("h2", { text: t("about.oss") }),
    el("div", { class: "group" }, el("div", { class: "oss" }, OSS.map((name) => el("span", { text: name }))), el("div", { class: "row" }, el("div", { class: "label" }, el("div", { class: "desc", text: t("about.ossDesc") })))),
  ];
}

// ---------------------------------------------------------------------------
// Automations (kept in the proxy; the app relays, so this page never holds the proxy key)
// ---------------------------------------------------------------------------
const autoApi = api.automations;
let autoData = { automations: [], history: [], copilot: undefined };
let autoError = "";
let editing = null; // the automation being edited (a draft), or null
let autoRefs = {};
const expanded = new Set(); // history entries shown in full

const TEMPLATES = {
  briefing: { trigger: { type: "daily", time: "08:30", days: [1, 2, 3, 4, 5] }, engine: "pet" },
  research: { trigger: { type: "daily", time: "09:00", days: [1] }, engine: "copilot" },
  break: { trigger: { type: "interval", everyMinutes: 60, from: "10:00", to: "18:00", days: [1, 2, 3, 4, 5] }, engine: "pet" },
  keyword: { trigger: { type: "keyword", keywords: ["Copilot", "Gemini"], everyMinutes: 30 }, engine: "pet" },
  blank: { trigger: { type: "daily", time: "12:00", days: [0, 1, 2, 3, 4, 5, 6] }, engine: "pet" },
};

function draftFrom(template) {
  const base = TEMPLATES[template];
  return {
    name: template === "blank" ? "" : t(`auto.tpl.${template}`),
    prompt: template === "blank" ? "" : t(`auto.tpl.${template}Prompt`),
    engine: base.engine,
    enabled: true,
    language: snap.speechLanguage,
    trigger: structuredClone(base.trigger),
  };
}

async function loadAutomations() {
  const result = await autoApi.list();
  if (result?.ok) {
    autoData = result.data;
    autoError = "";
  } else {
    autoError = t("auto.proxyDown");
  }
  renderAutomations();
}

const formatWhen = (time) =>
  new Date(time).toLocaleString(getLanguage() === "ja" ? "ja-JP" : "en-US", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });

function automationRow(automation) {
  const enabled = el("input", {
    type: "checkbox",
    role: "switch",
    checked: automation.enabled,
    "aria-label": automation.name,
    onchange: async () => {
      await autoApi.save({ ...automation, enabled: enabled.checked });
      void loadAutomations();
    },
  });
  let confirming = false;
  const remove = el("button", {
    class: "btn danger",
    type: "button",
    text: t("auto.delete"),
    onclick: async () => {
      if (!confirming) {
        confirming = true;
        remove.textContent = t("auto.confirmDelete");
        setTimeout(() => {
          confirming = false;
          remove.textContent = t("auto.delete");
        }, 4000);
        return;
      }
      await autoApi.remove(automation.id);
      if (editing?.id === automation.id) editing = null;
      void loadAutomations();
    },
  });
  const badge = el("span", { class: `tag ${automation.engine}`, text: t(automation.engine === "copilot" ? "auto.engineCopilotBadge" : "auto.enginePetBadge") });
  const next = automation.enabled
    ? automation.nextRunAt
      ? t("auto.next", { time: formatWhen(automation.nextRunAt) })
      : ""
    : t("auto.paused");
  return el(
    "div",
    { class: "row auto-row" },
    el(
      "div",
      { class: "label" },
      el("div", { class: "title" }, el("span", { text: automation.name }), " ", badge),
      el("div", { class: "desc", text: [automation.when, next].filter(Boolean).join(" · ") }),
    ),
    el(
      "div",
      { class: "control" },
      el("button", {
        class: "btn",
        type: "button",
        text: t("auto.runNow"),
        onclick: async () => {
          await autoApi.run(automation.id);
          say(t("auto.started"), "ok");
        },
      }),
      el("button", {
        class: "btn",
        type: "button",
        text: t("auto.edit"),
        onclick: () => {
          editing = structuredClone(automation);
          renderAutomations();
          autoRefs.editor?.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      }),
      remove,
      el("label", { class: "switch" }, enabled, el("span", { class: "track" })),
    ),
  );
}

function say(text, kind = "") {
  if (!autoRefs.message) return;
  autoRefs.message.className = `message ${kind}`.trim();
  autoRefs.message.textContent = text;
}

function field(label, desc, ...controls) {
  return el(
    "div",
    { class: "row stack" },
    el("div", { class: "label" }, el("div", { class: "title", text: label }), desc ? el("div", { class: "desc", text: desc }) : null),
    el("div", { class: "actions" }, ...controls),
  );
}

function minutesSelect(value, choices, onChange) {
  const node = el(
    "select",
    { onchange: () => onChange(Number(node.value)) },
    choices.map((n) => el("option", { value: String(n), text: t("auto.minutes", { n }) })),
  );
  if (!choices.includes(value)) node.prepend(el("option", { value: String(value), text: t("auto.minutes", { n: value }) }));
  node.value = String(value);
  return node;
}

function daysPicker(trigger) {
  const names = t("auto.dayNames").split(",");
  const boxes = names.map((name, day) => {
    const input = el("input", { type: "checkbox", checked: trigger.days.includes(day) });
    input.addEventListener("change", () => {
      const set = new Set(trigger.days);
      if (input.checked) set.add(day);
      else set.delete(day);
      trigger.days = [...set].sort();
    });
    return el("label", { class: "day" }, input, el("span", { text: name }));
  });
  const preset = (days) => () => {
    trigger.days = days;
    boxes.forEach((box, day) => (box.querySelector("input").checked = days.includes(day)));
  };
  return [
    el("div", { class: "days" }, boxes),
    el("button", { class: "link", type: "button", text: t("auto.daysAll"), onclick: preset([0, 1, 2, 3, 4, 5, 6]) }),
    el("button", { class: "link", type: "button", text: t("auto.daysWeekdays"), onclick: preset([1, 2, 3, 4, 5]) }),
    el("button", { class: "link", type: "button", text: t("auto.daysWeekends"), onclick: preset([0, 6]) }),
  ];
}

function timeInput(value, onChange) {
  return el("input", { type: "time", value, class: "time", onchange: (event) => onChange(event.target.value) });
}

function renderEditor() {
  const draft = editing;
  const box = el("div", { class: "group editor" });
  if (!draft) return box;
  const trigger = draft.trigger;
  const name = el("input", { type: "text", class: "wide", value: draft.name, maxLength: 60, oninput: () => (draft.name = name.value) });
  const kind = el(
    "select",
    {
      onchange: () => {
        const defaults = {
          daily: TEMPLATES.blank.trigger,
          interval: TEMPLATES.break.trigger,
          keyword: { type: "keyword", keywords: [], everyMinutes: 30 },
        };
        draft.trigger = structuredClone(defaults[kind.value]);
        renderAutomations();
      },
    },
    [
      ["daily", t("auto.whenDaily")],
      ["interval", t("auto.whenInterval")],
      ["keyword", t("auto.whenKeyword")],
    ].map(([value, label]) => el("option", { value, text: label })),
  );
  kind.value = trigger.type;
  const prompt = el("textarea", { rows: 4, maxLength: 1000, oninput: () => (draft.prompt = prompt.value) });
  prompt.value = draft.prompt; // a textarea's text is its value property, not an attribute
  const engine = el(
    "select",
    { onchange: () => (draft.engine = engine.value) },
    [
      ["pet", t("auto.enginePet")],
      ["copilot", t("auto.engineCopilot")],
    ].map(([value, label]) => el("option", { value, text: label })),
  );
  engine.value = draft.engine;

  const whenFields = [];
  if (trigger.type === "daily") {
    whenFields.push(field(t("auto.time"), "", timeInput(trigger.time, (v) => (trigger.time = v))));
    whenFields.push(field(t("auto.days"), "", ...daysPicker(trigger)));
  } else if (trigger.type === "interval") {
    whenFields.push(field(t("auto.every"), "", minutesSelect(trigger.everyMinutes, [15, 30, 45, 60, 90, 120, 180, 240], (v) => (trigger.everyMinutes = v))));
    whenFields.push(
      field(t("auto.window"), "", timeInput(trigger.from, (v) => (trigger.from = v)), el("span", { text: t("auto.to") }), timeInput(trigger.to, (v) => (trigger.to = v))),
    );
    whenFields.push(field(t("auto.days"), "", ...daysPicker(trigger)));
  } else {
    const keywords = el("input", {
      type: "text",
      class: "wide",
      value: trigger.keywords.join(", "),
      placeholder: t("auto.keywordsPlaceholder"),
      oninput: () => (trigger.keywords = keywords.value.split(/[,、，]/).map((k) => k.trim()).filter(Boolean)),
    });
    whenFields.push(field(t("auto.keywords"), t("auto.keywordsDesc"), keywords));
    whenFields.push(field(t("auto.checkEvery"), "", minutesSelect(trigger.everyMinutes, [15, 30, 60, 120, 240], (v) => (trigger.everyMinutes = v))));
  }

  const message = el("div", { class: "message" });
  box.append(
    el("div", { class: "row editor-head" }, el("div", { class: "label" }, el("div", { class: "title", text: t(draft.id ? "auto.editorEdit" : "auto.editorNew") }))),
    field(t("auto.name"), "", name),
    field(t("auto.when"), "", kind),
    ...whenFields,
    field(t("auto.prompt"), t(trigger.type === "keyword" ? "auto.promptKeywordDesc" : "auto.promptDesc"), prompt),
    field(t("auto.engine"), t("auto.engineDesc"), engine),
    el(
      "div",
      { class: "row stack" },
      el(
        "div",
        { class: "actions" },
        el("button", {
          class: "btn primary",
          type: "button",
          text: t("auto.save"),
          onclick: async () => {
            const result = await autoApi.save(draft);
            if (!result?.ok) {
              message.className = "message error";
              message.textContent = result?.message ?? "";
              return;
            }
            editing = null;
            await loadAutomations();
            say(t("auto.saved"), "ok");
          },
        }),
        el("button", {
          class: "btn",
          type: "button",
          text: t("auto.cancel"),
          onclick: () => {
            editing = null;
            renderAutomations();
          },
        }),
      ),
      message,
    ),
  );
  return box;
}

function historyItem(entry) {
  const long = entry.text.length > 180 || entry.text.split("\n").length > 3;
  const open = expanded.has(entry.id);
  const text = el("div", { class: `history-text${long && !open ? " clamp" : ""}`, text: entry.text });
  return el(
    "div",
    { class: "row stack history-item" },
    el(
      "div",
      { class: "history-head" },
      el("span", { class: "history-time", text: formatWhen(entry.at) }),
      el("strong", { text: entry.name }),
      el("span", { class: `pill ${{ spoken: "ok", error: "off", missed: "off" }[entry.status] ?? "warn"}`, text: t(`auto.status.${entry.status}`) }),
    ),
    entry.text ? text : null,
    long
      ? el("button", {
          class: "link",
          type: "button",
          text: t(open ? "auto.showLess" : "auto.showMore"),
          onclick: () => {
            if (open) expanded.delete(entry.id);
            else expanded.add(entry.id);
            renderAutomations();
          },
        })
      : null,
  );
}

function renderAutomations() {
  if (!autoRefs.list) return;
  autoRefs.notice.hidden = !autoError && !(autoData.copilot && autoData.copilot !== "ready" && autoData.copilot !== "starting");
  autoRefs.notice.textContent = autoError || t("auto.copilotMissing");
  autoRefs.list.replaceChildren(
    ...(autoData.automations.length ? autoData.automations.map(automationRow) : [el("div", { class: "empty", text: t("auto.empty") })]),
  );
  autoRefs.editor.replaceWith((autoRefs.editor = renderEditor()));
  autoRefs.editor.hidden = !editing;
  autoRefs.history.replaceChildren(
    ...(autoData.history.length ? autoData.history.map(historyItem) : [el("div", { class: "empty", text: t("auto.historyEmpty") })]),
  );
}

function sectionAutomations() {
  autoRefs = {
    notice: el("div", { class: "notice warn", hidden: true }),
    message: el("div", { class: "message" }),
    list: el("div", { class: "group" }),
    editor: el("div", { class: "group editor", hidden: true }),
    history: el("div", { class: "group" }),
  };
  const templates = ["briefing", "research", "break", "keyword", "blank"].map((id) =>
    el("button", {
      class: "chip",
      type: "button",
      text: t(`auto.tpl.${id}`),
      onclick: () => {
        editing = draftFrom(id);
        renderAutomations();
        autoRefs.editor.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    }),
  );
  queueMicrotask(() => void loadAutomations());
  return [
    el("h1", { text: t("auto.title") }),
    el("p", { class: "lead", text: t("auto.lead") }),
    autoRefs.notice,
    el("h2", { text: t("auto.templates") }),
    el("div", { class: "chips" }, templates),
    el("h2", { text: t("auto.list") }),
    autoRefs.list,
    autoRefs.message,
    autoRefs.editor,
    el(
      "div",
      { class: "section-head" },
      el("h2", { text: t("auto.history") }),
      el("button", {
        class: "link",
        type: "button",
        text: t("auto.clearHistory"),
        onclick: async () => {
          await autoApi.clearHistory();
          void loadAutomations();
        },
      }),
    ),
    el("p", { class: "lead small", text: t("auto.historyDesc") }),
    autoRefs.history,
  ];
}

// ---------------------------------------------------------------------------
// Connected apps (MCP). The list is in the settings without secrets: env values and headers (tokens) go to the
// keychain through main and never come back to this page. The proxy reports connection states and tools.
// ---------------------------------------------------------------------------
const mcpApi = api.mcp;
let mcpData = { servers: [], status: null };
let mcpEditing = null; // a draft, or null
let mcpRefs = {};
const mcpOpen = new Set(); // servers whose tool list is shown
const mcpResults = new Map(); // "server/tool" -> { error, text } from the try button

const MCP_PRESETS = {
  calendar: { transport: "stdio", command: "~/bin/CheICalMCP", link: "che-ical", only: "darwin" }, // the Mac Calendar app
  learn: { transport: "http", url: "https://learn.microsoft.com/api/mcp" },
  github: { transport: "http", url: "https://api.githubcopilot.com/mcp/", token: true, link: "github-token" },
  custom: { transport: "stdio", command: "", link: "mcp-servers" },
};
const MCP_PILLS = { ready: "ok", connecting: "warn", unknown: "warn", off: "idle", error: "off" };

function mcpDraft(preset, server) {
  if (server) {
    return {
      id: server.id,
      preset: server.preset in MCP_PRESETS ? server.preset : "custom",
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command ?? "",
      argsText: (server.args ?? []).join("\n"),
      url: server.url ?? "",
      secretsText: "",
      token: "",
      savedKeys: (server.transport === "http" ? server.headerKeys : server.envKeys) ?? [],
      clearSecrets: false,
      account: server.account ?? "", // signed in with GitHub as this login
      includePrivate: true,
      showToken: false,
    };
  }
  const base = MCP_PRESETS[preset];
  return {
    preset,
    name: preset === "custom" ? "" : t(`mcp.preset.${preset}`),
    enabled: true,
    transport: base.transport,
    command: base.command ?? "",
    argsText: "",
    url: base.url ?? "",
    secretsText: "",
    token: "",
    savedKeys: [],
    clearSecrets: false,
    account: "",
    includePrivate: true,
    showToken: false,
  };
}

// "Sign in with GitHub": main runs the device flow and keeps the token; this page only shows the short code.
let githubAuth = null; // { userCode } while waiting, { error } after a failure

const githubErrorText = (code) => {
  const key = `mcp.github.error.${code}`;
  return t(key) === key ? t("mcp.github.error.generic", { code }) : t(key);
};

async function startGitHubSignIn(draft) {
  githubAuth = { starting: true };
  renderMcp({ rebuildEditor: true });
  const result = await api.github.signIn({
    server: { id: draft.id, name: draft.name, enabled: true },
    includePrivate: draft.includePrivate,
  });
  githubAuth = result?.ok ? { userCode: result.userCode } : { error: result?.message ?? "error" };
  renderMcp({ rebuildEditor: true });
}

function githubBlock(draft) {
  if (githubAuth?.userCode || githubAuth?.starting) {
    return el(
      "div",
      { class: "row stack gh-code" },
      el("div", { class: "desc", text: t(githubAuth.starting ? "mcp.github.starting" : "mcp.github.waiting") }),
      githubAuth.userCode ? el("div", { class: "code", text: githubAuth.userCode }) : null,
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn", type: "button", text: t("mcp.github.reopen"), disabled: !githubAuth.userCode, onclick: () => api.open("github-device") }),
        el("button", {
          class: "btn",
          type: "button",
          text: t("mcp.github.cancel"),
          onclick: async () => {
            await api.github.cancel();
            githubAuth = null;
            renderMcp({ rebuildEditor: true });
          },
        }),
      ),
    );
  }
  if (draft.account && draft.savedKeys.includes("Authorization")) {
    return el(
      "div",
      { class: "row" },
      el("div", { class: "label" }, el("div", { class: "title", text: t("mcp.github.signedIn", { login: draft.account }) })),
      el(
        "div",
        { class: "control" },
        el("button", {
          class: "btn",
          type: "button",
          text: t("mcp.github.signOut"),
          onclick: async () => {
            // Forget the token (and turn the connection off); revoking it for good is done on github.com.
            await mcpApi.save({ server: { id: draft.id, name: draft.name, enabled: false, transport: "http", url: draft.url, preset: "github" }, secrets: { headers: {} } });
            mcpEditing = null;
            await loadMcp();
            mcpSay(t("mcp.github.signedOut"), "ok");
          },
        }),
        el("button", { class: "link", type: "button", text: t("mcp.github.revoke"), onclick: () => api.open("github-authorized-apps") }),
      ),
    );
  }
  const privateBox = el("input", { type: "checkbox", checked: draft.includePrivate, onchange: () => (draft.includePrivate = privateBox.checked) });
  return el(
    "div",
    { class: "row stack" },
    el("label", { class: "check" }, privateBox, el("span", { text: t("mcp.github.private") })),
    el("div", { class: "desc", text: t("mcp.github.privateDesc") }),
    githubAuth?.error ? el("div", { class: "message error", text: githubErrorText(githubAuth.error) }) : null,
    el("div", { class: "actions" }, el("button", { class: "btn primary", type: "button", text: t("mcp.github.signIn"), onclick: () => startGitHubSignIn(draft) })),
  );
}

async function loadMcp() {
  const result = await mcpApi.list();
  if (result) mcpData = result;
  renderMcp();
}

/** "KEY=VALUE" (env) or "Name: value" (headers) lines. Returns the line numbers it could not read, never the values. */
function parsePairs(text, separator) {
  const record = {};
  const bad = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) bad.push(index + 1);
    else record[key] = line.slice(at + 1).trim();
  });
  return { record, bad };
}

async function saveMcpDraft(draft, message) {
  const fail = (key, vars) => {
    message.className = "message error";
    message.textContent = t(key, vars) === key ? String(vars?.fallback ?? key) : t(key, vars);
  };
  const server = {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    transport: draft.transport,
    preset: draft.preset,
    command: draft.command.trim(),
    args: draft.argsText.split("\n").map((a) => a.trim()).filter(Boolean),
    url: draft.url.trim(),
  };
  let secrets = null; // null keeps what is saved
  if (MCP_PRESETS[draft.preset]?.token && draft.transport === "http") {
    const token = draft.token.trim();
    if (token) secrets = { headers: { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true" } };
    else if (!draft.savedKeys.includes("Authorization")) return fail(snap.githubSignIn ? "mcp.error.githubSignIn" : "mcp.error.token");
  } else if (draft.secretsText.trim() || draft.clearSecrets) {
    const { record, bad } = parsePairs(draft.secretsText, draft.transport === "http" ? ":" : "=");
    if (bad.length) return fail("mcp.error.lines", { lines: bad.join(", ") });
    secrets = draft.transport === "http" ? { headers: record } : { env: record };
  }
  const result = await mcpApi.save({ server, secrets });
  if (!result?.ok) return fail(`mcp.error.${result?.message ?? "invalid"}`, { fallback: result?.message });
  draft.token = "";
  draft.secretsText = "";
  mcpEditing = null;
  mcpOpen.add(result.id);
  await loadMcp();
  mcpSay(t("mcp.saved"), "ok");
}

function mcpSay(text, kind = "") {
  if (!mcpRefs.message) return;
  mcpRefs.message.className = `message ${kind}`.trim();
  mcpRefs.message.textContent = text;
}

function mcpToolRow(server, tool) {
  const key = `${server.id}/${tool.name}`;
  const input = el("input", {
    type: "checkbox",
    role: "switch",
    checked: tool.enabled,
    "aria-label": tool.name,
    onchange: async () => {
      tool.enabled = input.checked; // the proxy confirms with a change event
      await mcpApi.setTool(server.id, tool.name, input.checked);
      renderMcp();
    },
  });
  const canTry = tool.kind === "read" && !tool.needsInput && tool.enabled;
  const result = mcpResults.get(key);
  const tryButton = canTry
    ? el("button", {
        class: "btn small",
        type: "button",
        text: t("mcp.try"),
        onclick: async () => {
          tryButton.disabled = true;
          tryButton.textContent = t("mcp.trying");
          const response = await mcpApi.test(server.id, tool.name);
          const data = response?.data?.result;
          mcpResults.set(
            key,
            response?.ok
              ? { error: Boolean(data?.isError), text: String(data?.content ?? "").slice(0, 3000) || "(empty)" }
              : { error: true, text: t("mcp.tryFailed", { message: response?.message ?? "" }) },
          );
          renderMcp();
        },
      })
    : null;
  return el(
    "div",
    { class: "row tool-row" },
    el(
      "div",
      { class: "label" },
      el("div", { class: "title" }, el("code", { text: tool.name }), " ", el("span", { class: `tag ${tool.kind}`, text: t(`mcp.kind.${tool.kind}`) })),
      tool.description ? el("div", { class: "desc clamp2", text: tool.description, title: tool.description }) : null,
      result ? el("pre", { class: `tool-result${result.error ? " error" : ""}`, text: result.text }) : null,
    ),
    el("div", { class: "control" }, tryButton, el("label", { class: "switch" }, input, el("span", { class: "track" }))),
  );
}

function mcpServerCard(server) {
  const status = mcpData.status?.find((s) => s.id === server.id);
  const state = !server.enabled ? "off" : (status?.state ?? "unknown");
  const tools = status?.tools ?? [];
  const on = tools.filter((tool) => tool.enabled).length;
  const open = mcpOpen.has(server.id);
  const enabled = el("input", {
    type: "checkbox",
    role: "switch",
    checked: server.enabled,
    "aria-label": server.name,
    onchange: async () => {
      await mcpApi.enable(server.id, enabled.checked);
      void loadMcp();
    },
  });
  let confirming = false;
  const remove = el("button", {
    class: "btn danger",
    type: "button",
    text: t("mcp.delete"),
    onclick: async () => {
      if (!confirming) {
        confirming = true;
        remove.textContent = t("mcp.confirmDelete");
        setTimeout(() => {
          confirming = false;
          remove.textContent = t("mcp.delete");
        }, 4000);
        return;
      }
      await mcpApi.remove(server.id);
      if (mcpEditing?.id === server.id) mcpEditing = null;
      void loadMcp();
    },
  });
  const where = server.transport === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ");
  return el(
    "div",
    { class: "group mcp-card" },
    el(
      "div",
      { class: "row" },
      el(
        "div",
        { class: "label" },
        el("div", { class: "title" }, el("span", { text: server.name }), " ", el("span", { class: `pill ${MCP_PILLS[state]}`, text: t(`mcp.state.${state}`) })),
        el("div", { class: "desc mcp-where", text: where }),
        status?.error && server.enabled ? el("div", { class: "message error", text: status.error }) : null,
      ),
      el(
        "div",
        { class: "control" },
        el("button", {
          class: "btn",
          type: "button",
          text: t("mcp.reconnect"),
          disabled: !server.enabled,
          onclick: async () => {
            await mcpApi.reconnect(server.id);
            void loadMcp();
          },
        }),
        el("button", {
          class: "btn",
          type: "button",
          text: t("mcp.edit"),
          onclick: () => {
            mcpEditing = mcpDraft(server.preset, server);
            renderMcp();
            mcpRefs.editor?.scrollIntoView({ behavior: "smooth", block: "start" });
          },
        }),
        remove,
        el("label", { class: "switch" }, enabled, el("span", { class: "track" })),
      ),
    ),
    tools.length
      ? el(
          "div",
          { class: "row tools-head" },
          el("button", {
            class: "link",
            type: "button",
            text: `${t(open ? "mcp.hideTools" : "mcp.showTools")} · ${t("mcp.toolsCount", { total: tools.length, on })}`,
            onclick: () => {
              if (open) mcpOpen.delete(server.id);
              else mcpOpen.add(server.id);
              renderMcp();
            },
          }),
        )
      : null,
    open ? tools.map((tool) => mcpToolRow(server, tool)) : null,
  );
}

function renderMcpEditor() {
  const draft = mcpEditing;
  const box = el("div", { class: "group editor" });
  if (!draft) return box;
  const preset = MCP_PRESETS[draft.preset] ?? MCP_PRESETS.custom;
  const usesToken = preset.token && draft.transport === "http";
  const name = el("input", { type: "text", class: "wide", value: draft.name, maxLength: 60, oninput: () => (draft.name = name.value) });
  const fields = [field(t("mcp.name"), "", name)];
  if (draft.preset === "custom") {
    const transport = el(
      "select",
      {
        onchange: () => {
          draft.transport = transport.value;
          draft.secretsText = "";
          renderMcp({ rebuildEditor: true });
        },
      },
      [
        ["stdio", t("mcp.transportStdio")],
        ["http", t("mcp.transportHttp")],
      ].map(([value, label]) => el("option", { value, text: label })),
    );
    transport.value = draft.transport;
    fields.push(field(t("mcp.transport"), "", transport));
  }
  const secretNote = () => {
    if (draft.clearSecrets) return el("div", { class: "message", text: t("mcp.secretsCleared") });
    if (!draft.savedKeys.length) return null;
    return el(
      "div",
      { class: "actions" },
      el("span", { class: "message", text: usesToken ? t("mcp.savedToken") : t("mcp.savedKeys", { keys: draft.savedKeys.join(", ") }) }),
      usesToken
        ? null
        : el("button", {
            class: "link",
            type: "button",
            text: t("mcp.clearSecrets"),
            onclick: () => {
              draft.clearSecrets = true;
              draft.secretsText = "";
              renderMcp({ rebuildEditor: true });
            },
          }),
    );
  };
  const secretsArea = (placeholder) => {
    const area = el("textarea", { rows: 3, class: "mono", placeholder, spellcheck: false, autocomplete: "off", oninput: () => (draft.secretsText = area.value) });
    area.value = draft.secretsText;
    return area;
  };
  if (draft.transport === "stdio") {
    const command = el("input", { type: "text", class: "wide mono", value: draft.command, spellcheck: false, oninput: () => (draft.command = command.value) });
    const args = el("textarea", { rows: 2, class: "mono", spellcheck: false, oninput: () => (draft.argsText = args.value) });
    args.value = draft.argsText;
    fields.push(field(t("mcp.command"), t("mcp.commandDesc"), command));
    // Presets need no arguments or variables; custom servers (and anything already saved with them) show the boxes.
    if (draft.preset === "custom" || draft.argsText || draft.savedKeys.length) {
      fields.push(field(t("mcp.args"), t("mcp.argsDesc"), args));
      fields.push(field(t("mcp.env"), t("mcp.envDesc"), secretsArea("API_KEY=..."), secretNote()));
    }
  } else {
    const url = el("input", { type: "text", class: "wide mono", value: draft.url, spellcheck: false, oninput: () => (draft.url = url.value) });
    const signIn = usesToken && snap.githubSignIn;
    if (signIn) fields.push(githubBlock(draft));
    if (!signIn || draft.showToken) fields.push(field(t("mcp.url"), "", url));
    if (usesToken && (!signIn || draft.showToken)) {
      const token = el("input", { type: "password", class: "key", autocomplete: "off", spellcheck: false, placeholder: "github_pat_...", oninput: () => (draft.token = token.value) });
      token.value = draft.token;
      fields.push(field(t("mcp.token"), t("mcp.tokenDesc"), token, secretNote()));
    } else if (signIn) {
      fields.push(
        el(
          "div",
          { class: "row" },
          el("button", {
            class: "link",
            type: "button",
            text: t("mcp.github.pasteToken"),
            onclick: () => {
              draft.showToken = true;
              renderMcp({ rebuildEditor: true });
            },
          }),
        ),
      );
    } else if (draft.preset === "custom" || draft.savedKeys.length) {
      fields.push(field(t("mcp.headers"), t("mcp.headersDesc"), secretsArea("Authorization: Bearer ..."), secretNote()));
    }
  }
  const message = el("div", { class: "message" });
  box.append(
    el("div", { class: "row editor-head" }, el("div", { class: "label" }, el("div", { class: "title", text: t(draft.id ? "mcp.editorEdit" : "mcp.editorNew") }))),
    el(
      "div",
      { class: "row stack" },
      el("div", { class: "desc", text: t(`mcp.preset.${draft.preset}Help`) }),
      preset.link && !(usesToken && snap.githubSignIn && !draft.showToken) // "create a token" only matters when pasting one
        ? el("div", { class: "actions" }, el("button", { class: "link", type: "button", text: t(`mcp.preset.${draft.preset}Link`), onclick: () => api.open(preset.link) }))
        : null,
    ),
    ...fields,
    el(
      "div",
      { class: "row stack" },
      el(
        "div",
        { class: "actions" },
        usesToken && snap.githubSignIn && !draft.id && !draft.showToken
          ? null // a new GitHub connection is saved by "Sign in with GitHub"
          : el("button", { class: "btn primary", type: "button", text: t("mcp.save"), onclick: () => saveMcpDraft(draft, message) }),
        el("button", {
          class: "btn",
          type: "button",
          text: t("mcp.cancel"),
          onclick: () => {
            mcpEditing = null;
            renderMcp();
          },
        }),
      ),
      message,
    ),
  );
  return box;
}

function renderMcp({ rebuildEditor = false } = {}) {
  if (!mcpRefs.list) return;
  mcpRefs.notice.hidden = mcpData.status !== null || !mcpData.servers.length;
  mcpRefs.list.replaceChildren(
    ...(mcpData.servers.length ? mcpData.servers.map(mcpServerCard) : [el("div", { class: "group" }, el("div", { class: "empty", text: t("mcp.empty") }))]),
  );
  // Status updates arrive while you type: rebuild the editor only for another draft or a changed layout.
  if (rebuildEditor || mcpRefs.editorDraft !== mcpEditing) {
    mcpRefs.editor.replaceWith((mcpRefs.editor = renderMcpEditor()));
    mcpRefs.editorDraft = mcpEditing;
  }
  mcpRefs.editor.hidden = !mcpEditing;
}

function sectionMcp() {
  mcpRefs = {
    notice: el("div", { class: "notice warn", text: t("mcp.proxyDown"), hidden: true }),
    message: el("div", { class: "message" }),
    list: el("div", { class: "mcp-list" }),
    editor: el("div", { class: "group editor", hidden: true }),
  };
  const presets = Object.keys(MCP_PRESETS)
    .filter((id) => !MCP_PRESETS[id].only || MCP_PRESETS[id].only === PLATFORM)
    .map((id) =>
      el(
        "button",
        {
          class: "preset",
          type: "button",
          onclick: () => {
            mcpEditing = mcpDraft(id);
            renderMcp();
            mcpRefs.editor.scrollIntoView({ behavior: "smooth", block: "start" });
          },
        },
        el("strong", { text: t(`mcp.preset.${id}`) }),
        el("small", { text: t(`mcp.preset.${id}Sub`) }),
      ),
    );
  queueMicrotask(() => void loadMcp());
  return [
    el("h1", { text: t("mcp.title") }),
    el("p", { class: "lead", text: t("mcp.lead") }),
    el("div", { class: "notice warn", text: t("mcp.privacy") }),
    mcpRefs.notice,
    el("h2", { text: t("mcp.add") }),
    el("div", { class: "presets" }, presets),
    mcpRefs.editor,
    el("h2", { text: t("mcp.list") }),
    mcpRefs.list,
    mcpRefs.message,
    el("p", { class: "lead small", text: t("mcp.writeNote") }),
    el("p", { class: "lead small", text: t("mcp.examples") }),
  ];
}

// ---------------------------------------------------------------------------
// Usage and cost: what is billed on Gemini's paid tier, what the pet is doing right now, and today's token counts
// (the proxy counts them; nothing about the conversation itself is stored).
// ---------------------------------------------------------------------------
let usageData = null; // { days, prices } from the proxy, or null
let usageRefs = {};

const formatUsd = (value) => {
  if (!(value > 0)) return "$0";
  if (value < 0.001) return "< $0.001";
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
};
const formatCount = (n) => Number(n || 0).toLocaleString(getLanguage() === "ja" ? "ja-JP" : "en-US");

async function loadUsage() {
  const result = await api.usage?.();
  usageData = result?.ok ? result.data : null;
  renderUsage();
}

/** What the pet is doing now, in billing terms. */
function currentBillingState() {
  const pet = snap.pet ?? {};
  if (pet.sleeping) return "sleeping";
  if (pet.conn !== "ready") return "offline";
  if (pet.muted) return "muted";
  return "listening";
}

function usageRow(title, value) {
  return el("div", { class: "row usage-row" }, el("div", { class: "label" }, el("div", { class: "title", text: title })), el("div", { class: "control value", text: value }));
}

function renderUsage() {
  if (!usageRefs.today) return;
  const days = usageData?.days ?? [];
  const today = days[0]?.date === localDate(new Date()) ? days[0] : null;
  usageRefs.notice.hidden = Boolean(usageData);
  if (!today) {
    usageRefs.today.replaceChildren(el("div", { class: "empty", text: usageData ? t("usage.noneToday") : t("usage.proxyDown") }));
  } else {
    const estimate = today.estimate;
    usageRefs.today.replaceChildren(
      usageRow(t("usage.turns"), t("usage.times", { n: formatCount(today.turns) })),
      usageRow(t("usage.inputAudio"), t("usage.tokens", { n: formatCount(today.inputAudio) })),
      usageRow(t("usage.inputText"), t("usage.tokens", { n: formatCount(today.inputText + today.inputOther) })),
      usageRow(t("usage.outputAudio"), t("usage.tokens", { n: formatCount(today.outputAudio) })),
      usageRow(t("usage.outputText"), t("usage.tokens", { n: formatCount(today.outputText + today.thoughts + today.transcription) })),
      usageRow(t("usage.listening"), t("usage.minutes", { n: formatCount(Math.round(today.listeningSeconds / 60)) })),
      usageRow(t("usage.copilot"), t("usage.times", { n: formatCount(today.copilotRequests) })),
      el(
        "div",
        { class: "row usage-row total" },
        el("div", { class: "label" }, el("div", { class: "title", text: t("usage.estimate") }), el("div", { class: "desc", text: t("usage.estimateDesc") })),
        el("div", { class: "control value", text: t("usage.range", { low: formatUsd(estimate.turns), high: formatUsd(estimate.total) }) }),
      ),
    );
  }
  const recent = days.slice(0, 7);
  usageRefs.days.replaceChildren(
    ...(recent.length
      ? recent.map((day) =>
          el(
            "div",
            { class: "row usage-day" },
            el("span", { class: "usage-date", text: formatDay(day.date) }),
            el("span", { text: t("usage.times", { n: formatCount(day.turns) }) }),
            el("span", { text: t("usage.minutes", { n: formatCount(Math.round(day.listeningSeconds / 60)) }) }),
            el("span", { class: "value", text: t("usage.range", { low: formatUsd(day.estimate.turns), high: formatUsd(day.estimate.total) }) }),
          ),
        )
      : [el("div", { class: "empty", text: usageData ? t("usage.noneYet") : t("usage.proxyDown") })]),
  );
  const prices = usageData?.prices;
  usageRefs.prices.textContent = prices
    ? t("usage.prices", {
        model: prices.model,
        date: prices.checked,
        audioIn: prices.inputAudio.toFixed(2),
        audioOut: prices.outputAudio.toFixed(2),
        textIn: prices.inputText.toFixed(2),
        textOut: prices.outputText.toFixed(2),
        perMinute: prices.listeningPerMinute,
      })
    : "";
}

const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function formatDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(getLanguage() === "ja" ? "ja-JP" : "en-US", { month: "numeric", day: "numeric", weekday: "short" });
}

function sectionUsage() {
  usageRefs = {
    notice: el("div", { class: "notice warn", text: t("usage.proxyDown"), hidden: true }),
    today: el("div", { class: "group" }),
    days: el("div", { class: "group" }),
    prices: el("p", { class: "lead small" }),
  };
  const stateTitle = el("h3");
  const stateDesc = el("p");
  const stateStatus = el("span", { class: "usage-explainer-status" });
  sync(() => {
    const state = currentBillingState();
    stateTitle.textContent = t(`usage.state.${state}`);
    stateDesc.textContent = t(`usage.state.${state}Desc`);
    stateStatus.textContent = t(`usage.state.${state}Pill`);
  });
  const BILLED = ["talk", "listening", "mute", "sleep", "scheduled", "quit", "copilot", "data"];
  const link = (key, target) => el("button", { class: "link", type: "button", text: t(key), onclick: () => api.open(target) });
  queueMicrotask(() => void loadUsage());
  return [
    el("h1", { text: t("usage.title") }),
    el("p", { class: "lead", text: t("usage.lead") }),
    usageRefs.notice,
    el("h2", { text: t("usage.now") }),
    el("div", { class: "usage-now" }, el("div", { class: "usage-explainer-head" }, stateTitle, stateStatus), stateDesc),
    el("h2", { id: "usage-billed-heading", text: t("usage.billed") }),
    el("p", { class: "usage-explainer-intro", text: t("usage.billed.intro") }),
    el(
      "ul",
      { class: "usage-explainer", "aria-labelledby": "usage-billed-heading" },
      BILLED.map((key) =>
        el(
          "li",
          {},
          el("div", { class: "usage-explainer-head" }, el("h3", { text: t(`usage.billed.${key}`) }), el("span", { class: "usage-explainer-status", text: t(`usage.billed.${key}Pill`) })),
          el("p", { text: t(`usage.billed.${key}Desc`) }),
        ),
      ),
    ),
    el(
      "div",
      { class: "section-head" },
      el("h2", { text: t("usage.today") }),
      el("button", { class: "link", type: "button", text: t("usage.refresh"), onclick: () => void loadUsage() }),
    ),
    usageRefs.today,
    el("h2", { text: t("usage.recent") }),
    usageRefs.days,
    usageRefs.prices,
    el("div", { class: "actions spaced" }, link("usage.linkUsage", "ai-studio-usage"), link("usage.linkSpend", "ai-studio-spend"), link("usage.linkPricing", "gemini-pricing"), link("usage.linkLive", "live-billing")),
    el("h2", { text: t("usage.tips") }),
    el("div", { class: "group" }, el("ul", { class: "plain" }, ["usage.tip1", "usage.tip2", "usage.tip3", "usage.tip4"].map((key) => el("li", { text: t(key) })))),
  ];
}

const BUILDERS = {
  general: sectionGeneral,
  character: sectionCharacter,
  voice: sectionVoice,
  automations: sectionAutomations,
  mcp: sectionMcp,
  news: sectionNews,
  connection: sectionConnection,
  usage: sectionUsage,
  about: sectionAbout,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function renderAll() {
  syncers = [];
  setLanguage(snap.uiLanguage);
  document.title = t("settings.title");
  applyI18n();
  document.querySelector(".brand strong").textContent = snap.appName;
  nav.replaceChildren(
    ...SECTIONS.map((id) => {
      const button = el("button", { class: "nav-item", type: "button", "data-section": id, onclick: () => go(id) });
      button.innerHTML = ICONS[id]; // static icons defined above
      button.append(el("span", { text: t(`nav.${id}`) }));
      if (id === "connection") {
        const dot = el("span", { class: "badge-dot" });
        button.append(dot);
        sync(() => (dot.hidden = snap.gemini.source !== "none")); // red dot until a Gemini key is set
      }
      return button;
    }),
  );
  content.replaceChildren(...SECTIONS.map((id) => el("section", { class: "section", id: `section-${id}` }, ...BUILDERS[id]())));
  go(current, { keepScroll: true });
}

function go(id, { keepScroll = false } = {}) {
  current = SECTIONS.includes(id) ? id : "general";
  history.replaceState(null, "", `#${current}`);
  for (const section of content.querySelectorAll(".section")) section.hidden = section.id !== `section-${current}`;
  for (const button of nav.querySelectorAll(".nav-item")) {
    if (button.dataset.section === current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (!keepScroll) content.scrollTop = 0;
  if (current === "usage") void loadUsage(); // numbers change while the pet talks: refresh on every visit
}

function onSnapshot(next) {
  if (!next) return;
  const languageChanged = !snap || snap.uiLanguage !== next.uiLanguage;
  const sourcesChanged = !snap || JSON.stringify(snap.values.customFeeds) !== JSON.stringify(next.values.customFeeds);
  snap = next;
  if (languageChanged || sourcesChanged) {
    const scroll = content.scrollTop;
    renderAll();
    content.scrollTop = scroll;
  } else {
    for (const fn of syncers) fn();
  }
}

api.onChanged(onSnapshot);
let autoReload;
autoApi.onChanged(() => {
  clearTimeout(autoReload);
  autoReload = setTimeout(() => void loadAutomations(), 300); // runs and edits (also from voice) show up here
});
api.github?.onEvent((payload) => {
  if (payload?.state === "done") {
    githubAuth = null;
    mcpEditing = null;
    if (payload.id) mcpOpen.add(payload.id);
    void loadMcp().then(() => mcpSay(payload.login ? t("mcp.github.connected", { login: payload.login }) : t("mcp.saved"), "ok"));
  } else if (payload?.state === "error") {
    githubAuth = { error: payload.message ?? "error" };
    renderMcp({ rebuildEditor: true });
  } else if (payload?.state === "cancelled") {
    githubAuth = null;
    renderMcp({ rebuildEditor: true });
  }
});
let mcpReload;
mcpApi.onChanged(() => {
  clearTimeout(mcpReload);
  mcpReload = setTimeout(() => void loadMcp(), 300); // connection states and tool lists come from the proxy
});
api.onSection((id) => go(id));
onSnapshot(await api.get());
