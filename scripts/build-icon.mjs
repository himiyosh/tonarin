/**
 * Compiles the Liquid Glass app icon (macOS 26): npm run icon
 *
 * build/icon/Icon.icon (Icon Composer format, written by scripts/make-icon.py) -> build/icon/Assets.car with Apple's
 * actool. It needs Xcode 26 or later on macOS 26 or later, with the Xcode license accepted once
 * (`sudo xcodebuild -license accept` in Terminal). The Command Line Tools alone do not include actool; if xcode-select
 * points at them, /Applications/Xcode.app is used when present.
 *
 * Assets.car is kept in the repo, so later builds (`npm run dist`) work without Xcode: scripts/after-pack.cjs copies it
 * into the app and sets CFBundleIconName. Older macOS versions keep using the .icns made from assets/icon.png.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = "build/icon/Icon.icon";
const target = "build/icon/Assets.car";
const env = { ...process.env };
if (!env.DEVELOPER_DIR && existsSync("/Applications/Xcode.app/Contents/Developer")) {
  env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
}
const run = (args) => spawnSync("xcrun", args, { env, encoding: "utf8" });

if (process.platform !== "darwin") {
  console.error("actool runs on macOS only.");
  process.exit(1);
}
const version = run(["actool", "--version"]);
const text = `${version.stdout}${version.stderr}`;
if (/license/i.test(text)) {
  console.error("Accept the Xcode license first: sudo xcodebuild -license accept");
  process.exit(1);
}
const major = Number(/<string>(\d+)\./.exec(text)?.[1] ?? /(\d+)\.\d+/.exec(text)?.[1] ?? 0);
if (version.status !== 0 || major < 26) {
  console.error(`actool from Xcode 26 or later is needed (found: ${text.trim().split("\n")[0] || "none"}).`);
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "icon-"));
const result = run([
  "actool", source,
  "--compile", out,
  "--output-format", "human-readable-text",
  "--notices", "--warnings",
  "--output-partial-info-plist", join(out, "partial.plist"),
  "--app-icon", "Icon",
  "--include-all-app-icons",
  "--enable-on-demand-resources", "NO",
  "--development-region", "en",
  "--target-device", "mac",
  "--minimum-deployment-target", "26.0",
  "--platform", "macosx",
]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0 || !existsSync(join(out, "Assets.car"))) {
  rmSync(out, { recursive: true, force: true });
  console.error("actool did not produce Assets.car");
  process.exit(1);
}
copyFileSync(join(out, "Assets.car"), target);
rmSync(out, { recursive: true, force: true });
console.log(`wrote ${target}`);
