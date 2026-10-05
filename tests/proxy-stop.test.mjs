import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeShutdownMarker } from "../src/proxy-stop.ts";

test("the bundled proxy persists its stop marker without waiting for the parent's output pipe", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "tonarin-proxy-stop-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "proxy.log");
  writeShutdownMarker(log);
  assert.equal(readFileSync(log, "utf8"), "[proxy] stopped\n");
  assert.throws(() => writeShutdownMarker(join(dir, "missing", "proxy.log")), /ENOENT/);
});

test("a standalone proxy still logs its stop marker to stdout", (context) => {
  const printed = context.mock.method(console, "log", () => {});
  writeShutdownMarker();
  assert.equal(printed.mock.calls[0].arguments[0], "[proxy] stopped");
});
