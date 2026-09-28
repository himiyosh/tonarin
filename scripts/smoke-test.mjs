/**
 * Starts a packaged build once and checks that it works: npm run smoke (after npm run dist or npm run dist:dir)
 *
 * The app runs with a fresh, temporary settings folder (TONARIN_USER_DATA) and TONARIN_SMOKE_TEST set, so it checks
 * itself (see "smoke test" in pet/main.cjs), writes a report and quits. This script then checks that it quit cleanly
 * and that the proxy shut down gracefully, which on Windows goes through a message instead of a signal, so the
 * Copilot runtime does not outlive the app. When anything fails it prints the report and the app's logs.
 *
 *   npm run smoke                    the build in release/ for this platform and architecture
 *   npm run smoke -- <app>           Tonarin.app, or Tonarin.exe
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const name = pkg.productName;
const TIMEOUT_MS = 180_000;

function executable(target) {
  if (target) {
    const full = resolve(target);
    return full.endsWith(".app") ? join(full, "Contents", "MacOS", basename(full, ".app")) : full;
  }
  if (process.platform === "darwin") return resolve(`release/mac${process.arch === "arm64" ? "-arm64" : ""}/${name}.app/Contents/MacOS/${name}`);
  if (process.platform === "win32") return resolve(`release/win-${process.arch === "arm64" ? "arm64-" : ""}unpacked/${name}.exe`);
  throw new Error("packaged builds exist for macOS and Windows only");
}

const app = executable(process.argv[2]);
if (!existsSync(app)) {
  console.error(`no packaged app at ${app}: run npm run dist (or npm run dist:dir) first`);
  process.exit(1);
}

const userData = mkdtempSync(join(tmpdir(), "tonarin-smoke-"));
const reportFile = join(userData, "smoke-report.json");
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
console.log(`smoke test: ${app}`);

const started = Date.now();
const child = spawn(app, [], {
  // Its own settings folder and an empty pets folder: nothing of yours is read or changed.
  env: { ...process.env, TONARIN_USER_DATA: userData, TONARIN_SMOKE_TEST: reportFile, CODEX_PETS_DIR: join(userData, "codex-pets") },
  stdio: ["ignore", "inherit", "inherit"],
});
const exit = await new Promise((done) => {
  const timer = setTimeout(() => {
    child.kill();
    done("timed out");
  }, TIMEOUT_MS);
  child.once("error", (error) => {
    clearTimeout(timer);
    done(`could not start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    done(signal ? `killed by ${signal}` : code);
  });
});

const failures = [];
let report;
try {
  report = JSON.parse(read(reportFile));
} catch {
  failures.push("the app wrote no report");
}
if (report?.problems?.length) failures.push(...report.problems);
if (report && report.version !== pkg.version) failures.push(`the app reports version ${report.version}, package.json says ${pkg.version}`);
if (exit !== 0) failures.push(`the app exited with ${exit}`);
const proxyLog = read(join(userData, "logs", "proxy.log"));
const mainLog = read(join(userData, "logs", "main.log"));
const count = (text, pattern) => (text.match(pattern) ?? []).length;
if (!count(proxyLog, /\[proxy\] stopped/g) || count(proxyLog, /\[proxy\] stopped/g) !== count(proxyLog, /listening on/g)) {
  failures.push("the proxy did not shut down gracefully");
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (report) {
  const status = report.proxy?.status;
  console.log(
    `  ${report.platform}-${report.arch}, Electron ${report.electron}, Copilot runtime ${status?.copilot ?? "?"}, ` +
      `pet "${report.pet?.character ?? "?"}", ${report.settings?.sections ?? 0} settings sections (${seconds} s)`,
  );
}
if (failures.length) {
  console.error(`\nsmoke test FAILED:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  if (report) console.error(`\nreport:\n${JSON.stringify(report, null, 2)}`);
  console.error(`\nmain.log:\n${mainLog.trim() || "(empty)"}`);
  console.error(`\nproxy.log:\n${proxyLog.trim() || "(empty)"}`);
} else {
  console.log("smoke test passed");
}
rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(failures.length ? 1 : 0);
