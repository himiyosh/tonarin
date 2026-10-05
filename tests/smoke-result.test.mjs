import assert from "node:assert/strict";
import { test } from "node:test";
import { smokeFailures } from "../scripts/smoke-result.mjs";

const valid = () => ({
  report: { version: "0.1.0", problems: [] },
  version: "0.1.0",
  exit: 0,
  proxyLog: "copilot-proxy listening on http://127.0.0.1:1/v1\n[proxy] stopped\n",
});

test("a valid self-check and persisted graceful stop pass", () => {
  assert.deepEqual(smokeFailures(valid()), []);
});

test("exit zero without the stop marker still fails", () => {
  assert.deepEqual(smokeFailures({ ...valid(), proxyLog: "copilot-proxy listening on http://127.0.0.1:1/v1\n" }),
    ["the proxy did not shut down gracefully"]);
});

test("an abnormal exit or a timeout fails even if the marker was logged", () => {
  for (const exit of [1, "timed out"]) {
    assert.deepEqual(smokeFailures({ ...valid(), exit }), [`the app exited with ${exit}`]);
  }
});

test("app self-check failures and malformed reports cannot pass", () => {
  assert.deepEqual(smokeFailures({ ...valid(), report: { version: "0.1.0", problems: ["page crashed"] } }),
    ["page crashed"]);
  assert.match(smokeFailures({ ...valid(), report: { version: "0.1.0", problems: "" } })[0], /invalid report/);
  assert.match(smokeFailures({ ...valid(), report: undefined })[0], /no report/);
});

test("every proxy startup needs its own graceful-stop marker", () => {
  assert.deepEqual(smokeFailures({ ...valid(), proxyLog: `${valid().proxyLog}copilot-proxy listening on http://127.0.0.1:2/v1\n` }),
    ["the proxy did not shut down gracefully"]);
});
