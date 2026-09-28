// "Sign in with GitHub" device flow and token refresh (pet/github.cjs), against a fake fetch.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createDeviceFlow, GitHubAuthError, isTransient } = require("../pet/github.cjs");

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const noSleep = async () => {};

test("device flow waits while pending and keeps the refresh token and lifetimes", async () => {
  const answers = [
    json({ error: "authorization_pending" }),
    json({ access_token: "ghu_a", scope: "repo", expires_in: 28800, refresh_token: "ghr_r", refresh_token_expires_in: 15897600 }),
  ];
  const flow = createDeviceFlow({ clientId: "Ov23test", fetch: async () => answers.shift() });
  const answer = await flow.waitForToken({ deviceCode: "dc", interval: 1, expiresIn: 60 }, undefined, noSleep);
  assert.deepEqual(
    [answer.token, answer.refreshToken, answer.expiresIn, answer.refreshExpiresIn],
    ["ghu_a", "ghr_r", 28800, 15897600],
  );
});

test("slow_down raises the polling interval", async () => {
  const waits = [];
  const answers = [json({ error: "slow_down", interval: 10 }), json({ access_token: "gho_x" })];
  const flow = createDeviceFlow({ clientId: "c", fetch: async () => answers.shift() });
  await flow.waitForToken({ deviceCode: "dc", interval: 5, expiresIn: 60 }, undefined, async (ms) => waits.push(ms));
  assert.deepEqual(waits, [5000, 10000]);
});

test("a denied sign-in is an error with GitHub's code", async () => {
  const flow = createDeviceFlow({ clientId: "c", fetch: async () => json({ error: "access_denied" }) });
  await assert.rejects(flow.waitForToken({ deviceCode: "dc", interval: 1, expiresIn: 60 }, undefined, noSleep), { code: "access_denied" });
});

test("cancelling stops the wait", async () => {
  const controller = new AbortController();
  controller.abort();
  const flow = createDeviceFlow({ clientId: "c", fetch: async () => json({ error: "authorization_pending" }) });
  await assert.rejects(flow.waitForToken({ deviceCode: "dc", interval: 1, expiresIn: 60 }, controller.signal, noSleep), { code: "cancelled" });
});

test("a non-expiring token has no refresh data", async () => {
  const flow = createDeviceFlow({ clientId: "c", fetch: async () => json({ access_token: "gho_x", scope: "repo" }) });
  const answer = await flow.waitForToken({ deviceCode: "dc", interval: 1, expiresIn: 60 }, undefined, noSleep);
  assert.deepEqual([answer.expiresIn, answer.refreshToken], [0, ""]);
});

test("refresh sends client_id and refresh_token only (no client secret) and returns the rotated pair", async () => {
  let request;
  const flow = createDeviceFlow({
    clientId: "Ov23test",
    fetch: async (url, init) => {
      request = { url, init };
      return json({ access_token: "ghu_b", expires_in: 28800, refresh_token: "ghr_s", refresh_token_expires_in: 15897600 });
    },
  });
  const renewed = await flow.refresh("ghr_r");
  assert.equal(request.url, "https://github.com/login/oauth/access_token");
  const body = new URLSearchParams(request.init.body);
  assert.deepEqual([body.get("client_id"), body.get("grant_type"), body.get("refresh_token")], ["Ov23test", "refresh_token", "ghr_r"]);
  assert.equal(body.has("client_secret"), false);
  assert.deepEqual([renewed.token, renewed.refreshToken], ["ghu_b", "ghr_s"]);
});

test("a refused refresh token is permanent; network trouble and 5xx are transient", async () => {
  const refused = createDeviceFlow({ clientId: "c", fetch: async () => json({ error: "bad_refresh_token" }) });
  await assert.rejects(refused.refresh("old"), (error) => error instanceof GitHubAuthError && !isTransient(error));
  const down = createDeviceFlow({ clientId: "c", fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }) });
  await assert.rejects(down.refresh("r"), (error) => error.code === "http" && isTransient(error));
  const offline = createDeviceFlow({ clientId: "c", fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.refresh("r"), (error) => isTransient(error));
});
