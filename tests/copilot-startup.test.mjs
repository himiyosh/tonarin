import assert from "node:assert/strict";
import { test } from "node:test";
import { getAuthStatusWithRecovery } from "../src/copilot-startup.ts";

const limits = { authMs: 1, statusMs: 1 };
const stalled = () => new Promise(() => {});

test("prompt signed-in and signed-out answers do not need a retry", async () => {
  for (const isAuthenticated of [true, false]) {
    let authCalls = 0;
    const auth = { isAuthenticated };
    const result = await getAuthStatusWithRecovery({
      getAuthStatus: async () => {
        authCalls++;
        return auth;
      },
      getStatus: async () => { throw new Error("unexpected runtime probe"); },
    }, limits);
    assert.strictEqual(result, auth);
    assert.equal(authCalls, 1);
  }
});

test("one stalled sign-in check recovers only after the runtime responds and auth answers", async (context) => {
  const warning = context.mock.method(console, "warn", () => {});
  const calls = [];
  const auth = { isAuthenticated: false };
  const result = await getAuthStatusWithRecovery({
    getAuthStatus: async () => {
      calls.push("auth");
      return calls.length === 1 ? stalled() : auth;
    },
    getStatus: async () => {
      calls.push("status");
      return {};
    },
  }, limits);
  assert.strictEqual(result, auth);
  assert.deepEqual(calls, ["auth", "status", "auth"]);
  assert.equal(warning.mock.callCount(), 1);
});

test("a late answer from the original sign-in check is still accepted", async (context) => {
  context.mock.method(console, "warn", () => {});
  let answerFirst;
  let authCalls = 0;
  const first = new Promise((resolve) => { answerFirst = resolve; });
  const auth = { isAuthenticated: true };
  const result = await getAuthStatusWithRecovery({
    getAuthStatus: () => ++authCalls === 1 ? first : stalled(),
    getStatus: async () => {
      answerFirst(auth);
      return {};
    },
  }, limits);
  assert.strictEqual(result, auth);
  assert.equal(authCalls, 2);
});

test("an SDK sign-in error is not retried", async () => {
  const failure = new Error("auth RPC failed");
  let probes = 0;
  await assert.rejects(getAuthStatusWithRecovery({
    getAuthStatus: async () => { throw failure; },
    getStatus: async () => { probes++; return {}; },
  }, limits), (error) => error === failure);
  assert.equal(probes, 0);
});

test("a stalled sign-in check fails if the runtime status probe fails", async (context) => {
  context.mock.method(console, "warn", () => {});
  for (const status of [stalled, async () => { throw new Error("runtime disconnected"); }]) {
    let authCalls = 0;
    await assert.rejects(getAuthStatusWithRecovery({
      getAuthStatus: () => {
        authCalls++;
        return stalled();
      },
      getStatus: status,
    }, limits), /no answer to the runtime status check|runtime disconnected/);
    assert.equal(authCalls, 1);
  }
});

test("a responsive runtime cannot turn two unanswered sign-in checks into success", async (context) => {
  context.mock.method(console, "warn", () => {});
  let authCalls = 0;
  await assert.rejects(getAuthStatusWithRecovery({
    getAuthStatus: () => {
      authCalls++;
      return stalled();
    },
    getStatus: async () => ({}),
  }, limits), /no valid sign-in response after retry/);
  assert.equal(authCalls, 2);
});

test("a malformed sign-in response fails instead of becoming signed-out", async () => {
  let probes = 0;
  await assert.rejects(getAuthStatusWithRecovery({
    getAuthStatus: async () => ({}),
    getStatus: async () => { probes++; return {}; },
  }, limits), /sign-in check returned an invalid response/);
  assert.equal(probes, 0);
});

test("a malformed retry response also fails while the first check remains stalled", async (context) => {
  context.mock.method(console, "warn", () => {});
  let authCalls = 0;
  await assert.rejects(getAuthStatusWithRecovery({
    getAuthStatus: () => ++authCalls === 1 ? stalled() : Promise.resolve({}),
    getStatus: async () => ({}),
  }, limits), /no valid sign-in response after retry/);
  assert.equal(authCalls, 2);
});
