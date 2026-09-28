/**
 * Tonarin: a small transparent, always-on-top pet that talks with you through the local proxy's realtime endpoint
 * (ws://127.0.0.1:8787/v1/live, Gemini Live behind it), plus a settings window and a menu bar icon.
 *
 * Start with "Tonarin (dev).app" (npm run launcher) or `npm run pet`. If the proxy is not running yet, the app starts it
 * (logs go to logs/proxy.log) and stops it again on quit.
 *
 * Settings live in the app's own folder (userData/settings.json); the Gemini API key is encrypted with the keychain.
 * .env values still work as a fallback, so development setups keep running.
 */
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  clipboard,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { connect } = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveLanguage, translator } = require("./i18n.cjs");
const { createPets } = require("./pets.cjs");
const { createDeviceFlow, isTransient } = require("./github.cjs");
const { layoutFor } = require("./layout.cjs");
const { Settings, catalog } = require("./settings.cjs");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE = require("../package.json");
const APP_VERSION = PACKAGE.version;
// Public client ID of the Tonarin OAuth App on GitHub (device flow, no secret). Empty: only token pasting is offered.
const GITHUB_CLIENT_ID = process.env.TONARIN_GITHUB_CLIENT_ID || PACKAGE.tonarin?.githubClientId || "";
const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
// The app's name: menus, the keychain item ("<name> Safe Storage") and the settings folder
// (~/Library/Application Support/<name>). It comes from package.json "productName", the same value electron-builder
// uses for the .app, so renaming the app is a one-line change. A development run would otherwise use Electron's defaults.
const APP_NAME = PACKAGE.productName ?? "Tonarin";
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));
// Earlier names of the app (2026-09-27: "AI Pet" became "Tonarin"). Their settings folder is copied once into the new
// one. Keychain secrets are not: they are encrypted with the old name's keychain item, so keys are entered again.
const PREVIOUS_NAMES = ["AI Pet"];
const UI_DIR = path.join(__dirname, "ui");
const PET_URL = "pet://app/index.html";
const SETTINGS_URL = "pet://app/settings.html";
// Window size at scale 1. The pet is 190 px square; the space above it is for the speech bubble,
// which grows with long replies (the page reports how much room it needs).
const PET_PX = 190;
const MAX_BUBBLE_SPACE = 420;
const MIN_WIDTH = 320; // the bubble (300 px + margins) fits across the window
const PET_MARGIN_TOP = 12; // room above the pet for its bob and effects
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const SIZE_PRESETS = [
  { key: "sizeSmall", scale: 0.7 },
  { key: "sizeMedium", scale: 1 },
  { key: "sizeLarge", scale: 1.35 },
  { key: "sizeXL", scale: 1.7 },
];
/** Links and folders the settings window may open. Anything else is refused. */
const EXTERNAL_LINKS = {
  "ai-studio": "https://aistudio.google.com/apikey",
  "pet-gallery": "https://codex-pets.net/",
  "gemini-terms": "https://ai.google.dev/gemini-api/terms",
  "che-ical": "https://github.com/PsychQuant/che-ical-mcp/releases/latest",
  "github-token": "https://github.com/settings/personal-access-tokens/new",
  "github-device": "https://github.com/login/device",
  "github-authorized-apps": "https://github.com/settings/applications",
  "mcp-servers": "https://github.com/modelcontextprotocol/servers",
  "gemini-pricing": "https://ai.google.dev/gemini-api/docs/pricing",
  "live-billing": "https://ai.google.dev/gemini-api/docs/live-api/best-practices",
  "ai-studio-usage": "https://aistudio.google.com/usage",
  "ai-studio-spend": "https://aistudio.google.com/spend",
};

// --- environment and .env (development fallback) -----------------------------------------------------------
function readDotEnv() {
  const values = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // no .env: everything comes from the settings window
  }
  return values;
}
const dotEnv = readDotEnv();
const env = (name, fallback = "") => process.env[name] ?? dotEnv[name] ?? fallback;
// Packaged apps run their own proxy, bundled into dist/server.mjs, inside Electron (utilityProcess): no Node.js or tsx
// needed, and a free port per launch so it never meets a development proxy. PET_BUNDLED_PROXY=1 tries that path in a
// development run (after `npm run build:proxy`). Development runs otherwise use port 8787 and `node --import tsx`.
const BUNDLED_PROXY = app.isPackaged || env("PET_BUNDLED_PROXY") === "1";
let PORT = Number(env("PORT", "8787"));
const ENV_PROXY_KEY = env("PROXY_API_KEY");
const ENV_GEMINI_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = env("GEMINI_LIVE_MODEL", "gemini-3.8-live");
const START_CHARACTER = env("PET_CHARACTER"); // e.g. "robo" or "codex:<folder>", overrides the saved choice for one run
const CODEX_PETS_DIR = env("CODEX_PETS_DIR", path.join(os.homedir(), ".codex", "pets"));
const pets = createPets(CODEX_PETS_DIR);

let settings; // created when the app is ready (safeStorage needs it)
let t = translator("ja");
const uiLanguage = () => resolveLanguage(settings.values.language, app.getLocale());
const speechLanguage = () => (settings.values.speechLanguage === "auto" ? uiLanguage() : settings.values.speechLanguage);
const geminiKeySource = () => (settings.hasSecret("geminiApiKey") ? "keychain" : ENV_GEMINI_KEY ? "env" : "none");
const proxyKey = () => ENV_PROXY_KEY || settings.ensureProxyKey();
const logDir = () => (app.isPackaged ? path.join(app.getPath("userData"), "logs") : path.join(ROOT, "logs"));

// The packaged app has no terminal: keep the main process's own messages in logs/main.log (development runs log to
// logs/pet.log through the launcher). Only app events are logged here, never conversation text or keys.
function logToFile() {
  if (!app.isPackaged) return;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const file = path.join(logDir(), "main.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`);
    const stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    for (const level of ["log", "warn", "error"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        original(...args);
        stream.write(`${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}\n`);
      };
    }
    console.log(`[pet] ${APP_NAME} ${APP_VERSION} started (Electron ${process.versions.electron})`);
  } catch {
    // no log file then
  }
}

// If the main process stalls (a system prompt, a slow synchronous call), menus and dragging stop while clicks that
// the page handles itself (mute) keep working. Note such stalls so they can be found in the log.
function watchEventLoop() {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 2500) console.warn(`[pet] the main process was busy for ${((now - last) / 1000).toFixed(1)} s`);
    last = now;
  }, 1000).unref();
}

// --- the proxy ---------------------------------------------------------------------------------------------
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await portOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

let proxyChild; // { stop(): Promise<void> } while the app runs the proxy
let proxyRunning = false;
let proxyStatus = null; // what the proxy reports on /v1/status: { live, copilot }

/** A free TCP port on 127.0.0.1 (the OS picks one; the proxy binds it a moment later). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require("node:net").createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startProxy() {
  fs.mkdirSync(logDir(), { recursive: true });
  const logFile = path.join(logDir(), "proxy.log");
  const childEnv = {
    ...process.env,
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":"),
    PORT: String(PORT),
    PROXY_API_KEY: proxyKey(),
    WHISPER: "off", // local speech recognition is only for the AIRI setup
    REMINDERS_FILE: path.join(app.getPath("userData"), "reminders.json"),
    AUTOMATIONS_FILE: path.join(app.getPath("userData"), "automations.json"),
    USAGE_FILE: path.join(app.getPath("userData"), "usage.json"), // token counts per day, no content
  };
  if (env("DEBUG_REQUESTS")) childEnv.DEBUG_REQUESTS = env("DEBUG_REQUESTS"); // the bundled proxy does not read .env
  // The settings window (keychain) wins over .env. The bundled proxy does not read .env itself, so pass it on.
  const key = settings.getSecret("geminiApiKey") || ENV_GEMINI_KEY;
  if (key) childEnv.GEMINI_API_KEY = key;

  let exited;
  const onExit = (code) => {
    console.log(`[pet] proxy exited (code ${code}); see ${logFile}`);
    if (proxyChild === handle) {
      proxyChild = undefined;
      proxyRunning = false;
      proxyStatus = null;
      broadcastSettings();
    }
  };
  let handle;
  if (BUNDLED_PROXY) {
    const child = utilityProcess.fork(path.join(ROOT, "dist", "server.mjs"), [], {
      serviceName: `${APP_NAME} proxy`,
      cwd: app.getPath("userData"),
      env: childEnv,
      stdio: "pipe",
    });
    const log = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    exited = new Promise((resolve) => child.once("exit", resolve));
    handle = { stop: () => (child.kill(), exited) }; // SIGTERM: the proxy shuts down gracefully
  } else {
    const log = fs.openSync(logFile, "a");
    const child = spawn("node", ["--env-file-if-exists=.env", "--import", "tsx", "src/server.ts"], {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", log, log],
    });
    exited = new Promise((resolve) => child.once("exit", resolve));
    handle = { stop: () => (child.kill("SIGINT"), exited) }; // SIGINT: the proxy shuts down gracefully
  }
  proxyChild = handle;
  exited.then(onExit);
  console.log(`[pet] started the proxy (${BUNDLED_PROXY ? "bundled" : "tsx"}, port ${PORT}, log ${logFile})`);
}

/** Asks the proxy what works (Gemini key present, Copilot signed in) until Copilot has finished starting. */
async function refreshProxyStatus() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v1/status`, {
        headers: { Authorization: `Bearer ${proxyKey()}` },
        signal: AbortSignal.timeout(3000),
      });
      proxyStatus = response.ok ? await response.json() : null; // an older external proxy has no /v1/status
      broadcastSettings();
      if (!proxyStatus || proxyStatus.copilot !== "starting") return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// --- events from the proxy (Server-Sent Events): reminders that come due ------------------------------------
let eventsRequest;
let eventsRetry;
function listenToProxyEvents() {
  clearTimeout(eventsRetry);
  eventsRequest?.destroy();
  const request = require("node:http").get(
    { host: "127.0.0.1", port: PORT, path: "/v1/events", headers: { Authorization: `Bearer ${proxyKey()}` } },
    (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // an older proxy without /v1/events: nothing to listen to
        return;
      }
      response.setEncoding("utf8");
      schedulePushMcp(); // a (re)started proxy knows no MCP servers yet
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (data) {
            try {
              onProxyEvent(JSON.parse(data));
            } catch {
              // ignore malformed events
            }
          }
        }
      });
      response.on("end", retry);
    },
  );
  request.on("error", retry);
  eventsRequest = request;
  function retry() {
    if (eventsRequest !== request) return;
    eventsRetry = setTimeout(listenToProxyEvents, 3000); // the proxy restarted or is starting
  }
}

// While the screen is locked nobody is listening: reminders and automations wait, and the pet wakes on unlock.
let screenLocked = false;
let wakeOnUnlock = false;
// Whether Tonarin is the frontmost app (macOS), for the menu log. The pet appears without taking focus.
let appActive = false;
app.on("did-become-active", () => (appActive = true));
app.on("did-resign-active", () => (appActive = false));
// The lock events only report changes, and on macOS getSystemIdleState() says "idle" rather than "locked" (checked on
// macOS 26), so ask the window server directly. This also covers an app started while the screen was locked.
function macScreenLocked() {
  if (process.platform !== "darwin") return false;
  try {
    const out = require("node:child_process").execFileSync("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8", timeout: 2000 });
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out);
  } catch {
    return false;
  }
}
const isScreenLocked = () => screenLocked || powerMonitor.getSystemIdleState(1) === "locked" || macScreenLocked();
function wakePetForDelivery() {
  if (!petVisible) return; // hidden on purpose: only the notification
  if (isScreenLocked()) wakeOnUnlock = true;
  else sendToPet("wake");
}
function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title: `${APP_NAME}: ${title}`, body: String(body ?? "").slice(0, 200) }).show();
}

function onProxyEvent(event) {
  switch (event?.type) {
    case "reminder":
    case "reminder-waiting":
      // Nobody heard it (the pet is asleep or hidden): wake the pet so it can say it, and show a notification.
      if (event.type === "reminder-waiting" || !event.delivered) wakePetForDelivery();
      if (event.type === "reminder" && (!event.delivered || !petVisible)) notify(t("reminderTitle"), event.label);
      break;
    case "automation":
      if (!event.delivered) {
        wakePetForDelivery();
        notify(t("automationTitle"), event.name);
      }
      settingsWin?.webContents.send("settings:automations-changed");
      break;
    case "automation-error":
      notify(t("automationFailed"), event.name);
      settingsWin?.webContents.send("settings:automations-changed");
      break;
    case "automations":
      settingsWin?.webContents.send("settings:automations-changed");
      break;
    case "mcp":
      settingsWin?.webContents.send("settings:mcp-changed");
      if (event.toolsChanged) sendToPet("refresh-tools"); // the pet's session gets the new tool list (unless it naps)
      break;
  }
}

/** The settings window manages automations through here: main holds the proxy key, the page never sees it. */
const automationsRequest = (...args) => proxyRequest(...args);
async function proxyRequest(method, pathname, body) {
  if (!proxyRunning) return { ok: false, message: "proxy-stopped" };
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/v1${pathname}${pathname.includes("?") ? "&" : "?"}lang=${uiLanguage()}`, {
      method,
      headers: { Authorization: `Bearer ${proxyKey()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, data } : { ok: false, message: data?.error?.message ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureProxy() {
  if (!BUNDLED_PROXY && (await portOpen(PORT))) {
    proxyRunning = true; // started outside the app (for example `npm start` while developing)
    void refreshProxyStatus();
    listenToProxyEvents();
    return;
  }
  if (BUNDLED_PROXY) PORT = await freePort();
  startProxy();
  proxyRunning = await waitForPort(PORT, 20_000);
  void refreshProxyStatus();
  listenToProxyEvents();
}

/** Restarts the proxy if the app manages it (after the Gemini key changed). Returns false for an external proxy. */
async function restartProxy() {
  const child = proxyChild;
  if (!child) return false;
  proxyStatus = null;
  await Promise.race([child.stop(), new Promise((resolve) => setTimeout(resolve, 7000))]);
  startProxy(); // same port: the pet keeps its address

  proxyRunning = await waitForPort(PORT, 20_000);
  sendToPet("reconnect");
  broadcastSettings();
  void refreshProxyStatus();
  schedulePushMcp();
  return true;
}

// --- settings snapshot shared with both pages ---------------------------------------------------------------
function snapshot() {
  const values = settings.all;
  delete values.proxyKey;
  return {
    values,
    uiLanguage: uiLanguage(),
    speechLanguage: speechLanguage(),
    gemini: { source: geminiKeySource() },
    proxy: { port: PORT, managed: Boolean(proxyChild), running: proxyRunning, status: proxyStatus },
    appName: APP_NAME,
    isPackaged: app.isPackaged,
    version: APP_VERSION,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    catalog,
    codexPetsDir: CODEX_PETS_DIR.replace(os.homedir(), "~"),
    pet: petState, // muted / sleeping / connection: the settings window explains what is billed right now
    githubSignIn: Boolean(GITHUB_CLIENT_ID),
  };
}

function broadcastSettings() {
  if (!settings) return;
  const data = snapshot();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("settings:changed", data);
}

// --- windows -----------------------------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  // A secure, standard scheme: needed for the microphone, AudioWorklet and ES modules.
  { scheme: "pet", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let win;
let settingsWin;
let tray;
let ignoringMouse = false;
let petVisible = true;
let petState = { muted: false, sleeping: false, conn: "connecting" };

function fromOurPages(event) {
  return event.senderFrame?.url?.startsWith("pet://app/") ?? false;
}

function lockDown(contents) {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function createPetWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const size = petSize();
  petBox = { x: workArea.x + workArea.width - size - 90, y: workArea.y + workArea.height - size - 16 };
  const { bounds } = computeLayout();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep audio and animation running while other apps are in front
    },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lockDown(win.webContents);
  win.once("ready-to-show", () => win.showInactive()); // appear without stealing focus
  win.on("closed", () => {
    win = undefined;
  });
  // Started while the screen is locked (for example at login, or restarted remotely): nap until someone is back.
  win.webContents.on("did-finish-load", () => {
    lastLayoutCommand = "";
    layoutWindow(); // tells the page where the bubble goes
  });
  win.webContents.once("did-finish-load", () => {
    if (isScreenLocked()) {
      screenLocked = true;
      sendToPet("sleep");
    }
  });
  win.loadURL(PET_URL);
}

function sendToPet(command) {
  win?.webContents.send("pet:command", command);
}

function setPetVisible(visible) {
  if (!win) return;
  petVisible = visible;
  if (visible) win.showInactive();
  else {
    sendToPet("sleep"); // hidden means nobody is listening: release the mic
    win.hide();
  }
  updateTrayMenu();
}

function openSettings(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (section) settingsWin.webContents.send("settings:section", section);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 760,
    minHeight: 540,
    title: t("settingsTitle"),
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c20" : "#f5f5f7",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  lockDown(settingsWin.webContents);
  settingsWin.loadURL(`${SETTINGS_URL}${section ? `#${section}` : ""}`);
  settingsWin.once("ready-to-show", () => {
    if (process.platform === "darwin") void app.dock?.show(); // so it shows up in Cmd+Tab while open
    settingsWin.show();
    app.focus({ steal: true });
  });
  settingsWin.on("closed", () => {
    settingsWin = undefined;
    if (process.platform === "darwin") app.dock?.hide();
  });
}

// --- menus -------------------------------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "trayTemplate.png"));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: petVisible ? t("hidePet") : t("showPet"), click: () => setPetVisible(!petVisible) },
      { type: "separator" },
      { label: petState.sleeping ? t("wake") : t("sleep"), enabled: petVisible, click: () => sendToPet("toggle-sleep") },
      {
        label: petState.muted ? t("unmute") : t("mute"),
        enabled: petVisible && !petState.sleeping,
        click: () => sendToPet("toggle-mute"),
      },
      { type: "separator" },
      { label: t("settings"), click: () => openSettings() },
      { type: "separator" },
      { label: t("quit"), click: () => app.quit() },
    ]),
  );
}

function setApplicationMenu() {
  // Needed for Cmd+C / Cmd+V in the settings window (the app has no Dock menu otherwise).
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: "appMenu",
        submenu: [
          { label: t("settings"), accelerator: "CmdOrCtrl+,", click: () => openSettings() },
          { type: "separator" },
          { role: "hide" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

async function chooseAndInstallPet() {
  app.focus({ steal: true });
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: t("addPetTitle"),
    message: t("addPetMessage"),
    defaultPath: path.join(os.homedir(), "Downloads"),
    properties: ["openFile"],
    filters: [{ name: t("addPetFilter"), extensions: ["zip", "webp", "png"] }],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  try {
    const pet = await pets.install(filePaths[0], t);
    pets.scan();
    settings.update({ character: pet.id });
    sendToPet(`notice:${t("petAdded", { name: pet.name })}`);
    return { ok: true, ...pet };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendToPet(`notice-error:${t("petAddFailed", { message })}`);
    return { ok: false, message };
  }
}

// --- IPC: pet page -----------------------------------------------------------------------------------------
ipcMain.handle("pet:config", (event) => {
  if (!fromOurPages(event)) return undefined;
  const codexPets = pets.scan();
  console.log(`[pet] Codex pets found: ${codexPets.length}`);
  return { wsUrl: `ws://127.0.0.1:${PORT}/v1/live`, key: proxyKey(), character: START_CHARACTER, codexPets };
});

ipcMain.handle("pet:codex-pets", (event) => (fromOurPages(event) ? pets.scan() : []));

ipcMain.on("pet:state", (event, state) => {
  if (!fromOurPages(event) || !state || typeof state !== "object") return;
  petState = { muted: Boolean(state.muted), sleeping: Boolean(state.sleeping), conn: String(state.conn ?? "") };
  updateTrayMenu();
  if (settings && settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("settings:changed", snapshot());
});

ipcMain.on("pet:move", (event, dx, dy) => {
  if (!win || !fromOurPages(event) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  petBox.x += dx;
  petBox.y += dy;
  layoutWindow();
});

// --- Window layout ---------------------------------------------------------------------------------------------
// Built around the pet's spot on screen; the bubble opens above or below the pet (see layout.cjs).
let currentScale = 1;
let petBox = { x: 0, y: 0 }; // top-left of the pet on screen
let bubbleSpace = 0; // height the bubble needs, 0 while hidden
let bubblePlacement = "above";
let lastLayoutCommand = "";
const petSize = () => Math.ceil(PET_PX * currentScale);

function petWorkArea() {
  const size = petSize();
  return screen.getDisplayNearestPoint({ x: Math.round(petBox.x + size / 2), y: Math.round(petBox.y + size / 2) }).workArea;
}

function computeLayout() {
  const result = layoutFor({
    pet: petBox,
    size: petSize(),
    workArea: petWorkArea(),
    bubble: bubbleSpace,
    placement: bubblePlacement,
    maxBubble: MAX_BUBBLE_SPACE,
    minWidth: MIN_WIDTH,
    marginTop: PET_MARGIN_TOP,
  });
  petBox = result.pet;
  bubblePlacement = result.placement;
  // For the page: which side the bubble goes, where the pet sits in the window, how tall the bubble may get.
  const command = `layout:${result.placement},${result.petTop},${result.petLeft},${result.room}`;
  return { bounds: result.bounds, command };
}

function layoutWindow() {
  if (!win) return;
  const { bounds, command } = computeLayout();
  if (command !== lastLayoutCommand) {
    lastLayoutCommand = command;
    sendToPet(command);
  }
  const current = win.getBounds();
  if (current.x === bounds.x && current.y === bounds.y && current.width === bounds.width && current.height === bounds.height) return;
  win.setBounds(bounds);
  syncPointerSoon();
}

// The page decides from mouse moves whether the pointer is over the pet (catch clicks) or over a transparent part
// (let clicks through). After the window changed size under a still pointer, and when it first appears, that
// decision can be stale until the mouse moves: tell the page where the pointer really is, once the new layout is
// in and once more a little later.
let pointerSyncTimers = [];
let pointerSyncAt = 0;
function syncPointerSoon() {
  for (const timer of pointerSyncTimers) clearTimeout(timer);
  pointerSyncTimers = [80, 400].map((delay) =>
    setTimeout(() => {
      if (!win) return;
      const cursor = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      pointerSyncAt = Date.now();
      sendToPet(`pointer:${Math.round(cursor.x - bounds.x)},${Math.round(cursor.y - bounds.y)}`);
    }, delay),
  );
}

ipcMain.on("pet:set-scale", (event, scale) => {
  if (!fromOurPages(event) || !Number.isFinite(scale)) return;
  // Grow or shrink around the pet's feet: same bottom center.
  const before = petSize();
  const centerX = petBox.x + before / 2;
  const bottom = petBox.y + before;
  currentScale = Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
  const after = petSize();
  petBox.x = centerX - after / 2;
  petBox.y = bottom - after;
  layoutWindow();
});

ipcMain.on("pet:set-bubble-space", (event, px) => {
  if (!fromOurPages(event) || !Number.isFinite(px)) return;
  bubbleSpace = px > 0 ? Math.min(Math.round(px), MAX_BUBBLE_SPACE) : 0;
  layoutWindow();
});

// Transparent areas let clicks through to the apps underneath.
ipcMain.on("pet:ignore-mouse", (event, ignore) => {
  if (!win || !fromOurPages(event) || ignoringMouse === Boolean(ignore)) return;
  if (ignoringMouse && Date.now() - pointerSyncAt < 300) console.log("[mouse] the pet was letting clicks through after a resize; fixed");
  ignoringMouse = Boolean(ignore);
  win.setIgnoreMouseEvents(ignoringMouse, { forward: true });
});

ipcMain.on("pet:menu", (event, state = {}) => {
  if (!win || !fromOurPages(event)) return;
  const characters = Array.isArray(state.characters) ? state.characters.slice(0, 30) : [];
  const codexPets = pets.scan();
  const current = settings.values.character;
  const characterItem = (character) => ({
    label: String(character.name),
    type: "radio",
    checked: character.id === current,
    click: () => settings.update({ character: character.id }),
  });
  // One line per menu request (how it was asked for), no content: helps when "the menu does not open" comes back.
  const via = ["contextmenu", "fallback", "long-press"].includes(state.via) ? state.via : "contextmenu";
  console.log(`[menu] ${via} (app ${appActive ? "in front" : "in the background"})`);
  try {
    const menu = Menu.buildFromTemplate([
      { label: petState.sleeping ? t("wake") : t("sleep"), click: () => sendToPet("toggle-sleep") },
      { label: petState.muted ? t("unmute") : t("mute"), enabled: !petState.sleeping, click: () => sendToPet("toggle-mute") },
      { type: "separator" },
      {
        label: t("character"),
        submenu: [
          ...characters.map(characterItem),
          { type: "separator" },
          { label: t("codexPets"), enabled: false },
          ...(codexPets.length ? codexPets.map(characterItem) : [{ label: t("none"), enabled: false }]),
          { type: "separator" },
          { label: t("findPets"), click: () => shell.openExternal(EXTERNAL_LINKS["pet-gallery"]) },
          { label: t("addPet"), click: () => void chooseAndInstallPet() },
          {
            label: t("openPetsFolder"),
            click: () => {
              fs.mkdirSync(CODEX_PETS_DIR, { recursive: true });
              void shell.openPath(CODEX_PETS_DIR);
            },
          },
        ],
      },
      {
        label: t("size"),
        submenu: [
          { label: t("sizeSlider"), click: () => sendToPet("size-panel") },
          { type: "separator" },
          ...SIZE_PRESETS.map((preset) => ({
            label: t(preset.key),
            type: "radio",
            checked: Math.abs(settings.values.scale - preset.scale) < 0.05,
            click: () => settings.update({ scale: preset.scale }),
          })),
          { type: "separator" },
          { label: t("pinchHint"), enabled: false },
        ],
      },
      { label: t("reset"), enabled: !petState.sleeping, click: () => sendToPet("reset") },
      { type: "separator" },
      { label: t("settings"), click: () => openSettings() },
      { type: "separator" },
      { label: t("quit"), click: () => app.quit() },
    ]);
    const opened = Date.now();
    menu.popup({
      window: win,
      callback: () => {
        if (Date.now() - opened < 150) console.warn("[menu] closed right away (it may not have been visible)");
      },
    });
  } catch (error) {
    console.error(`[menu] could not open: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// --- MCP connections ------------------------------------------------------------------------------------------
// The list lives in the settings (without secrets); env values and headers (tokens) are in the keychain as "mcp:<id>".
// The proxy gets the full list over its authenticated local API and keeps it in memory only.
function mcpSecrets(id) {
  try {
    const parsed = JSON.parse(settings.getSecret(`mcp:${id}`) || "{}");
    return { env: parsed.env ?? {}, headers: parsed.headers ?? {} };
  } catch {
    return { env: {}, headers: {} };
  }
}

function mcpConfigsForProxy() {
  return settings.values.mcpServers.map(({ envKeys, headerKeys, preset, account, ...server }) => {
    const secrets = mcpSecrets(server.id);
    return server.transport === "stdio" ? { ...server, env: secrets.env } : { ...server, headers: secrets.headers };
  });
}

async function pushMcpConfig() {
  if (!settings || !proxyRunning) return;
  const result = await proxyRequest("PUT", "/mcp", { servers: mcpConfigsForProxy() });
  if (!result.ok) console.error(`[pet] could not send the MCP list to the proxy: ${result.message}`);
}
/** Several changes in a row (a server and its secrets, a proxy restart) become one update. */
let mcpPushTimer;
function schedulePushMcp() {
  clearTimeout(mcpPushTimer);
  mcpPushTimer = setTimeout(() => void pushMcpConfig(), 250);
}

const MCP_ID = /^[A-Za-z0-9-]{1,40}$/;
const MCP_KEY = /^[A-Za-z0-9_.-]{1,100}$/;
/**
 * Adds or updates a server from the settings window. `secrets` null keeps the saved env values / headers.
 * `extra.account` (the GitHub login after "Sign in with GitHub") and `extra.github` (that sign-in's token answer, for
 * the refresh token) are set only by main, never by a page.
 */
function saveMcpServer(input, extra = {}) {
  if (!input || typeof input !== "object") return { ok: false, message: "invalid" };
  const { server, secrets } = input;
  if (!server || typeof server !== "object") return { ok: false, message: "invalid" };
  const existing = MCP_ID.test(String(server.id ?? "")) ? settings.values.mcpServers.find((s) => s.id === server.id) : undefined;
  if (!existing && settings.values.mcpServers.length >= 20) return { ok: false, message: "too-many" };
  const id = existing?.id ?? require("node:crypto").randomUUID().slice(0, 8);
  const clean = (record) =>
    Object.fromEntries(Object.entries(record && typeof record === "object" ? record : {}).filter(([k, v]) => MCP_KEY.test(k) && typeof v === "string"));
  const transport = server.transport === "http" ? "http" : "stdio";
  const next = {
    id,
    name: String(server.name ?? "").trim().slice(0, 60) || "MCP",
    enabled: typeof server.enabled === "boolean" ? server.enabled : (existing?.enabled ?? true),
    transport,
    ...(transport === "http"
      ? { url: String(server.url ?? "").trim().slice(0, 1000) }
      : {
          command: String(server.command ?? "").trim().slice(0, 500),
          args: (Array.isArray(server.args) ? server.args : []).map(String).filter(Boolean).slice(0, 40),
        }),
    ...(server.preset ? { preset: String(server.preset).slice(0, 40) } : {}),
    tools: existing?.tools ?? {},
    envKeys: existing?.envKeys ?? [],
    headerKeys: existing?.headerKeys ?? [],
  };
  // Signed in with GitHub: remember whose account (display only). New secrets from the page (a pasted token, or
  // "sign out") replace that sign-in, so the name goes too.
  const account = extra.account !== undefined ? extra.account : secrets ? undefined : existing?.account;
  if (account) next.account = String(account).slice(0, 100);
  if (transport === "stdio" && !next.command) return { ok: false, message: "command" };
  if (transport === "http") {
    let url;
    try {
      url = new URL(next.url);
    } catch {
      return { ok: false, message: "url" };
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { ok: false, message: "url" };
  }
  let secretValue;
  if (secrets) {
    const env = clean(secrets.env);
    const headers = clean(secrets.headers);
    next.envKeys = Object.keys(env);
    next.headerKeys = Object.keys(headers);
    secretValue = next.envKeys.length || next.headerKeys.length ? JSON.stringify({ env, headers }) : "";
  }
  const list = existing ? settings.values.mcpServers.map((s) => (s.id === id ? next : s)) : [...settings.values.mcpServers, next];
  if (!settings.isValid("mcpServers", list)) return { ok: false, message: "invalid" };
  if (secretValue !== undefined) {
    // Refresh token first: if the app stopped in between, the next refresh still has a token GitHub accepts.
    // New secrets from a page (a pasted token, "sign out") end a GitHub sign-in, so its refresh token goes.
    saveGitHubTokens(id, extra.github);
    settings.setSecret(`mcp:${id}`, secretValue);
  }
  settings.update({ mcpServers: list });
  return { ok: true, id };
}

// --- GitHub token refresh ------------------------------------------------------------------------------------
// The Tonarin OAuth App issues 8-hour access tokens with a 6-month refresh token. The refresh token and the expiry
// times are the secret "github:<id>"; the access token itself is the Authorization header in "mcp:<id>".
// A check every few minutes (and after sleep, when timers were paused) renews tokens that expire within 15 minutes.
// TONARIN_GITHUB_REFRESH_BEFORE_MIN=600 makes a fresh token count as due, to test the renewal right after signing in.
const GITHUB_REFRESH_BEFORE_MS = (Number(process.env.TONARIN_GITHUB_REFRESH_BEFORE_MIN) || 15) * 60_000;
const GITHUB_CHECK_MS = 5 * 60_000;

function saveGitHubTokens(id, answer) {
  const now = Date.now();
  const value =
    answer?.refreshToken && answer.expiresIn
      ? JSON.stringify({
          refreshToken: answer.refreshToken,
          expiresAt: now + answer.expiresIn * 1000,
          refreshExpiresAt: answer.refreshExpiresIn ? now + answer.refreshExpiresIn * 1000 : 0,
        })
      : "";
  if (value || settings.hasSecret(`github:${id}`)) settings.setSecret(`github:${id}`, value);
}

function savedGitHubTokens(id) {
  try {
    const saved = JSON.parse(settings.getSecret(`github:${id}`) || "null");
    return typeof saved?.refreshToken === "string" && Number.isFinite(saved.expiresAt) ? saved : undefined;
  } catch {
    return undefined;
  }
}

let githubRefreshing;
function refreshGitHubTokens() {
  if (!GITHUB_CLIENT_ID || !settings) return Promise.resolve();
  githubRefreshing ??= (async () => {
    for (const server of settings.values.mcpServers) {
      const saved = server.preset === "github" ? savedGitHubTokens(server.id) : undefined;
      if (!saved || saved.expiresAt - Date.now() > GITHUB_REFRESH_BEFORE_MS) continue;
      const flow = createDeviceFlow({ fetch: (url, init) => net.fetch(url, init), clientId: GITHUB_CLIENT_ID });
      try {
        const answer = await flow.refresh(saved.refreshToken);
        // Signed out or deleted while we were asking: drop the answer.
        if (savedGitHubTokens(server.id)?.refreshToken !== saved.refreshToken) continue;
        saveGitHubTokens(server.id, answer);
        const secrets = mcpSecrets(server.id);
        settings.setSecret(`mcp:${server.id}`, JSON.stringify({ env: secrets.env, headers: { ...secrets.headers, Authorization: `Bearer ${answer.token}` } }));
        console.log("[github] access token renewed");
      } catch (error) {
        const code = error?.code ?? "network";
        if (isTransient(error)) {
          console.error(`[github] could not renew the access token yet (${code}), trying again later`);
          continue;
        }
        // The refresh token was refused (expired after 6 months, or the app was revoked on github.com): sign in again.
        console.error(`[github] the sign-in ended (${code})`);
        const current = settings.values.mcpServers.find((s) => s.id === server.id);
        if (current) saveMcpServer({ server: { ...current, enabled: false }, secrets: { headers: {} } });
        notify(t("githubSignInEnded"), t("githubSignInEndedBody"));
      }
    }
  })().finally(() => {
    githubRefreshing = undefined;
  });
  return githubRefreshing;
}

/** First start under a new name: bring over settings, automations, reminders and usage from the old folder. */
function migrateFromPreviousName() {
  const target = app.getPath("userData");
  if (fs.existsSync(path.join(target, "settings.json"))) return;
  for (const name of PREVIOUS_NAMES) {
    const source = path.join(app.getPath("appData"), name);
    if (name === APP_NAME || !fs.existsSync(path.join(source, "settings.json"))) continue;
    fs.mkdirSync(target, { recursive: true });
    for (const file of ["settings.json", "automations.json", "reminders.json", "usage.json"]) {
      try {
        fs.copyFileSync(path.join(source, file), path.join(target, file), fs.constants.COPYFILE_EXCL);
        fs.chmodSync(path.join(target, file), 0o600);
      } catch {
        // missing in the old folder, or already there
      }
    }
    console.log(`[pet] copied the settings from "${name}"`);
    return;
  }
}

// --- IPC: settings -----------------------------------------------------------------------------------------
ipcMain.handle("settings:get", (event) => (fromOurPages(event) ? snapshot() : undefined));

ipcMain.handle("settings:set", (event, patch) => {
  if (!fromOurPages(event) || !patch || typeof patch !== "object") return snapshot();
  const { proxyKey: _ignored, ...allowed } = patch; // the pages never set the proxy key
  settings.update(allowed);
  return snapshot();
});

ipcMain.handle("settings:set-gemini-key", async (event, key) => {
  if (!fromOurPages(event)) return { ok: false };
  const value = typeof key === "string" ? key.trim() : "";
  if (!/^[A-Za-z0-9_.-]{20,200}$/.test(value)) return { ok: false, message: "format" };
  settings.setSecret("geminiApiKey", value);
  const restarted = await restartProxy();
  return { ok: true, restarted };
});

ipcMain.handle("settings:clear-gemini-key", async (event) => {
  if (!fromOurPages(event)) return { ok: false };
  settings.setSecret("geminiApiKey", "");
  const restarted = await restartProxy();
  return { ok: true, restarted };
});

ipcMain.handle("settings:test-gemini-key", async (event, key) => {
  if (!fromOurPages(event)) return { ok: false };
  const value = (typeof key === "string" && key.trim()) || settings.getSecret("geminiApiKey") || ENV_GEMINI_KEY;
  if (!value) return { ok: false, message: "no key" };
  try {
    const response = await net.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}`, {
      headers: { "x-goog-api-key": value },
    });
    if (response.ok) return { ok: true };
    let detail = "";
    try {
      detail = String((await response.json())?.error?.status ?? "");
    } catch {
      // not JSON
    }
    return { ok: false, message: `HTTP ${response.status}${detail ? ` ${detail}` : ""}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 120) : "network error" };
  }
});

ipcMain.handle("settings:open", (event, target) => {
  if (!fromOurPages(event)) return false;
  if (target in EXTERNAL_LINKS) return shell.openExternal(EXTERNAL_LINKS[target]).then(() => true);
  if (target === "settings-connection") {
    openSettings("connection"); // the pet, when it has no Gemini key yet
    return true;
  }
  if (target === "pets-folder") {
    fs.mkdirSync(CODEX_PETS_DIR, { recursive: true });
    return shell.openPath(CODEX_PETS_DIR).then(() => true);
  }
  if (target === "logs") {
    fs.mkdirSync(logDir(), { recursive: true });
    return shell.openPath(logDir()).then(() => true);
  }
  return false;
});

ipcMain.handle("settings:install-pet", (event) => (fromOurPages(event) ? chooseAndInstallPet() : { ok: false }));
ipcMain.handle("settings:restart-proxy", (event) => (fromOurPages(event) ? restartProxy() : false));
const AUTOMATION_ID = /^[A-Za-z0-9-]{1,40}$/;
ipcMain.handle("settings:automations", (event) => (fromOurPages(event) ? automationsRequest("GET", "/automations") : undefined));
ipcMain.handle("settings:automation-save", (event, automation) =>
  fromOurPages(event) && automation && typeof automation === "object" ? automationsRequest("POST", "/automations", automation) : undefined,
);
ipcMain.handle("settings:automation-delete", (event, id) =>
  fromOurPages(event) && AUTOMATION_ID.test(String(id)) ? automationsRequest("DELETE", `/automations/${id}`) : undefined,
);
ipcMain.handle("settings:automation-run", (event, id) =>
  fromOurPages(event) && AUTOMATION_ID.test(String(id)) ? automationsRequest("POST", `/automations/${id}/run`) : undefined,
);
ipcMain.handle("settings:automation-clear-history", (event) =>
  fromOurPages(event) ? automationsRequest("DELETE", "/automations/history") : undefined,
);

ipcMain.handle("settings:usage", (event) => (fromOurPages(event) ? proxyRequest("GET", "/usage") : undefined));

// --- Sign in with GitHub (device flow) for the GitHub MCP connection ------------------------------------------------
// The page gets the short code to show; the token stays here and goes straight into the keychain.
let githubFlow;
ipcMain.handle("settings:github-signin", async (event, input) => {
  if (!fromOurPages(event)) return undefined;
  if (!GITHUB_CLIENT_ID) return { ok: false, message: "no-client" };
  const draft = input?.server && typeof input.server === "object" ? input.server : {};
  githubFlow?.abort();
  const controller = new AbortController();
  githubFlow = controller;
  const flow = createDeviceFlow({ fetch: (url, init) => net.fetch(url, init), clientId: GITHUB_CLIENT_ID });
  let started;
  try {
    started = await flow.start(input?.includePrivate === false ? "read:user" : "repo read:org");
  } catch (error) {
    console.error(`[github] could not start the sign-in: ${error?.code ?? "error"}`);
    return { ok: false, message: error?.code ?? "error" };
  }
  clipboard.writeText(started.userCode);
  if (started.verificationUri.startsWith("https://github.com/")) void shell.openExternal(started.verificationUri);
  const send = (payload) => settingsWin?.webContents.send("settings:github-auth", payload);
  void (async () => {
    try {
      const answer = await flow.waitForToken(started, controller.signal);
      const login = await flow.whoAmI(answer.token).catch(() => "");
      const result = saveMcpServer(
        {
          // Always GitHub's own MCP server: the token is never sent anywhere else.
          server: { ...draft, transport: "http", url: GITHUB_MCP_URL, preset: "github" },
          secrets: { headers: { Authorization: `Bearer ${answer.token}`, "X-MCP-Readonly": "true" } },
        },
        { account: login, github: answer },
      );
      console.log(`[github] signed in${login ? ` as ${login}` : ""}`);
      send(result.ok ? { state: "done", id: result.id, login } : { state: "error", message: result.message });
    } catch (error) {
      const code = error?.code ?? "error";
      if (code !== "cancelled") console.error(`[github] sign-in ended: ${code}`);
      send({ state: code === "cancelled" ? "cancelled" : "error", message: code });
    } finally {
      if (githubFlow === controller) githubFlow = undefined;
    }
  })();
  return { ok: true, userCode: started.userCode, expiresIn: started.expiresIn };
});
ipcMain.handle("settings:github-cancel", (event) => {
  if (fromOurPages(event)) githubFlow?.abort();
  return true;
});
ipcMain.handle("settings:mcp-list", async (event) => {
  if (!fromOurPages(event)) return undefined;
  const status = await proxyRequest("GET", "/mcp");
  return { servers: settings.values.mcpServers, status: status.ok ? status.data.servers : null };
});
ipcMain.handle("settings:mcp-save", (event, input) => {
  if (!fromOurPages(event)) return undefined;
  try {
    return saveMcpServer(input);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle("settings:mcp-delete", (event, id) => {
  if (!fromOurPages(event) || !MCP_ID.test(String(id))) return undefined;
  settings.update({ mcpServers: settings.values.mcpServers.filter((s) => s.id !== id) });
  saveGitHubTokens(id, undefined);
  settings.setSecret(`mcp:${id}`, "");
  return { ok: true };
});
ipcMain.handle("settings:mcp-set-tool", (event, id, tool, enabled) => {
  if (!fromOurPages(event) || !MCP_ID.test(String(id)) || typeof tool !== "string" || tool.length > 200) return undefined;
  const list = settings.values.mcpServers.map((s) => (s.id === id ? { ...s, tools: { ...s.tools, [tool]: Boolean(enabled) } } : s));
  settings.update({ mcpServers: list });
  return { ok: true };
});
ipcMain.handle("settings:mcp-enable", (event, id, enabled) => {
  if (!fromOurPages(event) || !MCP_ID.test(String(id))) return undefined;
  settings.update({ mcpServers: settings.values.mcpServers.map((s) => (s.id === id ? { ...s, enabled: Boolean(enabled) } : s)) });
  return { ok: true };
});
ipcMain.handle("settings:mcp-reconnect", (event, id) =>
  fromOurPages(event) && MCP_ID.test(String(id)) ? proxyRequest("POST", `/mcp/${id}/reconnect`) : undefined,
);
ipcMain.handle("settings:mcp-test", (event, id, tool) =>
  fromOurPages(event) && MCP_ID.test(String(id)) && typeof tool === "string" && tool.length <= 200
    ? proxyRequest("POST", `/mcp/${id}/test`, { tool })
    : undefined,
);

ipcMain.handle("settings:reconnect", (event) => {
  if (fromOurPages(event)) sendToPet("reconnect");
  return true;
});

// --- startup -----------------------------------------------------------------------------------------------
app.whenReady().then(async () => {
  logToFile();
  watchEventLoop();
  migrateFromPreviousName();
  settings = new Settings(app.getPath("userData"));
  t = translator(uiLanguage());
  settings.on("change", (keys) => {
    if (keys.includes("language")) {
      t = translator(uiLanguage());
      setApplicationMenu();
      updateTrayMenu();
    }
    if (keys.includes("launchAtLogin") && app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.values.launchAtLogin });
    if (keys.some((key) => key === "mcpServers" || key.startsWith("secret:mcp:"))) schedulePushMcp();
    broadcastSettings();
  });

  protocol.handle("pet", (request) => {
    const { pathname } = new URL(request.url);
    const codex = /^\/codex-pets\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (codex) {
      const file = pets.sheetFile(codex[1], codex[2]);
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response("Not found", { status: 404 });
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const file = path.normalize(path.join(UI_DIR, decoded));
    if (!file.startsWith(UI_DIR + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Only the microphone, only for our own pages.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnly = (details.mediaTypes ?? []).every((type) => type === "audio");
    callback(permission === "media" && audioOnly && webContents.getURL().startsWith(PET_URL));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === "media");

  if (process.platform === "darwin") {
    app.dock?.hide(); // a pet, not an app window: the menu bar icon and the pet's right-click menu are the controls
    await systemPreferences.askForMediaAccess("microphone");
  }

  setApplicationMenu();
  createTray();
  await ensureProxy();
  createPetWindow();
  if (geminiKeySource() === "none") openSettings("connection"); // first run: ask for the key

  // A display was unplugged or rearranged: keep the pet on a screen, with room for its bubble.
  for (const change of ["display-removed", "display-added", "display-metrics-changed"]) screen.on(change, () => layoutWindow());

  // GitHub access tokens last 8 hours: renew them now if the Mac was off, then keep checking.
  void refreshGitHubTokens();
  setInterval(() => void refreshGitHubTokens(), GITHUB_CHECK_MS);
  powerMonitor.on("resume", () => void refreshGitHubTokens()); // timers do not run while the Mac sleeps

  // Nobody is listening while the Mac sleeps or is locked: let the pet sleep too (mic off, disconnected).
  powerMonitor.on("suspend", () => sendToPet("sleep"));
  powerMonitor.on("lock-screen", () => {
    screenLocked = true;
    sendToPet("sleep");
  });
  powerMonitor.on("unlock-screen", () => {
    screenLocked = false;
    if (wakeOnUnlock) {
      wakeOnUnlock = false;
      sendToPet("wake"); // something came due while you were away
    }
  });
});

app.on("window-all-closed", () => {
  // Closing the settings window must not quit the app; the pet window is the one that matters.
  if (!win) app.quit();
});
let stoppingProxy = false;
app.on("will-quit", (event) => {
  // Let the proxy shut down gracefully first: it also stops the Copilot runtime it started.
  if (!proxyChild || stoppingProxy) return;
  stoppingProxy = true;
  event.preventDefault();
  Promise.race([proxyChild.stop(), new Promise((resolve) => setTimeout(resolve, 6000))]).finally(() => app.quit());
});
