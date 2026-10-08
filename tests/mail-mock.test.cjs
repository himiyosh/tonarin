const assert = require("node:assert/strict");
const { readFileSync, existsSync, mkdtempSync, rmSync } = require("node:fs");
const Module = require("node:module");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { createMailMock, createMockProvider, pkceChallenge, MailMockError } = require("../pet/mail-mock.cjs");
const { Settings } = require("../pet/settings.cjs");

function harness({ notify = () => true, adapter, now = () => 1_000 } = {}) {
  const secrets = new Map();
  const settings = {
    values: { mailMockEnabled: false, mailMockProvider: "gmail" },
    hasSecret: (name) => secrets.has(name),
    getSecret: (name) => secrets.get(name),
    setSecret(name, value) { value ? secrets.set(name, value) : secrets.delete(name); },
    update(patch) { Object.assign(this.values, patch); },
  };
  const mock = createMailMock({ settings, notify, translate: (key, vars = {}) =>
    `${key} ${vars.sender ?? ""} ${vars.subject ?? ""}`, adapter, now });
  return { mock, settings, secrets };
}

function connect(mock) {
  mock.setEnabled(true);
  mock.begin();
  assert.equal(mock.snapshot().status, "pending");
  mock.approve();
  assert.equal(mock.snapshot().status, "connected");
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof MailMockError && error.code === code);
}

test("PKCE S256 matches the published verifier vector; fake codes are single-use and expire", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  let clock = 1_000;
  const provider = createMockProvider({ now: () => clock });
  const verifier = "v".repeat(43);
  const input = { state: "s".repeat(32), challenge: pkceChallenge(verifier) };
  const first = provider.authorize("gmail", input);
  errorCode(() => provider.exchange("gmail", { code: first.code, verifier: "x".repeat(43) }), "pkce-mismatch");
  errorCode(() => provider.exchange("gmail", { code: first.code, verifier }), "code-invalid");
  const second = provider.authorize("outlook", input);
  errorCode(() => provider.exchange("gmail", { code: second.code, verifier }), "code-invalid");
  const third = provider.authorize("gmail", input);
  clock += 2 * 60_000;
  errorCode(() => provider.exchange("gmail", { code: third.code, verifier }), "expired");
});

test("Gmail-style ID/header and Graph-style list responses contain only fictional metadata", () => {
  const provider = createMockProvider();
  const gmail = provider.list("gmail", 2);
  assert.deepEqual(gmail.messages.map(({ id }) => id), ["gmail-1", "gmail-2"]);
  assert.ok(gmail.messages.every((item) => Object.keys(item).sort().join(",") === "id,threadId"));
  const details = provider.getMetadata("gmail", gmail.messages[0].id);
  assert.equal(details.payload.headers.find((header) => header.name === "From").value, "Demo Desk <desk@example.invalid>");
  assert.equal(details.payload.headers.find((header) => header.name === "Subject").value, "A fictional welcome");
  const graph = provider.list("outlook", 2);
  assert.deepEqual(graph.value.map(({ id }) => id), ["outlook-1", "outlook-2"]);
  assert.deepEqual(graph.value[0].from.emailAddress, { name: "Demo Studio", address: "studio@example.invalid" });
  assert.equal(graph.value[0].subject, "A fictional introduction");
  for (const response of [gmail, details, graph]) {
    assert.doesNotMatch(JSON.stringify(response), /body|bodyPreview|attachment|This is a fictional/i);
  }
  errorCode(() => provider.list("gmail", 4), "invalid");
});

test("authorization generates random state and verifier; mismatch, replay and expiry never store a token", () => {
  let clock = 1_000;
  const now = () => clock;
  const provider = createMockProvider({ now });
  let seen;
  const { mock, secrets } = harness({
    now,
    adapter: {
      authorize(id, input) {
        seen = input;
        const response = provider.authorize(id, input);
        return { ...response, state: "wrong" };
      },
      exchange() { assert.fail("state mismatch must stop before token exchange"); },
    },
  });
  mock.setEnabled(true);
  mock.begin();
  errorCode(() => mock.approve(), "state-mismatch");
  assert.match(seen.state, /^[\w-]{32}$/);
  assert.match(seen.challenge, /^[\w-]{43}$/);
  assert.equal(secrets.size, 0);
  errorCode(() => mock.approve(), "no-pending");
  mock.begin();
  clock += 2 * 60_000;
  errorCode(() => mock.approve(), "expired");
  assert.equal(secrets.size, 0);

  const valid = harness({ now });
  valid.mock.setEnabled(true);
  valid.mock.begin();
  valid.mock.approve();
  assert.equal(valid.secrets.size, 1);
  errorCode(() => valid.mock.approve(), "no-pending");
  assert.equal(valid.mock.snapshot().messages.length, 1);
});

test("the mock is off by default; provider switching isolates fictional accounts and disconnect clears all state", () => {
  const { mock, secrets, settings } = harness();
  assert.equal(mock.snapshot().status, "off");
  assert.deepEqual(mock.snapshot().messages, []);
  errorCode(() => mock.begin(), "off");
  connect(mock);
  const gmail = mock.snapshot();
  assert.equal(gmail.account, "gmail-demo@example.invalid");
  assert.equal(gmail.messages.length, 1);
  assert.equal(gmail.messages[0].id, "gmail-1");
  assert.equal("body" in gmail.messages[0], false);
  assert.equal(JSON.stringify(gmail).includes("mail-mock-"), false);
  assert.equal(secrets.has("mailMock:gmail"), true);
  mock.setBodyOptIn(true);
  mock.setReadAloud(true);
  mock.viewBody("gmail-1");
  mock.selectProvider("outlook");
  assert.equal(secrets.size, 0);
  assert.equal(mock.snapshot().status, "ready");
  assert.equal(mock.snapshot().bodyOptIn, false);
  assert.equal(mock.snapshot().readAloud, false);
  assert.deepEqual(mock.snapshot().messages, []);
  mock.begin();
  mock.approve();
  assert.equal(mock.snapshot().messages[0].id, "outlook-1");
  assert.equal(mock.snapshot().account, "outlook-demo@example.invalid");
  assert.equal(secrets.has("mailMock:outlook"), true);
  mock.disconnect();
  assert.equal(secrets.size, 0);
  assert.equal(mock.snapshot().status, "ready");
  assert.deepEqual(mock.snapshot().messages, []);
  mock.begin();
  mock.disconnect();
  errorCode(() => mock.approve(), "no-pending");
  mock.setEnabled(false);
  assert.equal(settings.values.mailMockEnabled, false);
  assert.equal(mock.snapshot().status, "off");
});

test("disconnect removes only fake mail tokens and preserves unrelated encrypted settings", () => {
  const { mock, secrets } = harness();
  secrets.set("geminiApiKey", "unrelated-encrypted-value");
  connect(mock);
  mock.disconnect();
  assert.deepEqual([...secrets.entries()], [["geminiApiKey", "unrelated-encrypted-value"]]);
  mock.setEnabled(false);
  assert.deepEqual([...secrets.entries()], [["geminiApiKey", "unrelated-encrypted-value"]]);
});

test("only two local mock new-mail events produce metadata notifications; unsupported notifications are reported", () => {
  const notices = [];
  const { mock } = harness({ notify: (title, body) => { notices.push({ title, body }); return true; } });
  connect(mock);
  assert.equal(mock.snapshot().remaining, 2);
  const first = mock.nextMail();
  assert.equal(first.notification, "requested");
  assert.equal(first.message.id, "gmail-2");
  assert.equal(mock.snapshot().remaining, 1);
  const second = mock.nextMail();
  assert.equal(second.message.id, "gmail-3");
  assert.equal(mock.snapshot().messages.length, 3);
  assert.equal(mock.snapshot().remaining, 0);
  errorCode(() => mock.nextMail(), "exhausted");
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.match(notice.title, /mailMockNotificationTitle/);
    assert.match(notice.body, /mailMockNotificationBody/);
    assert.doesNotMatch(notice.body, /This is the final scripted/);
  }
  const unavailable = harness({ notify: () => false });
  connect(unavailable.mock);
  assert.equal(unavailable.mock.nextMail().notification, "unsupported");
  assert.equal(unavailable.mock.snapshot().messages.length, 2);
});

test("fictional bodies require opt-in; separate per-item AI confirmation never sends or summarizes anything", () => {
  const { mock, settings } = harness();
  connect(mock);
  errorCode(() => mock.viewBody("gmail-1"), "body-opt-in");
  errorCode(() => mock.confirmAiTransfer("gmail-1", true), "body-opt-in");
  mock.setBodyOptIn(true);
  errorCode(() => mock.confirmAiTransfer("gmail-1", true), "body-not-viewed");
  errorCode(() => mock.viewBody("gmail-3"), "invalid-message");
  assert.match(mock.viewBody("gmail-1").body, /fictional/);
  errorCode(() => mock.confirmAiTransfer("gmail-1", false), "ai-confirmation");
  assert.deepEqual(mock.confirmAiTransfer("gmail-1", true), { demoOnly: true, sent: false, summarized: false });
  errorCode(() => mock.confirmAiTransfer("gmail-1", true), "body-not-viewed");
  mock.setBodyOptIn(false);
  assert.equal(mock.snapshot().bodyOptIn, false);
  errorCode(() => mock.viewBody("gmail-1"), "body-opt-in");
  mock.setBodyOptIn(true);
  const restarted = createMailMock({ settings, notify: () => false, translate: () => "MOCK", now: () => 1_000 });
  assert.equal(restarted.snapshot().status, "connected");
  assert.equal(restarted.snapshot().bodyOptIn, false, "consent is not persisted for later sessions");
  errorCode(() => restarted.viewBody("gmail-1"), "body-opt-in");
});

test("expired or unreadable fake tokens are errors, not empty inboxes or apparent success", () => {
  let clock = 1_000;
  const { mock, secrets } = harness({ now: () => clock });
  connect(mock);
  clock += 60 * 60_000;
  assert.equal(mock.snapshot().status, "error");
  assert.equal(mock.snapshot().error, "token-expired");
  assert.deepEqual(mock.snapshot().messages, []);
  errorCode(() => mock.nextMail(), "token-expired");
  mock.disconnect();
  assert.equal(mock.snapshot().status, "ready");
  mock.begin();
  mock.approve();
  secrets.set("mailMock:gmail", "corrupt");
  assert.equal(mock.snapshot().error, "storage");
  errorCode(() => mock.viewBody("gmail-1"), "storage");
  mock.disconnect();
  assert.equal(secrets.size, 0);
});

test("authorization never claims success when an encrypted fake token cannot be read back", () => {
  const { mock, secrets, settings } = harness();
  settings.getSecret = () => undefined;
  mock.setEnabled(true);
  mock.begin();
  errorCode(() => mock.approve(), "storage");
  assert.equal(secrets.size, 0);
  assert.equal(mock.snapshot().status, "ready");
});

test("real Settings encrypts fake tokens via safeStorage, refuses unavailable/plaintext storage, and disconnects", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "tonarin-mail-mock-"));
  context.after(() => rmSync(dir, { recursive: true }));
  let available = false;
  let backend = "default";
  const native = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`cipher:${Buffer.from(value).toString("base64url")}`),
    decryptString: (value) => Buffer.from(value.toString().slice(7), "base64url").toString(),
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    return request === "electron" ? { safeStorage: native } : originalLoad.call(this, request, ...args);
  };
  try {
    const settings = new Settings(dir);
    const mock = createMailMock({ settings, notify: () => true, translate: () => "MOCK" });
    mock.setEnabled(true);
    mock.begin();
    errorCode(() => mock.approve(), "storage-unavailable");
    assert.equal(settings.hasSecret("mailMock:gmail"), false);
    assert.equal(existsSync(settings.secretsFile), false);
    available = true;
    backend = "basic_text";
    mock.begin();
    errorCode(() => mock.approve(), "storage-unavailable");
    assert.equal(existsSync(settings.secretsFile), false);
    backend = "default";
    mock.begin();
    mock.approve();
    assert.equal(mock.snapshot().status, "connected");
    const stored = readFileSync(settings.secretsFile, "utf8");
    assert.equal(stored.includes("mail-mock-"), false);
    assert.equal(stored.includes(settings.getSecret("mailMock:gmail")), false);
    available = false;
    assert.equal(mock.snapshot().error, "storage");
    mock.disconnect();
    assert.equal(settings.hasSecret("mailMock:gmail"), false);
    assert.equal(readFileSync(settings.secretsFile, "utf8").includes("mailMock:gmail"), false);
  } finally {
    Module._load = originalLoad;
  }
});

test("the demo path has no mail-provider, network, AI, or mail-mutation adapter", () => {
  const core = readFileSync(join(__dirname, "../pet/mail-mock.cjs"), "utf8");
  const speech = readFileSync(join(__dirname, "../pet/ui/mail-mock-speech.js"), "utf8");
  const main = readFileSync(join(__dirname, "../pet/main.cjs"), "utf8");
  const ui = readFileSync(join(__dirname, "../pet/ui/settings.js"), "utf8");
  const petRenderer = readFileSync(join(__dirname, "../pet/ui/renderer.js"), "utf8");
  assert.deepEqual([...core.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]), ["node:crypto"]);
  for (const source of [core, speech]) {
    assert.doesNotMatch(source, /https?:\/\/|fetch\s*\(|WebSocket|shell\.openExternal|request\s*\(|gmail\.com|googleapis\.com|graph\.microsoft\.com/);
  }
  const route = main.split('ipcMain.handle("settings:mail-mock"')[1].split('ipcMain.handle("settings:set-gemini-key"')[0];
  const screen = ui.split("function sectionMailMock()")[1].split("function sectionConnection()")[0];
  assert.ok(route && screen);
  assert.doesNotMatch(route, /proxyRequest|net\.fetch|shell\.openExternal|sendToPet|fetch\s*\(/);
  assert.doesNotMatch(screen, /api\.open|api\.set\s*\(|api\.mcp|api\.github|fetch\s*\(/);
  assert.doesNotMatch(petRenderer, /mailMock|mail-mock/, "the Gemini/Copilot session never consumes mock mail metadata");
  assert.match(main, /fromSettingsPage\(event\)/);
  assert.match(main, /Object\.hasOwn\(patch, "mailMockEnabled"\)/);
  assert.match(main, /Object\.hasOwn\(patch, "mailMockProvider"\)/);
});
