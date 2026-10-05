const crypto = require("node:crypto");

const AUTH_WINDOW_MS = 2 * 60_000;
const TOKEN_WINDOW_MS = 60 * 60_000;
const PROVIDERS = {
  gmail: {
    account: "gmail-demo@example.invalid",
    messages: [
      { id: "gmail-1", sender: { name: "Demo Desk", address: "desk@example.invalid" }, subject: "A fictional welcome",
        body: "This is a fictional Gmail-style message. No mailbox was accessed." },
      { id: "gmail-2", sender: { name: "Sample Garden", address: "garden@example.invalid" }, subject: "A pretend seedling update",
        body: "The sample seedlings are doing well. This message exists only in the local demo." },
      { id: "gmail-3", sender: { name: "Demo Desk", address: "desk@example.invalid" }, subject: "A sample weekend plan",
        body: "This is the final scripted Gmail-style event. No real message was received." },
    ],
  },
  outlook: {
    account: "outlook-demo@example.invalid",
    messages: [
      { id: "outlook-1", sender: { name: "Demo Studio", address: "studio@example.invalid" }, subject: "A fictional introduction",
        body: "This is a fictional Outlook-style message. No mailbox was accessed." },
      { id: "outlook-2", sender: { name: "Sample Library", address: "library@example.invalid" }, subject: "A pretend reading list",
        body: "These book titles are imaginary. This message exists only in the local demo." },
      { id: "outlook-3", sender: { name: "Demo Studio", address: "studio@example.invalid" }, subject: "A sample project note",
        body: "This is the final scripted Outlook-style event. No real message was received." },
    ],
  },
};

class MailMockError extends Error {
  constructor(code) {
    super(`Mail demo: ${code}`);
    this.code = code;
  }
}

const validProvider = (provider) => Object.hasOwn(PROVIDERS, provider);
const secretName = (provider) => `mailMock:${provider}`;
const pkceChallenge = (verifier) => crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
const senderLine = ({ name, address }) => `${name} <${address}>`;

function createMockProvider({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  const codes = new Map();
  return {
    authorize(provider, { state, challenge }) {
      if (!validProvider(provider) || !/^[\w-]{32,}$/.test(state) || !/^[\w-]{43}$/.test(challenge)) {
        throw new MailMockError("invalid");
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { provider, state, challenge, expiresAt: now() + AUTH_WINDOW_MS });
      return { code, state };
    },
    exchange(provider, { code, verifier }) {
      const issued = codes.get(code);
      codes.delete(code); // A code is single-use even when a later check fails.
      if (!issued || issued.provider !== provider) throw new MailMockError("code-invalid");
      if (now() >= issued.expiresAt) throw new MailMockError("expired");
      if (pkceChallenge(verifier) !== issued.challenge) throw new MailMockError("pkce-mismatch");
      return {
        provider,
        account: PROVIDERS[provider].account,
        accessToken: `mail-mock-${randomBytes(32).toString("base64url")}`,
        expiresAt: now() + TOKEN_WINDOW_MS,
      };
    },
    list(provider, count) {
      const messages = PROVIDERS[provider]?.messages;
      if (!messages || !Number.isInteger(count) || count < 1 || count > messages.length) throw new MailMockError("invalid");
      const shown = messages.slice(0, count);
      if (provider === "gmail") {
        return { messages: shown.map(({ id }) => ({ id, threadId: `mock-thread-${id}` })) };
      }
      return { value: shown.map(({ id, sender, subject }) =>
        ({ id, from: { emailAddress: { ...sender } }, subject })) };
    },
    getMetadata(provider, id) {
      const message = provider === "gmail" && PROVIDERS.gmail.messages.find((item) => item.id === id);
      if (!message) throw new MailMockError("invalid-message");
      return { id, payload: { headers: [
        { name: "From", value: senderLine(message.sender) },
        { name: "Subject", value: message.subject },
      ] } };
    },
  };
}

function createMailMock({ settings, notify, translate, now = Date.now, randomBytes = crypto.randomBytes, adapter = createMockProvider({ now, randomBytes }) }) {
  let pending = null;
  let delivered = 0;
  let bodyOptIn = false;
  let readAloud = false;
  let viewedBodyId = null;

  function resetSession() {
    pending = null;
    delivered = 0;
    bodyOptIn = false;
    readAloud = false;
    viewedBodyId = null;
  }

  function clearTokens() {
    for (const provider of Object.keys(PROVIDERS)) {
      if (settings.hasSecret(secretName(provider))) settings.setSecret(secretName(provider), "");
    }
  }

  function readToken() {
    const provider = settings.values.mailMockProvider;
    if (!settings.hasSecret(secretName(provider))) return null;
    const raw = settings.getSecret(secretName(provider));
    if (!raw) throw new MailMockError("storage");
    let token;
    try {
      token = JSON.parse(raw);
    } catch {
      throw new MailMockError("storage");
    }
    if (token?.provider !== provider || token.account !== PROVIDERS[provider].account ||
        !/^mail-mock-[\w-]{43}$/.test(token.accessToken) || !Number.isFinite(token.expiresAt)) {
      throw new MailMockError("storage");
    }
    if (now() >= token.expiresAt) throw new MailMockError("token-expired");
    return token;
  }

  function requireConnected() {
    if (!settings.values.mailMockEnabled) throw new MailMockError("off");
    if (!readToken()) throw new MailMockError("not-connected");
  }

  function listedMetadata() {
    const provider = settings.values.mailMockProvider;
    const response = adapter.list(provider, delivered + 1);
    if (provider === "gmail") {
      return response.messages.map(({ id }) => {
        const detail = adapter.getMetadata(provider, id);
        const headers = detail.payload.headers;
        return {
          id: detail.id,
          sender: headers.find((header) => header.name === "From").value,
          subject: headers.find((header) => header.name === "Subject").value,
        };
      });
    }
    return response.value.map(({ id, from, subject }) =>
      ({ id, sender: senderLine(from.emailAddress), subject }));
  }

  function snapshot() {
    const enabled = settings.values.mailMockEnabled;
    const provider = settings.values.mailMockProvider;
    let token = null;
    let error;
    if (enabled) {
      try {
        token = readToken();
      } catch (cause) {
        if (!(cause instanceof MailMockError)) throw cause;
        error = cause.code;
      }
    }
    const connected = Boolean(token);
    return {
      enabled,
      provider,
      status: !enabled ? "off" : error ? "error" : connected ? "connected" : pending ? "pending" : "ready",
      error,
      account: connected ? PROVIDERS[provider].account : null,
      messages: connected ? listedMetadata() : [],
      remaining: connected ? PROVIDERS[provider].messages.length - delivered - 1 : 0,
      bodyOptIn: connected && bodyOptIn,
      readAloud: connected && readAloud,
    };
  }

  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new MailMockError("invalid");
    if (settings.values.mailMockEnabled === enabled) return;
    clearTokens();
    resetSession();
    settings.update({ mailMockEnabled: enabled });
  }

  function selectProvider(provider) {
    if (!validProvider(provider)) throw new MailMockError("invalid");
    if (settings.values.mailMockProvider === provider) return;
    clearTokens();
    resetSession();
    settings.update({ mailMockProvider: provider });
  }

  function begin() {
    if (!settings.values.mailMockEnabled) throw new MailMockError("off");
    if (readToken()) throw new MailMockError("already-connected");
    if (pending) throw new MailMockError("pending");
    const verifier = randomBytes(32).toString("base64url");
    pending = {
      provider: settings.values.mailMockProvider,
      verifier,
      challenge: pkceChallenge(verifier),
      state: randomBytes(24).toString("base64url"),
      expiresAt: now() + AUTH_WINDOW_MS,
    };
  }

  function approve() {
    if (!pending) throw new MailMockError("no-pending");
    const flow = pending;
    pending = null;
    if (!settings.values.mailMockEnabled || settings.values.mailMockProvider !== flow.provider) throw new MailMockError("off");
    if (now() >= flow.expiresAt) throw new MailMockError("expired");
    const response = adapter.authorize(flow.provider, { state: flow.state, challenge: flow.challenge });
    if (response?.state !== flow.state) throw new MailMockError("state-mismatch");
    const token = adapter.exchange(flow.provider, { code: response.code, verifier: flow.verifier });
    if (token?.provider !== flow.provider || token.account !== PROVIDERS[flow.provider].account ||
        !/^mail-mock-[\w-]{43}$/.test(token.accessToken) || !Number.isFinite(token.expiresAt) || token.expiresAt <= now()) {
      throw new MailMockError("invalid-response");
    }
    try {
      settings.setSecret(secretName(flow.provider), JSON.stringify(token));
      readToken();
    } catch (error) {
      if (settings.hasSecret(secretName(flow.provider))) settings.setSecret(secretName(flow.provider), "");
      if (error?.message === "Secure storage is not available") throw new MailMockError("storage-unavailable");
      throw error;
    }
    delivered = 0;
    bodyOptIn = false;
    readAloud = false;
    viewedBodyId = null;
  }

  function cancel() {
    if (!pending) throw new MailMockError("no-pending");
    pending = null;
  }

  function disconnect() {
    clearTokens();
    resetSession();
  }

  function nextMail() {
    requireConnected();
    const messages = PROVIDERS[settings.values.mailMockProvider].messages;
    if (delivered >= messages.length - 1) throw new MailMockError("exhausted");
    delivered++;
    const message = listedMetadata().at(-1);
    let notification;
    try {
      notification = notify(translate("mailMockNotificationTitle"), translate("mailMockNotificationBody", message))
        ? "requested" : "unsupported";
    } catch (error) {
      console.error("[mail mock] OS notification failed", error);
      notification = "failed";
    }
    return { message, notification };
  }

  function setBodyOptIn(enabled) {
    if (typeof enabled !== "boolean") throw new MailMockError("invalid");
    requireConnected();
    bodyOptIn = enabled;
    viewedBodyId = null;
  }

  function setReadAloud(enabled) {
    if (typeof enabled !== "boolean") throw new MailMockError("invalid");
    requireConnected();
    readAloud = enabled;
  }

  function viewBody(id) {
    requireConnected();
    if (!bodyOptIn) throw new MailMockError("body-opt-in");
    const message = PROVIDERS[settings.values.mailMockProvider].messages.slice(0, delivered + 1).find((item) => item.id === id);
    if (!message) throw new MailMockError("invalid-message");
    viewedBodyId = id;
    return { id, body: message.body };
  }

  function confirmAiTransfer(id, confirmed) {
    requireConnected();
    if (!bodyOptIn) throw new MailMockError("body-opt-in");
    if (viewedBodyId !== id) throw new MailMockError("body-not-viewed");
    if (confirmed !== true) throw new MailMockError("ai-confirmation");
    viewedBodyId = null;
    return { demoOnly: true, sent: false, summarized: false };
  }

  return { snapshot, setEnabled, selectProvider, begin, approve, cancel, disconnect, nextMail,
    setBodyOptIn, setReadAloud, viewBody, confirmAiTransfer };
}

module.exports = { createMailMock, createMockProvider, pkceChallenge, MailMockError };
