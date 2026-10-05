const assert = require("node:assert/strict");
const { test } = require("node:test");
const { stopProxy } = require("../pet/proxy-process.cjs");

test("a clean proxy exit needs no forced stop", async () => {
  await stopProxy(() => {}, () => assert.fail("unexpected kill"), Promise.resolve(0));
});

test("a proxy that exits abnormally cannot pass a graceful stop", async () => {
  await assert.rejects(
    stopProxy(() => {}, () => assert.fail("unexpected kill"), Promise.resolve(1)),
    /exited with code 1/,
  );
});

test("even a zero exit fails if the proxy needed to be killed", async () => {
  let exit;
  const exited = new Promise((resolve) => { exit = resolve; });
  await assert.rejects(
    stopProxy(() => {}, () => exit(0), exited, { forceAfterMs: 5, timeoutMs: 20 }),
    /required a forced stop/,
  );
});

test("a proxy that fails to exit is killed and the stop still fails", async () => {
  let kills = 0;
  await assert.rejects(
    stopProxy(() => {}, () => { kills++; }, new Promise(() => {}), { forceAfterMs: 5, timeoutMs: 20 }),
    /did not exit/,
  );
  assert.equal(kills, 1);
});

test("failure to request graceful shutdown cannot become success", async () => {
  let kills = 0;
  await assert.rejects(
    stopProxy(() => { throw new Error("channel closed"); }, () => { kills++; }, Promise.resolve(0)),
    /could not request graceful proxy shutdown/,
  );
  assert.equal(kills, 1);
});
