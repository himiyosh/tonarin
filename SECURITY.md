# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/himiyosh/tonarin/security/advisories/new), not as a public issue.
Include what you found, how to reproduce it, and the impact you expect. This is a personal project, so please allow
some time for a reply.

## Supported versions

Only the latest release and `main` receive fixes.

## Security design

Tonarin handles a microphone, API keys and connected apps, so these rules are kept on purpose:

| Area | Rule |
|---|---|
| Voice privacy | The preferred whisper.cpp path keeps microphone audio on the device; only the final transcript and conversation context go to GitHub Copilot; local TTS requires an installed `localService` system voice |
| Secrets | Optional legacy Gemini key, MCP tokens and the GitHub sign-in are encrypted with Electron `safeStorage` (macOS keychain, or DPAPI for the Windows account) and never sent to a page |
| Local proxy | Binds to `127.0.0.1`, requires a bearer key, and rejects WebSocket connections from web page origins |
| Copilot | Only Tonarin's custom read-only tools; built-in shell, file and URL tools are disabled; permission requests other than custom tools are rejected; empty temp working folder; Copilot Memory off |
| Untrusted content | News articles and MCP results are labeled as data, not instructions, and capped in size; articles are fetched only from allow-listed HTTPS hosts, re-checked after redirects |
| Connected apps | Tools that create, change or delete are off by default and require the user's consent in conversation |
| Logging | App events and token counts only; never transcripts, audio or keys |
| GitHub sign-in | OAuth device flow with a public client ID and no client secret; 8-hour tokens renewed automatically; read-only MCP access |
| Pages | Strict Content Security Policy, sandboxed renderers, navigation and new windows blocked |
| Releases | Built and smoke-tested in CI from a tag on `main`, published with SHA-256 checksums; the download page loads nothing from other sites |
