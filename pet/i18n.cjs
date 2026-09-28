/** Strings used by the main process (menus, tray, dialogs). The pages use ui/i18n.js. */
const MESSAGES = {
  ja: {
    wake: "起こす",
    sleep: "おやすみ (マイクと接続を切る)",
    mute: "マイクをミュート",
    unmute: "マイクをオンにする",
    character: "キャラクター",
    codexPets: "Codex / ChatGPT のペット",
    none: "(まだありません)",
    findPets: "codex-pets.net でペットを探す…",
    addPet: "ダウンロードしたペットを追加…",
    openPetsFolder: "ペットのフォルダを開く",
    size: "サイズ",
    sizeSlider: "スライダーで調整…",
    sizeSmall: "小",
    sizeMedium: "中 (標準)",
    sizeLarge: "大",
    sizeXL: "特大",
    pinchHint: "ペットの上でピンチ (または Control + スクロール) でも調整できます",
    reset: "会話をリセット",
    reminderTitle: "リマインダー",
    automationTitle: "自動実行",
    automationFailed: "自動実行に失敗しました",
    githubSignInEnded: "GitHub のサインインが切れました",
    githubSignInEndedBody: "設定の「アプリ連携」から GitHub にサインインし直してください。",
    settings: "設定…",
    quit: "終了",
    showPet: "ペットを表示",
    hidePet: "ペットを隠す",
    addPetTitle: "ペットを追加",
    addPetMessage: "codex-pets.net からダウンロードした zip (またはスプライトシートの画像) を選んでください",
    addPetFilter: "Codex / ChatGPT のペット",
    petAdded: "「{name}」を追加しました 🎉",
    petAddFailed: "追加できませんでした ({message})",
    errNotFile: "ファイルではありません",
    errTooLarge: "ファイルが大きすぎます",
    errZipTooLarge: "zip の中身が大きすぎるか、読み取れません",
    errNoPet: "zip の中に pet.json もスプライトシートも見つかりません",
    errNoSheet: "スプライトシート (spritesheet.webp / png) が見つかりません",
    errWrongType: "zip か、スプライトシートの画像 (webp / png) を選んでください",
    errSheetTooLarge: "スプライトシートが大きすぎます",
    settingsTitle: "設定",
  },
  en: {
    wake: "Wake up",
    sleep: "Nap (mic off, disconnected)",
    mute: "Mute the mic",
    unmute: "Turn the mic on",
    character: "Character",
    codexPets: "Codex / ChatGPT pets",
    none: "(none yet)",
    findPets: "Browse pets on codex-pets.net…",
    addPet: "Add a downloaded pet…",
    openPetsFolder: "Open the pets folder",
    size: "Size",
    sizeSlider: "Adjust with a slider…",
    sizeSmall: "Small",
    sizeMedium: "Medium (default)",
    sizeLarge: "Large",
    sizeXL: "Extra large",
    pinchHint: "You can also pinch on the pet (or Control + scroll)",
    reset: "Start a fresh conversation",
    reminderTitle: "Reminder",
    automationTitle: "Automation",
    automationFailed: "An automation failed",
    githubSignInEnded: "Your GitHub sign-in has ended",
    githubSignInEndedBody: "Sign in to GitHub again in Settings > Connected apps.",
    settings: "Settings…",
    quit: "Quit",
    showPet: "Show the pet",
    hidePet: "Hide the pet",
    addPetTitle: "Add a pet",
    addPetMessage: "Choose a zip downloaded from codex-pets.net (or a spritesheet image)",
    addPetFilter: "Codex / ChatGPT pets",
    petAdded: "Added “{name}” 🎉",
    petAddFailed: "Could not add the pet ({message})",
    errNotFile: "Not a file",
    errTooLarge: "The file is too large",
    errZipTooLarge: "The zip is too large or unreadable",
    errNoPet: "No pet.json or spritesheet found in the zip",
    errNoSheet: "No spritesheet (spritesheet.webp / png) found",
    errWrongType: "Choose a zip or a spritesheet image (webp / png)",
    errSheetTooLarge: "The spritesheet is too large",
    settingsTitle: "Settings",
  },
};

function resolveLanguage(setting, locale) {
  if (setting === "ja" || setting === "en") return setting;
  return String(locale || "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** Wording that differs on Windows (the keyboard says Ctrl). Keys not listed use MESSAGES. */
const WINDOWS = {
  ja: { pinchHint: "ペットの上でピンチ (または Ctrl + スクロール) でも調整できます" },
  en: { pinchHint: "You can also pinch on the pet (or Ctrl + scroll)" },
};

function translator(language, platform = process.platform) {
  const table = { ...(MESSAGES[language] ?? MESSAGES.ja), ...(platform === "win32" ? WINDOWS[language] ?? WINDOWS.ja : {}) };
  return (key, vars = {}) =>
    (table[key] ?? MESSAGES.ja[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}

module.exports = { resolveLanguage, translator };
