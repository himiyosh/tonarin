/**
 * App settings, stored in the app's own folder (userData/settings.json), and secrets (the Gemini API key)
 * encrypted with Electron safeStorage (backed by the macOS keychain, or DPAPI for the Windows account). Nothing here
 * is read from .env, except as a fallback the caller decides on (development setups keep working).
 */
const { safeStorage } = require("electron");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const catalog = require("../src/catalog.json");

const LANGUAGES = ["auto", "ja", "en"];
const FEED_IDS = new Set(catalog.feeds.map((feed) => feed.id));
const NEWS_CATEGORIES = new Set(["technology", "general", "business", "science", "lifestyle"]);
const VOICE_IDS = new Set(catalog.voices.map((voice) => voice.id));
const isBool = (value) => typeof value === "boolean";

function isCustomFeed(feed) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) return false;
  if (Object.keys(feed).some((key) => !["id", "name", "language", "category", "url", "siteUrl", "siteHost"].includes(key))) return false;
  if (!/^custom-[0-9a-f-]{36}$/.test(feed.id) || typeof feed.name !== "string" || !feed.name || feed.name.length > 100) return false;
  if (typeof feed.url !== "string" || typeof feed.siteUrl !== "string" || typeof feed.siteHost !== "string") return false;
  if (!["ja", "en"].includes(feed.language) || !NEWS_CATEGORIES.has(feed.category)) return false;
  try {
    const site = new URL(feed.siteUrl);
    const source = new URL(feed.url);
    return (
      feed.siteUrl.length <= 2048 && feed.url.length <= 2048 &&
      site.protocol === "https:" && source.protocol === "https:" &&
      !site.username && !site.password && !source.username && !source.password &&
      !site.hostname.endsWith(".") && !source.hostname.endsWith(".") &&
      feed.siteHost === site.hostname && !FEED_IDS.has(feed.id)
    );
  } catch {
    return false;
  }
}

const DEFAULTS = {
  language: "auto", // menus and bubbles
  speechLanguage: "auto", // what the pet speaks; auto = same as language
  character: "mochi",
  scale: 1,
  captions: true,
  showYou: true,
  echoGuard: false,
  idleMinutes: 10,
  voice: "Aoede",
  persona: "",
  silenceMs: 700,
  noiseFilter: "standard", // light | standard | strong: how much the pet ignores room noise (speech-gate.js)
  useCopilot: true,
  mode: "companion", // companion | english (conversation practice) | focus (quiet, short answers)
  mcpServers: [], // MCP connections without their secrets (those are in the keychain as "mcp:<id>")
  feeds: null, // null = the default set for the speech language
  customFeeds: [], // verified RSS/Atom feeds and the exact site hostname the user entered
  launchAtLogin: false,
  migratedLocalPrefs: false,
  proxyKey: "",
};

const VALID = {
  language: (v) => LANGUAGES.includes(v),
  speechLanguage: (v) => LANGUAGES.includes(v),
  character: (v) => typeof v === "string" && /^(codex:)?[A-Za-z0-9._-]{1,64}$/.test(v),
  scale: (v) => Number.isFinite(v) && v >= 0.5 && v <= 2,
  captions: isBool,
  showYou: isBool,
  echoGuard: isBool,
  idleMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 240,
  voice: (v) => VOICE_IDS.has(v),
  persona: (v) => typeof v === "string" && v.length <= 2000,
  silenceMs: (v) => Number.isInteger(v) && v >= 300 && v <= 2000,
  noiseFilter: (v) => v === "light" || v === "standard" || v === "strong",
  useCopilot: isBool,
  mode: (v) => ["companion", "english", "focus"].includes(v),
  mcpServers: (v) => Array.isArray(v) && v.length <= 20 && v.every(isMcpServer),
  feeds: (v, values) => v === null || (
    Array.isArray(v) && v.length <= 30 && new Set(v).size === v.length &&
    v.every((id) => typeof id === "string" && (FEED_IDS.has(id) || values.customFeeds.some((feed) => feed.id === id)))
  ),
  customFeeds: (v) => Array.isArray(v) && v.length <= 10 && v.every(isCustomFeed) &&
    new Set(v.map((feed) => feed.id)).size === v.length && new Set(v.map((feed) => feed.url)).size === v.length,
  launchAtLogin: isBool,
  migratedLocalPrefs: isBool,
  proxyKey: (v) => typeof v === "string" && v.length <= 200,
};

const SECRET_NAMES = new Set(["geminiApiKey"]);
// "mcp:<id>" = env values and headers of an MCP connection; "github:<id>" = its GitHub refresh token and expiry times.
const isSecretName = (name) => SECRET_NAMES.has(name) || /^(mcp|github):[A-Za-z0-9-]{1,40}$/.test(name);

function isMcpServer(s) {
  const str = (v, max) => typeof v === "string" && v.length <= max;
  const names = (v) => Array.isArray(v) && v.length <= 30 && v.every((k) => str(k, 100));
  return (
    s !== null &&
    typeof s === "object" &&
    /^[A-Za-z0-9-]{1,40}$/.test(s.id) &&
    str(s.name, 60) &&
    typeof s.enabled === "boolean" &&
    (s.transport === "stdio" || s.transport === "http") &&
    (s.command === undefined || str(s.command, 500)) &&
    (s.args === undefined || (Array.isArray(s.args) && s.args.length <= 40 && s.args.every((a) => str(a, 1000)))) &&
    (s.url === undefined || str(s.url, 1000)) &&
    (s.preset === undefined || str(s.preset, 40)) &&
    (s.account === undefined || str(s.account, 100)) &&
    (s.envKeys === undefined || names(s.envKeys)) &&
    (s.headerKeys === undefined || names(s.headerKeys)) &&
    (s.tools === undefined || (typeof s.tools === "object" && Object.values(s.tools).every((b) => typeof b === "boolean")))
  );
}

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, "settings.json");
    this.secretsFile = path.join(dir, "secrets.json");
    this.values = { ...DEFAULTS };
    this.secrets = {};
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    const saved = readJson(this.file);
    if ("customFeeds" in saved) {
      if (VALID.customFeeds(saved.customFeeds)) this.values.customFeeds = saved.customFeeds;
      else console.error("[settings] ignored invalid saved news sites");
    }
    for (const key of Object.keys(DEFAULTS)) {
      if (key === "customFeeds") continue;
      if (key in saved && VALID[key](saved[key], this.values)) this.values[key] = saved[key];
      else if (key === "feeds" && key in saved) console.error("[settings] ignored invalid saved news selection");
    }
    const secrets = readJson(this.secretsFile);
    for (const [name, value] of Object.entries(secrets)) if (isSecretName(name) && typeof value === "string") this.secrets[name] = value;
  }

  /** Whether `value` would be accepted for `key` (lets callers check before they change anything else). */
  isValid(key, value) {
    return key in DEFAULTS && VALID[key](value, this.values);
  }

  get all() {
    return structuredClone(this.values);
  }

  /** Applies the valid keys of `patch`; returns the keys that changed. Invalid values are ignored. */
  update(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULTS) || !VALID[key](value, this.values)) continue;
      if (JSON.stringify(this.values[key]) === JSON.stringify(value)) continue;
      this.values[key] = structuredClone(value);
      changed.push(key);
    }
    if (changed.length) {
      writeJson(this.file, this.values);
      this.emit("change", changed);
    }
    return changed;
  }

  /** The local proxy's key: kept stable per install, generated on first use. */
  ensureProxyKey() {
    if (!this.values.proxyKey) this.update({ proxyKey: crypto.randomBytes(24).toString("base64url") });
    return this.values.proxyKey;
  }

  // --- secrets (encrypted with safeStorage; the plain value never goes to a renderer) ------------------
  hasSecret(name) {
    return Boolean(this.secrets[name]);
  }

  getSecret(name) {
    if (!this.secrets[name] || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(this.secrets[name], "base64"));
    } catch {
      return undefined;
    }
  }

  setSecret(name, value) {
    if (!isSecretName(name)) throw new Error(`Unknown secret: ${name}`);
    if (value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage (keychain) is not available");
      this.secrets[name] = safeStorage.encryptString(value).toString("base64");
    } else {
      delete this.secrets[name];
    }
    writeJson(this.secretsFile, this.secrets);
    this.emit("change", [`secret:${name}`]);
  }
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  // On Windows a virus scanner or the search indexer can hold the file for a moment: try again briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
    }
  }
}

module.exports = { Settings, DEFAULTS, catalog };
