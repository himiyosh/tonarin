/**
 * "Sign in with GitHub" for the GitHub MCP connection: the OAuth device flow.
 *
 * The app shows a short code, opens github.com/login/device, and the user approves "Tonarin" there. No client secret is
 * involved (the device flow is made for apps that cannot keep one), only the public client ID of the Tonarin OAuth App
 * (package.json "tonarin.githubClientId", or TONARIN_GITHUB_CLIENT_ID while developing).
 * The token never leaves the main process: it goes straight into the keychain as the MCP server's Authorization header.
 * The Tonarin OAuth App has "Expire user access tokens" on: access tokens last 8 hours and come with a refresh token
 * (6 months); main refreshes them shortly before they expire (`refresh()`), again without a client secret.
 * https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 */
const DEFAULT_BASE = "https://github.com";
const API_BASE = "https://api.github.com";

class GitHubAuthError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {(url: string, init?: object) => Promise<Response>} options.fetch  Electron's net.fetch (or a test double)
 * @param {string} options.clientId
 * @param {string} [options.base]  test hook
 * @param {string} [options.apiBase]  test hook
 */
function createDeviceFlow({ fetch, clientId, base = DEFAULT_BASE, apiBase = API_BASE }) {
  const post = async (path, fields) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // not JSON
    }
    if (!response.ok && !data.error) throw new GitHubAuthError("http", `GitHub answered HTTP ${response.status}`);
    return data;
  };

  /** Step 1: a device code and the short code the user types on github.com. */
  async function start(scope) {
    const data = await post("/login/device/code", { client_id: clientId, scope });
    if (data.error) throw new GitHubAuthError(data.error, data.error_description);
    if (typeof data.device_code !== "string" || typeof data.user_code !== "string") throw new GitHubAuthError("bad-response");
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: typeof data.verification_uri === "string" ? data.verification_uri : `${base}/login/device`,
      expiresIn: Number(data.expires_in) || 900,
      interval: Math.max(Number(data.interval) || 5, 1),
    };
  }

  /** Step 2: poll until the user approved (or declined, or the code expired). Resolves with the access token. */
  async function waitForToken({ deviceCode, interval, expiresIn }, signal, sleep = defaultSleep) {
    const deadline = Date.now() + expiresIn * 1000;
    let wait = interval;
    while (Date.now() < deadline) {
      await sleep(wait * 1000, signal);
      if (signal?.aborted) throw new GitHubAuthError("cancelled");
      const data = await post("/login/oauth/access_token", {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (typeof data.access_token === "string" && data.access_token) return tokenResult(data);
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        wait = Number(data.interval) || wait + 5;
        continue;
      }
      throw new GitHubAuthError(data.error ?? "unknown", data.error_description);
    }
    throw new GitHubAuthError("expired_token");
  }

  /**
   * Step 3, only for apps with "Expire user access tokens": trade the refresh token for a new pair. GitHub rotates
   * the refresh token, so the new one must be saved before the old one is dropped. Tokens from the device flow
   * refresh without a client secret.
   */
  async function refresh(refreshToken) {
    const data = await post("/login/oauth/access_token", {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (typeof data.access_token === "string" && data.access_token) return tokenResult(data);
    throw new GitHubAuthError(data.error ?? "unknown", data.error_description);
  }

  /** The signed-in account's login, for display ("@octocat"). */
  async function whoAmI(token) {
    const response = await fetch(`${apiBase}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) throw new GitHubAuthError("http", `GitHub answered HTTP ${response.status}`);
    const data = await response.json();
    return typeof data.login === "string" ? data.login.slice(0, 100) : "";
  }

  return { start, waitForToken, refresh, whoAmI };
}

/**
 * An access token answer. `expiresIn` / `refreshExpiresIn` are seconds, 0 when the token does not expire
 * (an OAuth App without "Expire user access tokens").
 */
function tokenResult(data) {
  return {
    token: data.access_token,
    scope: String(data.scope ?? ""),
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
    expiresIn: Math.max(Number(data.expires_in) || 0, 0),
    refreshExpiresIn: Math.max(Number(data.refresh_token_expires_in) || 0, 0),
  };
}

/** Worth trying again later (network, GitHub having a moment), as opposed to a refresh token GitHub refused. */
function isTransient(error) {
  return !(error instanceof GitHubAuthError) || error.code === "http" || error.code === "bad-response";
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

module.exports = { createDeviceFlow, GitHubAuthError, isTransient };
