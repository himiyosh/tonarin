/**
 * The download page. Reads releases.json (written by scripts/build-site.mjs), picks the right file for this computer,
 * fills the board, the notes, the file list and the history, and runs a character from the app beside the board.
 * Everything comes from this site's own files: nothing is requested from other sites, and nothing is tracked.
 */
const root = document.documentElement;
const slot = (name) => document.querySelector(`[data-slot="${name}"]`);
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

// ---------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------
const TEXT = {
  ja: {
    title: "Tonarin — となりにいる、声の相棒 | ダウンロード",
    latest: "最新",
    prerelease: "プレリリース",
    preview: "プレビュー",
    released: (date) => `${date} 公開`,
    download: { mac: "Mac 版をダウンロード", win: "Windows 版をダウンロード" },
    other: { mac: "macOS 版", win: "Windows 版 (プレビュー)" },
    archName: { arm64Mac: "Apple Silicon", x64: "x64", arm64: "ARM64" },
    fine: {
      mac: "Apple Silicon の Mac 用です (Intel の Mac はまだ対応していません)。",
      win: "Windows 10 / 11 用のプレビュー版です。",
      other: "Tonarin は Apple Silicon の Mac と Windows 10 / 11（x64 / ARM64、プレビュー）で動きます。",
      handheld: "Tonarin は Apple Silicon の Mac と Windows 10 / 11（x64 / ARM64、プレビュー）向けのパソコン用アプリです。インストールするには、このページをどちらかのパソコンで開いてください。",
    },
    fineTail: ["Mac 版はアドホック署名済みですが Apple の公証は受けていません。Windows 版は未署名です。初回起動時に警告が出る場合は、", "はじめての起動", "の手順をどうぞ。"],
    noRelease: "最初のリリースを準備しています。それまではソースからビルドできます。",
    comingSoon: "準備中",
    buildFromSource: "ソースからビルドする手順",
    loadFailed: "リリース情報を読み込めませんでした。GitHub の Releases ページからダウンロードしてください。",
    toGitHub: "GitHub の Releases を開く",
    notesTitle: (tag) => `${tag} のリリースノート`,
    notesEnglishOnly: "このリリースのノートは英語のみです。",
    platform: { mac: "macOS (Apple Silicon)", win: "Windows 10 / 11" },
    kind: { dmg: "ディスクイメージ", zip: "zip アーカイブ", installer: "インストーラー" },
    copy: "コピー",
    copied: "コピーしました",
    copyLabel: (file) => `${file} の SHA-256 をコピー`,
    noFiles: "このリリースにはまだファイルがありません。",
    checksums: "すべてのチェックサム (SHA256SUMS.txt)",
    onGitHub: "GitHub でこのリリースを見る",
    historyNotes: "リリースノート",
    historyLink: "GitHub で見る",
    you: "あなた",
    ask: { win: "Windows でも使える？", mac: "Mac で使える？", other: "どんなパソコンで使えるの？", none: "もう使える？" },
    answer: {
      win: (tag) => `うん、${tag} から Windows でも話せるようになったよ。まだプレビュー版だけどね。この PC 用はこれ！`,
      mac: (tag) => `うん。Apple Silicon の Mac 用はこれだよ。${tag} が最新！`,
      other: () => "Apple Silicon の Mac と Windows 10 / 11（プレビュー）で動くよ。どっちにする？",
      none: () => "もうすぐ最初のリリースだよ。それまではソースからビルドしてね。",
      error: () => "うまく読み込めなかったみたい。GitHub の Releases から持っていってね。",
    },
    petLabel: (name) => `キャラクターを替える (いまは${name})`,
  },
  en: {
    title: "Tonarin — The one next to you | Download",
    latest: "Latest",
    prerelease: "Pre-release",
    preview: "Preview",
    released: (date) => `Released ${date}`,
    download: { mac: "Download for Mac", win: "Download for Windows" },
    other: { mac: "macOS", win: "Windows (preview)" },
    archName: { arm64Mac: "Apple Silicon", x64: "x64", arm64: "ARM64" },
    fine: {
      mac: "For Apple Silicon Macs (Intel Macs are not supported yet).",
      win: "A preview for Windows 10 and 11.",
      other: "Tonarin runs on Apple Silicon Macs and Windows 10/11 x64/ARM64 (preview).",
      handheld: "Tonarin is a desktop app for Apple Silicon Macs and Windows 10/11 x64/ARM64 (preview). Open this page on one of those computers to install it.",
    },
    fineTail: ["Mac builds are ad hoc signed but not notarized by Apple; Windows installers are unsigned. A warning may appear when you first open the app; see ", "the first launch", " steps."],
    noRelease: "The first release is on its way. Until then you can build from source.",
    comingSoon: "Coming soon",
    buildFromSource: "How to build from source",
    loadFailed: "The release list could not be loaded. Download from the Releases page on GitHub instead.",
    toGitHub: "Open Releases on GitHub",
    notesTitle: (tag) => `What's new in ${tag}`,
    notesEnglishOnly: "",
    platform: { mac: "macOS (Apple Silicon)", win: "Windows 10 / 11" },
    kind: { dmg: "Disk image", zip: "Zip archive", installer: "Installer" },
    copy: "Copy",
    copied: "Copied",
    copyLabel: (file) => `Copy the SHA-256 of ${file}`,
    noFiles: "This release has no files yet.",
    checksums: "All checksums (SHA256SUMS.txt)",
    onGitHub: "See this release on GitHub",
    historyNotes: "Release notes",
    historyLink: "On GitHub",
    you: "You",
    ask: { win: "Does it work on Windows?", mac: "Does it run on my Mac?", other: "What computers does it run on?", none: "Can I use it yet?" },
    answer: {
      win: (tag) => `Yes! Since ${tag} I can talk on Windows too. It's a preview for now. This one's for your PC!`,
      mac: (tag) => `Yes. Here's the one for Apple Silicon Macs. ${tag} is the latest!`,
      other: () => "I run on Apple Silicon Macs and Windows 10/11 (preview). Which one's yours?",
      none: () => "The first release is coming soon. Until then, you can build me from source.",
      error: () => "I couldn't load the list. Grab me from the Releases page on GitHub.",
    },
    petLabel: (name) => `Meet another character (now: ${name})`,
  },
};

/** The app's characters (pet/ui/characters.js) and what each says when you meet it. Every line is a real feature. */
const CHARACTERS = [
  { id: "mochi", name: { ja: "もち", en: "Mochi" }, line: { ja: "もちだよ。いちばん最初の相棒。", en: "I'm Mochi, the very first companion." } },
  { id: "robo", name: { ja: "ロボ", en: "Robo" }, line: { ja: "ロボです。ちょっとした質問も、どうぞ。", en: "Robo here. Ask me anything, big or small." } },
  { id: "owl", name: { ja: "フクロウ先生", en: "Professor Owl" }, line: { ja: "フクロウ先生です。じっくり調べるときは Copilot と一緒に。", en: "Professor Owl. I dig into the hard ones with Copilot." } },
  { id: "neko", name: { ja: "ねこ", en: "Cat" }, line: { ja: "ねこだよ。今日のテックニュース、紹介しようか？", en: "Cat here. Want to hear today's tech news?" } },
  { id: "pengin", name: { ja: "ペンギン", en: "Penguin" }, line: { ja: "ペンギンです。休憩のリマインダー、まかせて。", en: "Penguin. I'll remind you to take a break." } },
  { id: "kitsune", name: { ja: "きつね", en: "Fox" }, line: { ja: "きつねだよ。英会話の練習もできるよ。", en: "Fox here. We can practice English, too." } },
  { id: "obake", name: { ja: "おばけ", en: "Ghost" }, line: { ja: "おばけだよ。静かな時間が続くと、マイクを切っておやすみするね。", en: "Ghost here. When it's quiet for a while, I close the mic and nap." } },
  { id: "hiyoko", name: { ja: "ひよこ", en: "Chick" }, line: { ja: "ひよこだよ。大きさは 50〜200% で変えられるよ。", en: "Chick here. You can make me 50% to 200% big." } },
];

let lang = root.dataset.lang === "en" ? "en" : "ja";
const tx = () => TEXT[lang];

// ---------------------------------------------------------------------------------------------------------------
// Small helpers (textContent everywhere; only GitHub-rendered notes and our own SVG files are inserted as markup)
// ---------------------------------------------------------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { dateStyle: "long" }).format(date);
}

const archLabel = (download) => (download.os === "mac" && download.arch === "arm64" ? tx().archName.arm64Mac : tx().archName[download.arch]);

/** The notes as a detached element, without their own "Highlights" heading (the page has its own). */
function notesFragment(release) {
  const html = release.notes?.[lang] || release.notes?.en || "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const box = doc.body.firstElementChild;
  const first = box.firstElementChild;
  if (first && /^H[12]$/.test(first.tagName)) first.remove();
  for (const link of box.querySelectorAll("a[href]")) link.setAttribute("rel", "noopener");
  return box;
}

/** The opening of the notes for the board: one or two whole sentences, never cut in the middle of one. */
function summary(release) {
  const text = notesFragment(release).querySelector("p")?.textContent.replace(/\s+/g, " ").trim() ?? "";
  // Japanese sentences end at 。！？; English ones at .!? before a space (so "0.2.0" stays whole).
  const sentences = text.match(/[^]+?(?:[。！？]|[.!?](?=\s|$))\s*|[^]+$/g) ?? [];
  let result = "";
  for (const [i, sentence] of sentences.entries()) {
    if (i > 1 || (result && result.length >= (lang === "ja" ? 40 : 80))) break;
    result += sentence;
  }
  result = result.trim();
  if (result.length <= 200) return result;
  const cut = result.slice(0, 197);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 150)).trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------------------------
// Which computer is this?
// ---------------------------------------------------------------------------------------------------------------
async function detectComputer() {
  const data = navigator.userAgentData;
  const ua = navigator.userAgent;
  const platform = `${ua} ${data?.platform ?? ""} ${navigator.platform ?? ""}`;
  let os = /Windows NT|Win32|Win64|\bWindows\b/.test(platform) ? "win" : /Macintosh|Mac OS X|macOS|MacIntel/.test(platform) ? "mac" : "other";
  // Phones and tablets (iPadOS says "Macintosh", but has a touch screen): show both, they will download elsewhere.
  const handheld = Boolean(data?.mobile || /iPhone|iPad|Android/i.test(ua) || (os === "mac" && navigator.maxTouchPoints > 1));
  if (handheld) os = "other";
  let arch = os === "mac" ? "arm64" : "x64";
  if (os === "win" && data?.getHighEntropyValues) {
    try {
      const { architecture } = await data.getHighEntropyValues(["architecture"]);
      if (architecture === "arm") arch = "arm64";
    } catch {
      // not allowed: x64 also runs on Windows on ARM
    }
  }
  return { os, arch, handheld };
}

/** The file to offer first on `os`: the disk image on a Mac, the installer for this PC's architecture on Windows. */
function pick(downloads, os, arch) {
  const mine = downloads.filter((d) => d.os === os);
  if (os === "mac") return mine.find((d) => d.kind === "dmg") ?? mine.find((d) => d.kind === "zip");
  return mine.find((d) => d.kind === "installer" && d.arch === arch) ?? mine.find((d) => d.kind === "installer");
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------
let data = null; // releases.json
let computer = { os: "other", arch: "x64", handheld: false };
let failed = false;

const latestRelease = () => data?.releases.find((release) => release.tag === data.latest) ?? data?.releases[0] ?? null;

function downloadButton(download, primary) {
  const t = tx();
  const button = el(
    "a",
    { class: `button ${primary ? "primary" : "secondary"}`, href: download.url },
    el("span", { text: primary ? t.download[download.os] : t.other[download.os] }),
    el("span", { class: "meta", text: [archLabel(download), formatSize(download.size)].filter(Boolean).join(" · ") }),
  );
  if (primary) {
    button.addEventListener("pointerenter", () => pet.listen(true));
    button.addEventListener("pointerleave", () => pet.listen(false));
    button.addEventListener("focus", () => pet.listen(true));
    button.addEventListener("blur", () => pet.listen(false));
  }
  return button;
}

function renderBoard() {
  const t = tx();
  const board = document.getElementById("board");
  const release = latestRelease();
  const version = document.getElementById("board-version");
  const stamp = slot("stamp");
  const highlight = slot("highlight");
  const actions = slot("actions");
  const fine = slot("fineprint");
  const releasesUrl = data?.releasesUrl ?? "https://github.com/himiyosh/tonarin/releases";

  if (!release) {
    board.dataset.state = failed ? "error" : "empty";
    version.textContent = !failed && data?.upcoming ? `v${data.upcoming}` : "Tonarin";
    stamp.textContent = failed ? "" : t.comingSoon;
    highlight.textContent = failed ? t.loadFailed : t.noRelease;
    actions.replaceChildren(
      failed
        ? el("a", { class: "button primary", href: releasesUrl }, el("span", { text: t.toGitHub }))
        : el("a", { class: "button primary", href: "https://github.com/himiyosh/tonarin#build-from-source" }, el("span", { text: t.buildFromSource })),
    );
    fine.replaceChildren();
    return;
  }

  board.dataset.state = "ready";
  version.textContent = release.tag;
  stamp.textContent = `${release.prerelease ? t.prerelease : t.latest} · ${t.released(formatDate(release.date))}`;
  highlight.textContent = summary(release);

  const buttons = [];
  const mine = computer.os === "other" ? undefined : pick(release.downloads, computer.os, computer.arch);
  if (mine) {
    buttons.push(downloadButton(mine, true));
    const otherOs = mine.os === "mac" ? "win" : "mac";
    const other = pick(release.downloads, otherOs, "x64");
    if (other) buttons.push(downloadButton(other, false));
  } else {
    for (const os of ["mac", "win"]) {
      const file = pick(release.downloads, os, "x64");
      if (file) buttons.push(downloadButton({ ...file }, true));
    }
  }
  if (!buttons.length) buttons.push(el("a", { class: "button primary", href: release.url }, el("span", { text: t.onGitHub })));
  actions.replaceChildren(...buttons);

  const [before, link, after] = t.fineTail;
  fine.replaceChildren(
    `${t.fine[mine ? mine.os : computer.handheld ? "handheld" : "other"]}${lang === "ja" ? "" : " "}${before}`,
    el("a", { href: "#first-launch", text: link }),
    after,
  );
}

function renderNotes() {
  const release = latestRelease();
  const box = slot("notes");
  box.closest(".notes").toggleAttribute("data-empty", !release);
  if (!release) return;
  slot("notes-title").textContent = tx().notesTitle(release.tag);
  const content = notesFragment(release);
  const englishOnly = lang === "ja" && !release.notes?.ja;
  box.replaceChildren(...content.childNodes);
  if (englishOnly && tx().notesEnglishOnly) box.prepend(el("p", { class: "fallback", text: tx().notesEnglishOnly }));
}

function copyButton(download) {
  const t = tx();
  const button = el("button", { class: "copy", type: "button", "aria-label": t.copyLabel(download.file), text: t.copy });
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(download.sha256);
      button.textContent = t.copied;
      button.dataset.done = "";
      setTimeout(() => {
        button.textContent = tx().copy;
        delete button.dataset.done;
      }, 1800);
    } catch {
      // clipboard blocked: the hash is still shown (and selectable) on wide screens and in SHA256SUMS.txt
    }
  });
  return button;
}

function renderFiles() {
  const t = tx();
  const release = latestRelease();
  const body = slot("files");
  const note = slot("files-note");
  if (!release) return;
  if (!release.downloads.length) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: 4, class: "empty", text: t.noFiles })));
  } else {
    body.replaceChildren(
      ...release.downloads.map((download) =>
        el(
          "tr",
          {},
          el(
            "td",
            { class: "platform-cell" },
            t.platform[download.os],
            download.preview ? [" ", el("span", { class: "tag preview", text: t.preview })] : null,
            el("small", { text: archLabel(download) }),
          ),
          el("td", { class: "file" }, el("a", { href: download.url, text: download.file }), el("small", { text: t.kind[download.kind] })),
          el("td", { class: "num", text: formatSize(download.size) }),
          el(
            "td",
            { class: "sha" },
            download.sha256 ? [el("code", { title: download.sha256, text: `${download.sha256.slice(0, 12)}…` }), copyButton(download)] : "—",
          ),
        ),
      ),
    );
  }
  note.replaceChildren(
    ...(release.checksums ? [el("a", { href: release.checksums, text: t.checksums }), " · "] : []),
    el("a", { href: release.url, text: t.onGitHub }),
  );
}

function renderHistory() {
  const t = tx();
  const list = slot("history");
  const empty = slot("history-empty");
  const earlier = (data?.releases ?? []).filter((release) => release.tag !== latestRelease()?.tag);
  list.hidden = !earlier.length;
  empty.hidden = Boolean(earlier.length) || !latestRelease();
  list.replaceChildren(
    ...earlier.map((release) =>
      el(
        "li",
        {},
        el(
          "div",
          { class: "history-head" },
          el("strong", { text: release.tag }),
          el("time", { datetime: release.date, text: formatDate(release.date) }),
          release.prerelease ? el("span", { class: "tag", text: t.prerelease }) : null,
          el("a", { href: release.url, text: t.historyLink }),
        ),
        el("details", {}, el("summary", { text: t.historyNotes }), el("div", { class: "prose" }, ...notesFragment(release).childNodes)),
      ),
    ),
  );
}

function markDetectedPlatform() {
  for (const panel of document.querySelectorAll(".platform[data-os]")) {
    if (panel.dataset.os === computer.os) panel.dataset.detected = "";
    else delete panel.dataset.detected;
  }
}

function render() {
  document.title = tx().title;
  for (const button of document.querySelectorAll("[data-set-lang]")) button.setAttribute("aria-pressed", String(button.dataset.setLang === lang));
  renderBoard();
  renderNotes();
  renderFiles();
  renderHistory();
  markDetectedPlatform();
  pet.relabel();
}

// ---------------------------------------------------------------------------------------------------------------
// The pet: a character from the app with its bubble. Thinking while the page loads, speaking while the bubble fills
// in, listening while you point at the download.
// ---------------------------------------------------------------------------------------------------------------
const pet = (() => {
  const button = slot("pet");
  const holder = slot("character");
  const you = slot("you");
  const says = slot("says");
  let index = 0;
  let mouth;
  let speech = 0; // the current line; a newer one stops the older
  let listening = false;
  let state = "thinking";
  const cache = new Map();

  const setState = (next) => {
    state = next;
    button.dataset.state = listening && next === "idle" ? "listening" : next;
  };

  async function show(id) {
    if (!cache.has(id)) cache.set(id, fetch(`characters/${id}.svg`).then((response) => (response.ok ? response.text() : "")));
    holder.innerHTML = await cache.get(id); // our own files, copied from the app
    const node = holder.querySelector("#mouth");
    const num = (name, fallback = 0) => Number(node?.getAttribute(name) ?? fallback);
    if (!node) mouth = undefined;
    else if (node.tagName.toLowerCase() === "rect") {
      mouth = { node, kind: "rect", x: num("x"), y: num("y"), w: num("width"), h: num("height"), openW: num("data-open-w"), openH: num("data-open-h", 8) };
    } else {
      mouth = { node, kind: "ellipse", rx: num("rx"), ry: num("ry"), openRx: num("data-open-rx"), openRy: num("data-open-ry", 8) };
    }
  }

  function openMouth(amount) {
    if (!mouth) return;
    if (mouth.kind === "ellipse") {
      mouth.node.setAttribute("rx", String(mouth.rx + ((mouth.openRx || mouth.rx) - mouth.rx) * amount));
      mouth.node.setAttribute("ry", String(mouth.ry + (mouth.openRy - mouth.ry) * amount));
    } else {
      const w = mouth.w + ((mouth.openW || mouth.w) - mouth.w) * amount;
      const h = mouth.h + (mouth.openH - mouth.h) * amount;
      mouth.node.setAttribute("width", String(w));
      mouth.node.setAttribute("height", String(h));
      mouth.node.setAttribute("x", String(mouth.x + (mouth.w - w) / 2));
      mouth.node.setAttribute("y", String(mouth.y + (mouth.h - h) / 2));
    }
  }

  /** Shows what you asked (optional) and types the answer in, like the app's captions. */
  async function say(question, answer) {
    const mine = ++speech;
    you.replaceChildren(...(question ? [el("span", { class: "who", text: tx().you }), question] : []));
    if (REDUCED_MOTION.matches) {
      says.textContent = answer;
      setState("idle");
      return;
    }
    setState("speaking");
    says.textContent = "";
    const letters = [...answer];
    for (let i = 0; i < letters.length; i++) {
      if (mine !== speech) return;
      says.textContent += letters[i];
      openMouth(i % 4 < 2 && /\S/.test(letters[i]) ? 0.9 : 0.15);
      await new Promise((resolve) => setTimeout(resolve, lang === "ja" ? 38 : 22));
    }
    if (mine !== speech) return;
    openMouth(0);
    setState("idle");
  }

  function relabel() {
    const character = CHARACTERS[index];
    button.setAttribute("aria-label", tx().petLabel(character.name[lang]));
  }

  button.addEventListener("click", async () => {
    index = (index + 1) % CHARACTERS.length;
    const character = CHARACTERS[index];
    await show(character.id);
    relabel();
    void say(null, character.line[lang]);
  });

  return {
    show,
    say,
    relabel,
    thinking: () => setState("thinking"),
    listen(on) {
      listening = on;
      if (state === "idle") setState("idle");
    },
    greet() {
      const t = tx();
      const release = latestRelease();
      if (failed) return say(null, t.answer.error());
      if (!release) return say(t.ask.none, t.answer.none());
      const os = computer.os !== "other" && pick(release.downloads, computer.os, computer.arch) ? computer.os : "other";
      return say(t.ask[os], t.answer[os](release.tag));
    },
  };
})();

// ---------------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------------
function setLanguage(next) {
  if (next === lang) return;
  lang = next;
  root.lang = lang;
  root.dataset.lang = lang;
  try {
    localStorage.setItem("tonarin.lang", lang);
  } catch {
    // private mode: the choice lasts for this page only
  }
  render();
  void pet.greet();
}

for (const button of document.querySelectorAll("[data-set-lang]")) button.addEventListener("click", () => setLanguage(button.dataset.setLang));

pet.thinking();
const [loaded, detected] = await Promise.all([
  fetch("releases.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .catch(() => null),
  detectComputer(),
  pet.show(CHARACTERS[0].id),
]);
data = loaded && Array.isArray(loaded.releases) ? loaded : null;
failed = !data;
computer = detected;
render();
void pet.greet();
