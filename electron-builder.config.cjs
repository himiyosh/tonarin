/**
 * electron-builder settings for the macOS app: `npm run dist` (dmg + zip) or `npm run dist:dir` (just the .app).
 *
 * Signing:
 * - By default the build is ad hoc signed. It runs on this Mac; other Macs would show a Gatekeeper warning.
 * - For a release that opens cleanly everywhere: install a "Developer ID Application" certificate in the keychain
 *   and set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. The same command then signs with the hardened
 *   runtime (build/entitlements.mac.plist) and sends the app to Apple for notarization.
 *
 * The app name comes from package.json "productName" (the main process reads the same value).
 * Only the files listed below go into the app; .env, logs, models and the TypeScript sources never do.
 */
const pkg = require("./package.json");

const release = Boolean(process.env.APPLE_TEAM_ID);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "io.github.himiyosh.tonarin",
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
    "!**/*.map",
    "!**/.DS_Store",
  ],
  // Unpacked on purpose: the Copilot SDK starts a runtime executable from its npm package, which cannot run
  // from inside an asar archive.
  asar: false,
  afterPack: "scripts/after-pack.cjs",
  electronLanguages: ["en", "ja"],
  extraResources: [
    { from: "build/lproj/en/InfoPlist.strings", to: "en.lproj/InfoPlist.strings" },
    { from: "build/lproj/ja/InfoPlist.strings", to: "ja.lproj/InfoPlist.strings" },
  ],
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
  artifactName: "${productName}-${version}-${arch}.${ext}",
};
