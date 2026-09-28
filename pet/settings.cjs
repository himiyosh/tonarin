/**
 * App settings, stored in the app's own folder (userData/settings.json), and secrets (the Gemini API key)
 * encrypted with Electron safeStorage (backed by the macOS keychain). Nothing here is read from .env,
 * except as a fallback the caller decides on (development setups keep working).
 */
const { safeStorage } = require("electron");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const catalog = require("../src/catalog.json");

const LANGUAGES = ["auto", "ja", "en"];
const FEED_IDS = new Set(catalog.feeds.map((feed) => feed.id));
const VOICE_IDS = new Set(catalog.voices.map((voice) => voice.id));
const isBool = (value) => typeof value === "boolean";

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
  feeds: (v) => v === null || (Array.isArray(v) && v.length <= 30 && v.every((id) => FEED_IDS.has(id))),
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
    for (const key of Object.keys(DEFAULTS)) {
      if (key in saved && VALID[key](saved[key])) this.values[key] = saved[key];
    }
    const secrets = readJson(this.secretsFile);
    for (const [name, value] of Object.entries(secrets)) if (isSecretName(name) && typeof value === "string") this.secrets[name] = value;
  }

  /** Whether `value` would be accepted for `key` (lets callers check before they change anything else). */
  isValid(key, value) {
    return key in DEFAULTS && VALID[key](value);
  }

  get all() {
    return structuredClone(this.values);
  }

  /** Applies the valid keys of `patch`; returns the keys that changed. Invalid values are ignored. */
  update(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULTS) || !VALID[key](value)) continue;
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
  fs.renameSync(tmp, file);
}

module.exports = { Settings, DEFAULTS, catalog };
