/**
 * electron-builder settings. `npm run dist` builds for the platform it runs on (scripts/dist.mjs):
 * - macOS (Apple Silicon): a .dmg and a .zip. `npm run dist:dir` builds just the app, on either platform.
 * - Windows: an NSIS installer that installs for the current user, without admin rights.
 *
 * File names say version, OS and architecture: Tonarin-0.2.0-mac-arm64.dmg, Tonarin-0.2.0-win-x64-setup.exe. The
 * download site (site/) and the release notes (scripts/release-notes.mjs) recognize them by that pattern.
 *
 * Signing:
 * - macOS builds are ad hoc signed by default. They run on this Mac; other Macs show a Gatekeeper warning.
 *   For a release that opens cleanly everywhere: install a "Developer ID Application" certificate in the keychain
 *   and set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. The same command then signs with the hardened
 *   runtime (build/entitlements.mac.plist) and sends the app to Apple for notarization.
 * - Windows builds are not signed yet, so SmartScreen asks before the first start. Setting CSC_LINK and
 *   CSC_KEY_PASSWORD (a code signing certificate) makes electron-builder sign them.
 *
 * The app name and ID come from package.json ("productName", "tonarin.appId"); the main process reads the same values.
 * Only the files listed below go into the app; .env, logs, models and the TypeScript sources never do.
 */
const pkg = require("./package.json");

const release = Boolean(process.env.APPLE_TEAM_ID);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: pkg.tonarin.appId,
  productName: pkg.productName,
  copyright: `© 2026 ${pkg.productName}`,
  directories: { output: "release", buildResources: "build" },
  files: [
    "package.json",
    "pet/**/*",
    "dist/**/*",
    "src/catalog.json",
    "assets/trayTemplate.png",
    "assets/trayTemplate@2x.png",
    "assets/tray.ico",
    "!**/*.map",
    "!**/.DS_Store",
  ],
  // Unpacked on purpose: the Copilot SDK starts a runtime executable from its npm package, which cannot run
  // from inside an asar archive.
  asar: false,
  afterPack: "scripts/after-pack.cjs",
  // Releases are uploaded by .github/workflows/release.yml, never by electron-builder itself.
  publish: null,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.productivity",
    icon: "assets/icon.png",
    identity: release ? undefined : "-", // "-" = ad hoc
    hardenedRuntime: release,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: release,
    electronLanguages: ["en", "ja"],
    extraResources: [
      { from: "build/lproj/en/InfoPlist.strings", to: "en.lproj/InfoPlist.strings" },
      { from: "build/lproj/ja/InfoPlist.strings", to: "ja.lproj/InfoPlist.strings" },
    ],
    extendInfo: {
      LSUIElement: true, // no Dock icon: the pet and the menu bar icon are the app (the Dock icon shows with Settings)
      NSMicrophoneUsageDescription:
        "Your pet listens through the microphone so you can talk with it. The mic is closed while it naps or is muted.",
      // A calendar app connected in Settings > Connected apps (an MCP server such as che-ical-mcp) runs as a child of
      // this app, so macOS asks for calendar and reminders access on behalf of this app and needs these texts.
      NSCalendarsUsageDescription: "Lets the calendar app you connected in Settings read your events so your pet can tell you about them.",
      NSCalendarsFullAccessUsageDescription:
        "Lets the calendar app you connected in Settings read your events so your pet can tell you about them.",
      NSRemindersUsageDescription: "Lets the calendar app you connected in Settings read your reminders.",
      NSRemindersFullAccessUsageDescription: "Lets the calendar app you connected in Settings read your reminders.",
    },
  },
  dmg: {
    title: "${productName} ${version}",
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico", // full-bleed squircle (scripts/derive-icons.py)
    // Chromium's Windows locale files are named en-US.pak and ja.pak; en-US is also its fallback, so it must stay.
    electronLanguages: ["en-US", "ja"],
    legalTrademarks: pkg.productName,
  },
  nsis: {
    oneClick: true, // installs in %LOCALAPPDATA%\Programs\tonarin and starts the app, no wizard
    perMachine: false,
    shortcutName: pkg.productName,
    uninstallDisplayName: pkg.productName,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // settings and the encrypted keys stay in %APPDATA%\Tonarin
    artifactName: "${productName}-${version}-win-${arch}-setup.${ext}",
  },
};
