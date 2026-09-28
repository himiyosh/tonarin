/**
 * Builds the release for the platform this runs on: npm run dist
 *
 * macOS (Apple Silicon): release/Tonarin-<version>-mac-arm64.dmg and .zip
 *   1. Bundles the proxy (dist/server.mjs).
 *   2. Builds the .app and the .zip.
 *   3. Builds the .dmg from that .app in a separate step. Doing the dmg together with the zip failed every time on
 *      the development Mac with "hdiutil: couldn't unmount ... Resource busy" (something scans the freshly mounted
 *      image), and even the separate step failed three times in a row while the screen was locked. So it is retried,
 *      and as a last resort a plain dmg (the app and an Applications link, no custom window layout) is made with
 *      hdiutil directly.
 *
 * Windows: release/Tonarin-<version>-win-<arch>-setup.exe, an installer for the current user (no admin rights).
 *   Build it on Windows (or in CI): npm installs the Copilot runtime and koffi only for the platform it runs on, so a
 *   Windows app built on a Mac would have no Copilot. `--arch x64|arm64` picks the architecture (default: this PC's).
 *
 * electron-builder never publishes from here; .github/workflows/release.yml uploads the files to GitHub Releases.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const builderCli = fileURLToPath(new URL("../node_modules/electron-builder/cli.js", import.meta.url));
const config = ["--config", "electron-builder.config.cjs", "--publish", "never"];
const run = (command, args) => spawnSync(command, args, { stdio: "inherit" }).status === 0;
const electronBuilder = (args) => run(process.execPath, [builderCli, ...args, ...config]); // no npx: npx.cmd needs a shell on Windows
const option = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};

if (!run(process.execPath, ["scripts/build-proxy.mjs"])) process.exit(1);

if (process.platform === "win32") {
  const arch = option("arch") ?? process.arch;
  if (!["x64", "arm64"].includes(arch)) {
    console.error(`unsupported architecture: ${arch} (x64 or arm64)`);
    process.exit(1);
  }
  process.exit(electronBuilder(["--win", "nsis", `--${arch}`]) ? 0 : 1);
}

if (process.platform !== "darwin") {
  console.error("npm run dist builds on macOS (Apple Silicon) and Windows.");
  process.exit(1);
}

if (!electronBuilder(["--mac", "zip", "--arm64"])) process.exit(1);

const app = `release/mac-arm64/${pkg.productName}.app`;
for (let attempt = 1; attempt <= 3; attempt++) {
  if (electronBuilder(["--mac", "dmg", "--arm64", "--prepackaged", app])) process.exit(0);
  console.error(`dmg attempt ${attempt} failed${attempt < 3 ? ", retrying in 5 s" : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.error("building a plain dmg with hdiutil instead");
const staging = mkdtempSync(join(tmpdir(), "dmg-"));
let ok = run("ditto", [app, join(staging, `${pkg.productName}.app`)]); // ditto keeps the signature and permissions
if (ok) {
  symlinkSync("/Applications", join(staging, "Applications"));
  const dmg = `release/${pkg.productName}-${pkg.version}-mac-arm64.dmg`;
  ok = run("hdiutil", ["create", "-volname", `${pkg.productName} ${pkg.version}`, "-srcfolder", staging, "-ov", "-format", "UDZO", dmg]);
  rmSync(`${dmg}.blockmap`, { force: true }); // a blockmap from an earlier electron-builder dmg would not match this one
}
rmSync(staging, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
