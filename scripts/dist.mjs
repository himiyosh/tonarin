/**
 * Builds the macOS release: npm run dist
 *
 * 1. Bundles the proxy (dist/server.mjs).
 * 2. Builds the .app and the .zip.
 * 3. Builds the .dmg from that .app in a separate step. Doing the dmg together with the zip failed every time on
 *    the development Mac with "hdiutil: couldn't unmount ... Resource busy" (something scans the freshly mounted image), and
 *    even the separate step failed three times in a row while the screen was locked. So it is retried, and as a last
 *    resort a plain dmg (the app and an Applications link, no custom window layout) is made with hdiutil directly.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const config = ["--config", "electron-builder.config.cjs"];
const run = (command, args) => spawnSync(command, args, { stdio: "inherit" }).status === 0;

if (!run("node", ["scripts/build-proxy.mjs"])) process.exit(1);
if (!run("npx", ["electron-builder", "--mac", "zip", "--arm64", ...config])) process.exit(1);

const app = `release/mac-arm64/${pkg.productName}.app`;
for (let attempt = 1; attempt <= 3; attempt++) {
  if (run("npx", ["electron-builder", "--mac", "dmg", "--arm64", "--prepackaged", app, ...config])) process.exit(0);
  console.error(`dmg attempt ${attempt} failed${attempt < 3 ? ", retrying in 5 s" : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.error("building a plain dmg with hdiutil instead");
const staging = mkdtempSync(join(tmpdir(), "dmg-"));
let ok = run("ditto", [app, join(staging, `${pkg.productName}.app`)]); // ditto keeps the signature and permissions
if (ok) {
  symlinkSync("/Applications", join(staging, "Applications"));
  const dmg = `release/${pkg.productName}-${pkg.version}-arm64.dmg`;
  ok = run("hdiutil", ["create", "-volname", `${pkg.productName} ${pkg.version}`, "-srcfolder", staging, "-ov", "-format", "UDZO", dmg]);
  rmSync(`${dmg}.blockmap`, { force: true }); // a blockmap from an earlier electron-builder dmg would not match this one
}
rmSync(staging, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
