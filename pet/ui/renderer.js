/**
 * Pet page: mic -> proxy -> Gemini Live -> speakers, plus the character's looks and states.
 *
 * Protocol with the proxy (/v1/live):
 *   send  text   {type:"hello", key} first, then {type:"audio_end"} / {type:"reset"}
 *   send  binary 16-bit PCM, 16 kHz, mono (40 ms chunks)
 *   recv  binary 16-bit PCM, 24 kHz, mono
 *   recv  text   {type:"status"|"transcript"|"tool"|"interrupted"|"turn_complete", ...}
 *
 * Settings come from the main process (settings window, menus) and apply live; see onSettings().
 *
 * Sleep: after the idle time set in the settings (and when the Mac sleeps or locks), the pet
 * releases the microphone and disconnects, so nothing is sent while you are away. Click to wake it.
 *
 * Characters: the bundled SVG characters below, plus Codex / ChatGPT pets found in ~/.codex/pets
 * (spritesheets, played by sprite.js). The main process scans that folder and serves the images.
 */
import { CHARACTERS, characterName } from "./characters.js";
import { applyI18n, getLanguage, setLanguage, t } from "./i18n.js";
import { loadSprite, ROW } from "./sprite.js";
import { createSpeechGate } from "./speech-gate.js";

const root = document.documentElement;
const petEl = document.getElementById("pet");
const characterEl = document.getElementById("character");
const bubbleEl = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const bubbleScroll = document.getElementById("bubble-scroll");
const bubbleYou = document.getElementById("bubble-you");
const bubbleYouText = document.getElementById("bubble-you-text");
const bubbleCard = document.getElementById("bubble-card");
const cardOriginal = document.getElementById("card-original");
const cardBetter = document.getElementById("card-better");
const cardNote = document.getElementById("card-note");
const sizePanel = document.getElementById("size-panel");
const sizeSlider = document.getElementById("size-slider");
const sizeValue = document.getElementById("size-value");
const sizeDone = document.getElementById("size-done");

/** Codex / ChatGPT pets from ~/.codex/pets: [{ id: "codex:<folder>", name, url }], filled from the main process. */
let codexPets = [];

/** Which spritesheet row plays in each state. Codex pets have no talking animation, so speaking bounces instead. */
const SPRITE_ROW_FOR_LOOK = {
  idle: ROW.idle,
  listening: ROW.waiting,
  thinking: ROW.running,
  speaking: ROW.idle,
  connecting: ROW.idle,
  error: ROW.failed,
  sleeping: ROW.idle,
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 2;
const CAPTION_CHARS = 800; // one reply; the bubble scrolls when it is long

const state = {
  conn: "connecting", // connecting | ready | error
  sleeping: false,
  muted: false,
  captions: true,
  showYou: true, // show what you said above the pet's reply
  echoGuard: false,
  character: "mochi",
  scale: 1,
  tools: 0,
  speaking: false,
  userSpeakingUntil: 0,
  lastActivity: performance.now(),
};

let config;
let snap; // latest settings snapshot from the main process
let ws;
let reconnectDelay = 1000;
let waitingForKey = false; // no Gemini API key yet: no mic, no connection, a click opens Settings > Connection
let reconnectTimer;
let mic;
let player;
let mouth; // { el, kind, base..., open... } of the loaded SVG character
let sprite; // SpritePlayer of the loaded Codex pet
let mouthLevel = 0;
/** The exchange on screen: what you said and the pet's reply (filler + answer after a tool call). */
let exchange = { you: "", reply: "", closed: true, card: null };
let bubbleTimer;
let silentSince = 0;

// ---------------------------------------------------------------------------
// Settings (owned by the main process; this page only asks for changes)
// ---------------------------------------------------------------------------
function saveSetting(patch) {
  void window.pet.settings.set(patch);
}

/** What the proxy needs for a Gemini session. A change starts a new session. */
function sessionOptions() {
  const values = snap.values;
  // Modes (english practice, focus) are implemented in the proxy but not offered for now: always the everyday buddy.
  const mode = "companion";
  const language = snap.speechLanguage;
  return {
    mode,
    language,
    uiLanguage: snap.uiLanguage,
    voice: values.voice,
    persona: values.persona,
    silenceMs: values.silenceMs,
    noiseFilter: values.noiseFilter,
    feeds: values.feeds ?? snap.catalog.defaultFeeds[language],
    useCopilot: values.useCopilot,
  };
}

/** Older versions kept preferences in this page's localStorage: move them to the app settings once. */
async function migrateLocalPrefs() {
  if (snap.values.migratedLocalPrefs) return;
  const patch = { migratedLocalPrefs: true };
  try {
    const raw = localStorage.getItem("pet.prefs");
    if (raw !== null) {
      const saved = JSON.parse(raw);
      for (const key of ["character", "captions", "showYou", "echoGuard", "scale"]) if (key in saved) patch[key] = saved[key];
      // The older versions only spoke Japanese: keep that for people who upgrade (they can switch in the settings).
      if (snap.values.language === "auto") patch.language = "ja";
      if (snap.values.speechLanguage === "auto") patch.speechLanguage = "ja";
    }
    localStorage.removeItem("pet.prefs");
  } catch {
    // nothing to migrate
  }
  snap = await window.pet.settings.set(patch);
}

async function onSettings(next) {
  const previous = snap;
  snap = next;
  const values = snap.values;
  if (getLanguage() !== snap.uiLanguage) {
    setLanguage(snap.uiLanguage);
    applyI18n();
  }
  state.captions = values.captions;
  state.showYou = values.showYou;
  state.echoGuard = values.echoGuard;
  if (Math.abs(values.scale - state.scale) > 0.004 && !scaleSaveTimer) applyScale(values.scale, false);
  if (previous && values.character !== previous.values.character && values.character !== state.character) {
    await loadCharacter(values.character).catch((error) => {
      console.error(error);
      showBubble(t("pet.loadCharacterError"), "error", 4000);
    });
  }
  if (!state.captions && !bubbleEl.classList.contains("error")) hideBubble();
  // Voice, language, personality, news or Copilot changed: start a new session with the new options.
  if (previous && JSON.stringify(sessionOptionsFrom(previous)) !== JSON.stringify(sessionOptions()) && !state.sleeping && ws) {
    reconnectDelay = 1000;
    connect();
    showBubble(t("pet.applied"), "hint", 2500);
  }
}

function sessionOptionsFrom(snapshot) {
  const keep = snap;
  snap = snapshot;
  const options = sessionOptions();
  snap = keep;
  return options;
}

// ---------------------------------------------------------------------------
// Speech bubble
// ---------------------------------------------------------------------------
function showBubble(text, kind = "", hideAfterMs = 0, you = "", card = null) {
  clearTimeout(bubbleTimer);
  bubbleEl.className = `bubble ${kind}`.trim();
  bubbleYouText.textContent = you;
  bubbleYou.hidden = !you;
  bubbleText.textContent = text;
  bubbleText.hidden = !text;
  bubbleCard.hidden = !card;
  if (card) {
    cardOriginal.textContent = card.original;
    cardBetter.textContent = card.better;
    cardNote.textContent = card.note ?? "";
  }
  bubbleEl.hidden = false;
  if (!hoveringBubble) bubbleScroll.scrollTop = bubbleScroll.scrollHeight; // keep the newest line in view
  if (hideAfterMs) hideBubbleLater(hideAfterMs);
  fitWindowToBubble();
}
function hideBubble() {
  clearTimeout(bubbleTimer);
  bubbleEl.hidden = true;
  fitWindowToBubble();
}
function hideBubbleLater(ms) {
  clearTimeout(bubbleTimer);
  pendingHideMs = ms;
  if (!hoveringBubble) bubbleTimer = setTimeout(hideBubble, ms);
}

// The window grows upward when a long reply needs more room, and shrinks back afterwards.
let bubbleFrame;
let lastBubbleSpace = 0;
function fitWindowToBubble() {
  cancelAnimationFrame(bubbleFrame);
  bubbleFrame = requestAnimationFrame(() => {
    placeBubbleHorizontally();
    const needed = bubbleEl.hidden ? 0 : Math.ceil(bubbleEl.getBoundingClientRect().height + 20);
    if (Math.abs(needed - lastBubbleSpace) < 4) return;
    lastBubbleSpace = needed;
    window.pet.setBubbleSpace(needed);
  });
}

// Where main put the window around the pet: the bubble goes above or below the pet, may be only so tall, and sits
// next to the pet, which is off-center in the window when it is near the left or right edge of the screen.
let layout = { placement: "above", petLeft: null };
function applyLayout(placement, petTop, petLeft, room) {
  layout = { placement, petLeft };
  const root = document.documentElement;
  root.dataset.bubble = placement;
  root.style.setProperty("--pet-top", `${petTop}px`);
  root.style.setProperty("--bubble-room", `${Math.max(90, room)}px`);
  placePet();
  fitWindowToBubble(); // the room may have changed the bubble's height
}
/** The pet's left edge in the window. Its margin is scaled by its own zoom, hence the division. */
function placePet() {
  if (layout.petLeft === null) return;
  petEl.style.marginLeft = `${layout.petLeft / state.scale}px`;
}
function placeBubbleHorizontally() {
  const width = bubbleEl.offsetWidth;
  const windowWidth = window.innerWidth;
  const petWidth = petEl.getBoundingClientRect().width;
  const petCenter = layout.petLeft === null ? windowWidth / 2 : layout.petLeft + petWidth / 2;
  // The bubble is centered in the window by default: move it toward the pet, but keep it inside the window.
  const room = Math.max(0, windowWidth / 2 - width / 2 - 6);
  const shift = Math.max(-room, Math.min(room, petCenter - windowWidth / 2));
  const tailRoom = Math.max(0, width / 2 - 20); // the tail stays on the bubble
  const tail = Math.max(-tailRoom, Math.min(tailRoom, petCenter - (windowWidth / 2 + shift)));
  const root = document.documentElement;
  root.style.setProperty("--bubble-shift", `${Math.round(shift)}px`);
  root.style.setProperty("--tail-shift", `${Math.round(tail)}px`);
}

// Hovering the bubble keeps it open (and lets you scroll back through a long reply).
let hoveringBubble = false;
let pendingHideMs = 0;
bubbleEl.addEventListener("mouseenter", () => {
  hoveringBubble = true;
  clearTimeout(bubbleTimer);
});
bubbleEl.addEventListener("mouseleave", () => {
  hoveringBubble = false;
  if (pendingHideMs && !bubbleEl.hidden) bubbleTimer = setTimeout(hideBubble, 3000);
});

function friendlyError(message = "") {
  if (/quota|exhausted|429|rate/i.test(message)) return t("pet.errorQuota");
  if (/api key|permission|denied|401|403|unauthenticated/i.test(message)) return t("pet.errorKey");
  return t("pet.errorGeneric", { message });
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------
async function refreshCodexPets() {
  try {
    const pets = await window.pet.codexPets();
    if (Array.isArray(pets)) codexPets = pets;
  } catch {
    // keep the old list
  }
}

async function loadCharacter(id) {
  if (id.startsWith("codex:") && !codexPets.some((p) => p.id === id)) await refreshCodexPets();
  const pet = codexPets.find((p) => p.id === id);
  if (pet) {
    sprite = await loadSprite(characterEl, pet.url, 190);
    mouth = undefined;
    state.character = pet.id;
    root.dataset.kind = "sprite";
    root.dataset.character = pet.id;
    return;
  }

  const character = CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
  const response = await fetch(`characters/${character.id}.svg`);
  if (!response.ok) throw new Error(`characters/${character.id}.svg: HTTP ${response.status}`);
  characterEl.innerHTML = await response.text(); // our own bundled files; the page CSP blocks scripts anyway
  sprite = undefined;
  state.character = character.id;
  root.dataset.kind = "svg";
  root.dataset.character = character.id;

  const el = characterEl.querySelector("#mouth");
  const num = (name, fallback = 0) => Number(el?.getAttribute(name) ?? fallback);
  if (!el) mouth = undefined;
  else if (el.tagName.toLowerCase() === "rect") {
    const w = num("width");
    const h = num("height");
    mouth = { el, kind: "rect", cx: num("x") + w / 2, cy: num("y") + h / 2, w, h, openW: num("data-open-w"), openH: num("data-open-h", 8) };
  } else {
    mouth = { el, kind: "ellipse", rx: num("rx"), ry: num("ry"), openRx: num("data-open-rx"), openRy: num("data-open-ry", 8) };
  }
}

// ---------------------------------------------------------------------------
// Size: CSS zoom on the pet, and the window follows (main keeps the pet's feet in place)
// ---------------------------------------------------------------------------
let scaleFrame;
let scaleSaveTimer;
/** `persist` is false when the change came from the settings (nothing to save back). */
function applyScale(scale, persist = true) {
  if (!Number.isFinite(scale)) return;
  state.scale = Math.round(Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE) * 100) / 100;
  petEl.style.zoom = String(state.scale);
  placePet(); // its margin is zoomed too
  if (!sizePanel.hidden) showSliderValue();
  cancelAnimationFrame(scaleFrame);
  scaleFrame = requestAnimationFrame(() => window.pet.setScale(state.scale));
  if (!persist) return;
  clearTimeout(scaleSaveTimer);
  scaleSaveTimer = setTimeout(() => {
    scaleSaveTimer = undefined;
    saveSetting({ scale: state.scale });
  }, 300);
}

// Slider panel (right-click > サイズ > スライダーで調整…). It sits at the bottom of the window, which stays
// in place while the window grows upward, so the slider does not move away from the pointer.
let sizePanelTimer;
function showSliderValue() {
  sizeSlider.value = String(Math.round(state.scale * 100));
  sizeValue.textContent = `${sizeSlider.value}%`;
}
function keepSizePanelOpen() {
  clearTimeout(sizePanelTimer);
  sizePanelTimer = setTimeout(closeSizePanel, 10_000); // closes itself after 10 s without touching it
}
function openSizePanel() {
  showSliderValue();
  hideBubble();
  sizePanel.hidden = false;
  keepSizePanelOpen();
}
function closeSizePanel() {
  if (sizePanel.hidden) return;
  sizePanel.hidden = true;
  clearTimeout(sizePanelTimer);
}
sizeSlider.addEventListener("input", () => {
  applyScale(Number(sizeSlider.value) / 100);
  keepSizePanelOpen();
});
sizePanel.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey) return; // pinch is handled on the pet
    event.preventDefault();
    applyScale(state.scale + (event.deltaY < 0 ? 0.05 : -0.05));
    keepSizePanelOpen();
  },
  { passive: false },
);
sizeDone.addEventListener("click", closeSizePanel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSizePanel();
});
window.addEventListener("blur", closeSizePanel);

// ---------------------------------------------------------------------------
// State -> look
// ---------------------------------------------------------------------------
function render() {
  let look;
  if (state.sleeping) look = "sleeping";
  else if (state.conn === "error") look = "error";
  else if (state.conn !== "ready") look = "connecting";
  else if (state.speaking) look = "speaking";
  else if (state.tools > 0) look = "thinking";
  else if (!state.muted && performance.now() < state.userSpeakingUntil) look = "listening";
  else look = "idle";
  if (root.dataset.state !== look) root.dataset.state = look;
  root.dataset.muted = String(state.muted);
  reportState();
  return look;
}

// The menu bar icon's menu shows mute and sleep, so tell the main process when they change.
let reported = "";
function reportState() {
  const current = JSON.stringify({ muted: state.muted, sleeping: state.sleeping, conn: state.conn });
  if (current === reported) return;
  reported = current;
  window.pet.reportState({ muted: state.muted, sleeping: state.sleeping, conn: state.conn });
}

function animate() {
  const look = render();
  const open = state.speaking ? Math.min(1, mouthLevel * 9) : 0;
  if (sprite) {
    const row = drag?.moved ? (drag.dir < 0 ? ROW.runLeft : ROW.runRight) : SPRITE_ROW_FOR_LOOK[look] ?? ROW.idle;
    sprite.update(performance.now(), row, { paused: look === "sleeping", speed: look === "speaking" ? 1.4 : 1, lift: open });
  }
  if (mouth) {
    if (mouth.kind === "rect") {
      const w = mouth.w + open * mouth.openW;
      const h = mouth.h + open * mouth.openH;
      mouth.el.setAttribute("x", (mouth.cx - w / 2).toFixed(2));
      mouth.el.setAttribute("y", (mouth.cy - h / 2).toFixed(2));
      mouth.el.setAttribute("width", w.toFixed(2));
      mouth.el.setAttribute("height", h.toFixed(2));
    } else {
      mouth.el.setAttribute("rx", (mouth.rx + open * mouth.openRx).toFixed(2));
      mouth.el.setAttribute("ry", (mouth.ry + open * mouth.openRy).toFixed(2));
    }
  }
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
async function startPlayer() {
  const ctx = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("audio-worklets.js");
  const node = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [1] });
  node.connect(ctx.destination);
  node.port.onmessage = ({ data }) => onPlayerLevel(data.level, data.playing);
  await ctx.resume();
  player = {
    push: (buffer) => node.port.postMessage({ type: "push", pcm: buffer }, [buffer]),
    clear: () => node.port.postMessage({ type: "clear" }),
    flush: () => node.port.postMessage({ type: "flush" }),
  };
}

/**
 * The microphone is open only while the pet is awake and not muted, so the macOS mic indicator always
 * matches the mute badge. Calls are queued, so fast clicks cannot open two microphones.
 */
let micQueue = Promise.resolve(true);
function syncMic() {
  micQueue = micQueue.then(async () => {
    const wanted = !state.muted && !state.sleeping;
    try {
      if (wanted && !mic) await openMic();
      if (!wanted && mic) closeMic();
      return true;
    } catch (error) {
      console.error(error);
      showMicError();
      return false;
    }
  });
  return micQueue;
}

async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Echo cancellation lets you interrupt the pet without headphones.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("audio-worklets.js");
  const capture = new AudioWorkletNode(ctx, "pcm-capture", { processorOptions: { targetRate: 16000, chunkSamples: 640 } });
  const sink = ctx.createGain();
  sink.gain.value = 0; // keeps the graph pulling audio without playing the mic back
  ctx.createMediaStreamSource(stream).connect(capture).connect(sink).connect(ctx.destination);
  capture.port.onmessage = ({ data }) => onMicChunk(data.pcm, data.level, data.low);
  await ctx.resume();
  speechGate.reset(); // learn this room (and this microphone) afresh
  mic = { stream, ctx };
}

/** Fully releases the microphone (the macOS mic indicator turns off). */
function closeMic() {
  if (!mic) return;
  for (const track of mic.stream.getTracks()) track.stop();
  mic.ctx.close().catch(() => {});
  mic = undefined;
}

// Room noise (typing, a fan, a door) must not start a conversation: only voice-like audio goes to Gemini, with a
// little audio from before it, until your voice has been gone longer than the end-of-turn pause (speech-gate.js).
const speechGate = createSpeechGate();
let lastNoiseFilter;
function onMicChunk(pcm, level, low = level) {
  const now = performance.now();
  const filter = snap?.values.noiseFilter ?? "standard";
  if (filter !== lastNoiseFilter) {
    lastNoiseFilter = filter;
    speechGate.reset();
  }
  const { send, voice, ended } = speechGate.push({
    pcm,
    level,
    low,
    now,
    filter,
    silenceMs: snap?.values.silenceMs ?? 700,
    petSpeaking: state.speaking,
  });
  if (!state.muted && voice) state.userSpeakingUntil = now + 400;
  if (state.sleeping || state.muted || state.conn !== "ready" || ws?.readyState !== WebSocket.OPEN) return;
  if (state.echoGuard && state.speaking) return; // speaker mode: do not let the pet hear itself
  for (const chunk of send) ws.send(chunk);
  if (ended) ws.send(JSON.stringify({ type: "audio_end" })); // nothing more until the next voice: let Gemini wrap up
}

function onPlayerLevel(level, playing) {
  mouthLevel = mouthLevel * 0.5 + level * 0.5;
  const now = performance.now();
  if (playing) {
    silentSince = 0;
    state.speaking = true;
    state.lastActivity = now;
  } else if (state.speaking) {
    silentSince ||= now;
    if (now - silentSince > 250) state.speaking = false; // bridge tiny gaps between chunks
  }
}

function setMuted(muted) {
  state.muted = muted;
  state.lastActivity = performance.now();
  if (muted && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audio_end" }));
  syncMic();
  showBubble(muted ? t("pet.muted") : t("pet.unmuted"), "hint", 2500);
}

// ---------------------------------------------------------------------------
// Sleep and wake
// ---------------------------------------------------------------------------
function sleep(reason) {
  if (state.sleeping) return;
  state.sleeping = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null; // no automatic reconnect while asleep
    ws.close();
    ws = undefined;
  }
  syncMic();
  player?.clear();
  state.speaking = false;
  state.tools = 0;
  state.conn = "connecting";
  showBubble(reason === "idle" ? t("pet.sleepIdle") : t("pet.sleep"), "hint", 6000);
}

async function wake() {
  if (!state.sleeping) return;
  state.sleeping = false;
  state.lastActivity = performance.now();
  if (waitingForKey) {
    showBubble(t("pet.needKey"), "hint", 0); // nothing to connect to until a key is saved
    return;
  }
  hideBubble();
  if (!(await syncMic())) return;
  reconnectDelay = 1000;
  connect();
}

// A new session is needed for new tools, and it starts without the conversation so far: wait for a quiet moment
// (nothing playing, no tool running, nobody spoke for 5 s). Asleep, the next wake connects with the new tools anyway.
let toolsRefreshPending = false;
function refreshToolsWhenQuiet() {
  if (!toolsRefreshPending) return;
  if (state.sleeping || !ws) {
    toolsRefreshPending = false;
    return;
  }
  if (state.speaking || state.tools > 0 || performance.now() - state.lastActivity < 5000) return;
  toolsRefreshPending = false;
  reconnectDelay = 1000;
  connect();
}

function checkIdle() {
  const minutes = snap?.values.idleMinutes ?? 0;
  if (state.sleeping || waitingForKey || minutes <= 0 || state.speaking || state.tools > 0) return;
  if (performance.now() - state.lastActivity > minutes * 60_000) sleep("idle");
}

// ---------------------------------------------------------------------------
// Connection to the proxy
// ---------------------------------------------------------------------------
function connect() {
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) {
    ws.onclose = null;
    ws.close();
  }
  state.conn = "connecting";
  const socket = new WebSocket(config.wsUrl);
  socket.binaryType = "arraybuffer";
  ws = socket;
  let opened = false;

  socket.onopen = () => {
    opened = true;
    reconnectDelay = 1000;
    socket.send(JSON.stringify({ type: "hello", key: config.key, options: sessionOptions() }));
  };
  socket.onmessage = ({ data }) => {
    if (typeof data !== "string") {
      player?.push(data);
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    onServerMessage(message);
  };
  socket.onclose = (event) => {
    if (ws !== socket) return;
    player?.clear();
    state.speaking = false;
    state.tools = 0;
    if (event.code === 4401) {
      state.conn = "error";
      showBubble(t("pet.proxyKeyMismatch"), "error");
      return;
    }
    state.conn = state.conn === "error" ? "error" : "connecting";
    if (!opened) showBubble(t("pet.proxyWaiting"), "hint");
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  };
}

let greeted = false;
function onServerMessage(message) {
  switch (message.type) {
    case "status":
      if (message.state === "ready") {
        if (state.conn !== "ready") sprite?.playOnce(ROW.waving); // say hello
        state.conn = "ready";
        if (!greeted) {
          greeted = true;
          showBubble(snap.gemini.source === "none" ? t("pet.needKey") : t("pet.greet"), "hint", 5000);
        } else if (bubbleEl.classList.contains("error") || bubbleEl.classList.contains("hint")) {
          hideBubble();
        }
      } else if (message.state === "error") {
        state.conn = "error";
        showBubble(friendlyError(message.message), "error");
      } else {
        state.conn = "connecting";
        if (message.message) showBubble(message.message, "hint");
      }
      break;

    case "transcript":
      state.lastActivity = performance.now();
      if (message.role === "user") {
        state.userSpeakingUntil = performance.now() + 600;
        // You started a new utterance after the pet answered: start a new exchange.
        if (exchange.closed && exchange.reply) exchange = { you: "", reply: "", closed: false, card: null };
        exchange.you = (exchange.you + message.text).slice(-CAPTION_CHARS);
      } else {
        exchange.reply = (exchange.reply + message.text).slice(-CAPTION_CHARS);
        exchange.closed = false;
      }
      clearTimeout(bubbleTimer); // still talking: keep the bubble up
      showCaption();
      break;

    case "tool":
      state.lastActivity = performance.now();
      state.tools = Math.max(0, state.tools + (message.phase === "start" ? 1 : -1));
      if (message.phase === "end" && message.name === "ask_copilot") sprite?.playOnce(ROW.jumping); // Copilot's answer is in
      break;

    case "display": // something a tool wants to show, such as an English correction card
      if (message.kind === "correction" && typeof message.better === "string") {
        exchange.card = { original: String(message.original ?? ""), better: message.better, note: String(message.note ?? "") };
        clearTimeout(bubbleTimer);
        showCaption();
      }
      break;

    case "announce": // the app has something to say on its own, such as a reminder that came due
      state.lastActivity = performance.now();
      if (message.kind === "reminder") {
        chime();
        exchange = { you: "", reply: "", closed: false, card: null };
        showBubble(`⏰ ${String(message.label ?? "")}`, "reminder", 30_000);
      }
      break;

    case "interrupted": // the user spoke over the pet: stop talking right away
      player?.clear();
      state.speaking = false;
      exchange.closed = true;
      break;

    case "turn_complete":
      player?.flush();
      exchange.closed = true;
      if (!bubbleEl.classList.contains("error") && !bubbleEl.classList.contains("hint")) {
        const length = exchange.you.length + exchange.reply.length;
        hideBubbleLater(Math.min(20_000, 6000 + length * 60)); // longer exchanges stay up longer
      }
      break;
  }
}

function showCaption() {
  if (!state.captions) return;
  const you = state.showYou ? exchange.you.trim() : "";
  const reply = exchange.reply.trim();
  if (!you && !reply && !exchange.card) {
    if (!bubbleEl.classList.contains("error") && !bubbleEl.classList.contains("hint")) hideBubble();
    return;
  }
  showBubble(reply, "", 0, you, exchange.card);
}

// A short two-note chime for reminders (generated here, no audio files).
let chimeContext;
function chime() {
  try {
    chimeContext ??= new AudioContext();
    const start = chimeContext.currentTime + 0.02;
    [880, 1318.5].forEach((frequency, i) => {
      const oscillator = chimeContext.createOscillator();
      const gain = chimeContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const t0 = start + i * 0.16;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      oscillator.connect(gain).connect(chimeContext.destination);
      oscillator.start(t0);
      oscillator.stop(t0 + 0.55);
    });
  } catch (error) {
    console.error(error);
  }
}

// ---------------------------------------------------------------------------
// Mouse: drag to move, click to mute (or wake), right-click or press-and-hold for the menu
// ---------------------------------------------------------------------------
// Press and hold also opens the menu: on some Macs a two-finger click shortly after a normal click arrives as a
// plain left click (seen on macOS 26.7 in every app, Finder too), which would toggle the mic instead. The menu opens
// when the button is released after the hold, so no native menu ever starts while the button is still down.
const HOLD_MS = 550;
let drag;
let holdTimer;
petEl.addEventListener("pointerdown", (event) => {
  if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
    // A right click (or Control-click, the Mac's other right click): the menu, never a drag or a mute toggle.
    expectMenu();
    return;
  }
  if (event.button !== 0) return;
  drag = { x: event.screenX, y: event.screenY, moved: false, held: false };
  petEl.setPointerCapture(event.pointerId);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (!drag || drag.moved) return;
    drag.held = true;
    petEl.classList.add("hold-ready"); // "let go to open the menu"
  }, HOLD_MS);
});
petEl.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  clearTimeout(holdTimer);
  petEl.classList.remove("hold-ready");
  drag.moved = true;
  drag.held = false;
  if (Math.abs(dx) > 0.5) drag.dir = Math.sign(dx);
  window.pet.moveBy(dx, dy);
  drag.x = event.screenX;
  drag.y = event.screenY;
});
petEl.addEventListener("pointerup", () => {
  clearTimeout(holdTimer);
  petEl.classList.remove("hold-ready");
  if (drag?.held) showMenu("long-press");
  else if (drag && !drag.moved) {
    if (waitingForKey) void window.pet.settings.open("settings-connection");
    else if (state.sleeping) wake();
    else setMuted(!state.muted);
  }
  drag = undefined;
});
petEl.addEventListener("pointercancel", () => {
  clearTimeout(holdTimer);
  petEl.classList.remove("hold-ready");
  drag = undefined;
});
// Pinch on a trackpad (or Control + scroll) over the pet to resize it.
petEl.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    applyScale(state.scale * Math.exp(-event.deltaY * 0.01));
  },
  { passive: false },
);
// The menu opens on "contextmenu". If Chromium ever drops that event after a right button press, open it anyway.
let menuTimer;
let menuShownAt = 0;
function expectMenu() {
  clearTimeout(menuTimer);
  if (performance.now() - menuShownAt < 500) return; // this press already opened it (event order varies)
  menuTimer = setTimeout(() => showMenu("fallback"), 350);
}
petEl.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showMenu("contextmenu");
});
function showMenu(via) {
  clearTimeout(menuTimer);
  menuShownAt = performance.now();
  window.pet.showMenu({
    via,
    muted: state.muted,
    sleeping: state.sleeping,
    captions: state.captions,
    showYou: state.showYou,
    echoGuard: state.echoGuard,
    character: state.character,
    characters: CHARACTERS.map((character) => ({ id: character.id, name: characterName(character, getLanguage()) })),
    scale: state.scale,
  });
}

// Let clicks on the transparent parts of the window fall through to the apps below.
let ignoring = false;
const CATCHES_CLICKS = "#pet, #bubble:not([hidden]), #size-panel:not([hidden])";
function setIgnoring(ignore) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  window.pet.ignoreMouse(ignore);
}
document.addEventListener("mousemove", (event) => {
  setIgnoring(!event.target.closest?.(CATCHES_CLICKS) && !drag);
});
// Main tells us where the pointer really is after the window changed size (the last mousemove is stale then), and
// when the window first appears: until the first mouse move the whole transparent window used to catch clicks.
function pointerAt(x, y) {
  if (drag) return;
  const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
  const target = inside ? document.elementFromPoint(x, y) : null;
  setIgnoring(!target?.closest?.(CATCHES_CLICKS));
}

window.pet.onCommand(async (command) => {
  if (typeof command !== "string") return;
  const layoutCommand = /^layout:(above|below),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(command);
  if (layoutCommand) {
    const [, placement, petTop, petLeft, room] = layoutCommand;
    applyLayout(placement, Number(petTop), Number(petLeft), Number(room));
    return;
  }
  const pointer = /^pointer:(-?\d{1,5}),(-?\d{1,5})$/.exec(command);
  if (pointer) {
    requestAnimationFrame(() => pointerAt(Number(pointer[1]), Number(pointer[2])));
    return;
  }
  if (command === "size-panel") {
    openSizePanel();
    return;
  }
  if (command.startsWith("notice:")) {
    showBubble(command.slice("notice:".length), "hint", 5000);
    return;
  }
  if (command.startsWith("notice-error:")) {
    showBubble(command.slice("notice-error:".length), "error", 8000);
    return;
  }
  if (command.startsWith("scale:")) {
    applyScale(Number(command.slice("scale:".length)));
    return;
  }
  if (command.startsWith("character:")) {
    const id = command.slice("character:".length);
    if (!/^(codex:)?[A-Za-z0-9._-]{1,64}$/.test(id)) return;
    try {
      await loadCharacter(id);
      saveSetting({ character: state.character });
    } catch (error) {
      console.error(error);
      showBubble(t("pet.loadCharacterError"), "error", 4000);
    }
    return;
  }
  switch (command) {
    case "toggle-mute":
      if (!state.sleeping) setMuted(!state.muted);
      break;
    case "toggle-sleep":
      if (state.sleeping) wake();
      else sleep("menu");
      break;
    case "refresh-tools": // an app (MCP) was connected or its tools changed: a new session will know them
      toolsRefreshPending = true;
      refreshToolsWhenQuiet();
      break;
    case "wake": // a reminder came due while the pet was asleep
      await wake();
      break;
    case "sleep": // the Mac is going to sleep or the screen was locked
      sleep("system");
      break;
    case "toggle-you":
      saveSetting({ showYou: !state.showYou });
      break;
    case "toggle-captions":
      saveSetting({ captions: !state.captions });
      break;
    case "toggle-echo-guard":
      saveSetting({ echoGuard: !state.echoGuard });
      showBubble(!state.echoGuard ? t("pet.echoGuardOn") : t("pet.echoGuardOff"), "hint", 3000);
      break;
    case "reset":
      if (state.sleeping) break;
      player?.clear();
      exchange = { you: "", reply: "", closed: true };
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reset" }));
      showBubble(t("pet.reset"), "hint", 2500);
      break;
    case "reconnect":
      if (waitingForKey) {
        // A key was saved (the proxy restarted with it): start the mic and the session now.
        snap = await window.pet.settings.get();
        if (snap.gemini.source === "none") break;
        waitingForKey = false;
        hideBubble();
        await startTalking();
        break;
      }
      if (state.sleeping) {
        wake();
        break;
      }
      reconnectDelay = 1000;
      hideBubble();
      connect();
      break;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function showMicError() {
  state.conn = "error";
  showBubble(t("pet.micError"), "error");
}

async function main() {
  snap = await window.pet.settings.get();
  setLanguage(snap.uiLanguage);
  applyI18n();
  await migrateLocalPrefs();
  state.captions = snap.values.captions;
  state.showYou = snap.values.showYou;
  state.echoGuard = snap.values.echoGuard;
  applyScale(snap.values.scale, false);
  config = await window.pet.config();
  if (Array.isArray(config?.codexPets)) codexPets = config.codexPets;
  await loadCharacter(config?.character || snap.values.character).catch(async (error) => {
    console.error(error);
    await loadCharacter("mochi").catch(() => {});
  });
  window.pet.settings.onChanged((next) => void onSettings(next));
  requestAnimationFrame(animate);
  setInterval(checkIdle, 15_000);
  setInterval(refreshToolsWhenQuiet, 2000);

  if (!config?.key) {
    state.conn = "error";
    showBubble(t("pet.noProxyKey"), "error");
    return;
  }
  if (snap.gemini.source === "none") {
    // First run (or the key was removed): no mic and no connection yet. Main opens Settings > Connection; saving a
    // key restarts the proxy and sends "reconnect", which starts everything.
    waitingForKey = true;
    showBubble(t("pet.needKey"), "hint", 0);
    return;
  }
  await startTalking();
}

async function startTalking() {
  try {
    await startPlayer();
  } catch (error) {
    console.error(error);
    showBubble(t("pet.playbackError"), "error");
    return;
  }
  if (!(await syncMic())) return;
  if (state.sleeping) return; // told to nap while starting up (for example, the screen was locked): wait for a wake
  connect();
}

main();
