# Configuration

Most people only need the settings window. This page lists everything else: environment variables for development
and for running the proxy on its own, where Tonarin keeps its data, and how to connect apps.

## Where Tonarin keeps its data

Everything is in one folder: `~/Library/Application Support/Tonarin/` on a Mac, `%APPDATA%\Tonarin\` on Windows
(`TONARIN_USER_DATA` points one run at another folder).

| File | Contents |
|---|---|
| `settings.json` | Settings (no secrets) |
| `secrets.json` | Gemini key, MCP tokens and the GitHub sign-in, encrypted with Electron `safeStorage`: the keychain item "Tonarin Safe Storage" on a Mac, DPAPI for your account on Windows |
| `automations.json` | Automations and their history |
| `reminders.json` | Pending reminders |
| `usage.json` | Daily token counts (numbers only) |
| `logs/` | `main.log` and `proxy.log` (app events, never conversation content) |

On Windows the app itself is installed in `%LOCALAPPDATA%\Programs\tonarin\`. Uninstalling it (Settings → Apps)
keeps the data folder above.

## Environment variables

Put them in `.env` (see [`.env.example`](../.env.example)) or export them. The packaged app does not read `.env`;
its settings window is the source of truth there.

### Proxy and Copilot

| Variable | Default | Description |
|---|---|---|
| `PROXY_API_KEY` | random per launch (the app stores its own) | Bearer key for the local proxy |
| `PORT` | `8787` | Listening port (always bound to `127.0.0.1`) |
| `COPILOT_MODEL` | `gpt-5.4-mini` | Copilot model id. `npm run models` lists what your plan allows; `npm run bench` compares latency |
| `COPILOT_REASONING_EFFORT` | unset | `none`, `low`, … |
| `COPILOT_GITHUB_TOKEN` | unset | Use a token instead of the Copilot CLI sign-in |
| `COPILOT_SANDBOX_DIR` | `copilot-proxy-sandbox` in the system temp folder | Copilot's working folder. Keep it outside any repository |
| `FILLER_TEXT` | `ちょっと調べてみますね。` | What the OpenAI-compatible endpoint streams while a tool runs |
| `LLM_BASE_URL` / `LLM_MODEL` | unset | Bring your own OpenAI-compatible model instead of Copilot (for offline tests) |
| `DEBUG_REQUESTS` | unset | `1` logs request shapes, event types, tool timings and token counts, never content |

### Realtime voice (Gemini Live)

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | unset | Enables `/v1/live`. A key saved in the settings window wins |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | Live model |
| `GEMINI_VOICE` | `Aoede` | Default voice (30 voices; the settings window lists them) |
| `LIVE_LANGUAGE` | `ja` | Default speech language (`ja` or `en`) |
| `LIVE_SILENCE_MS` | `700` | Pause that ends your turn |
| `LIVE_PERSONA` | built-in buddy | Default character description |

The pet sends its own settings (language, voice, pause, noise filter, persona, feeds, Copilot on or off) with every
connection, so these are only defaults for other clients.

### Pet

| Variable | Default | Description |
|---|---|---|
| `CODEX_PETS_DIR` | `~/.codex/pets` | Where to look for Codex / ChatGPT pets |
| `PET_CHARACTER` | unset | Character for this run only (`robo`, `codex:<folder>`, …) |
| `PET_BUNDLED_PROXY` | unset | `1` (or the `--bundled-proxy` flag, as `npm run pet:bundled` does) runs the bundled `dist/server.mjs` on a free port, like the packaged app |
| `TONARIN_USER_DATA` | the app's folder (above) | Another folder for settings, secrets and logs, for a second copy or a test run |
| `TONARIN_SMOKE_TEST` | unset | A file path: the app checks itself, writes a report there and quits (used by `npm run smoke`) |
| `TONARIN_GITHUB_CLIENT_ID` | from `package.json` | Try "Sign in with GitHub" with another OAuth App |
| `TONARIN_GITHUB_REFRESH_BEFORE_MIN` | `15` | Renew GitHub tokens this many minutes early (`600` renews right away, for testing) |

### Speech services for the OpenAI-compatible endpoint

| Variable | Default | Description |
|---|---|---|
| `TTS_VOICE` / `TTS_RATE` | `Kyoko` / `200` | macOS `say` voice and rate for `/v1/audio/speech` (macOS only) |
| `WHISPER` | unset | `off` skips whisper.cpp (the pet always sets this) |
| `WHISPER_MODEL` | `models/ggml-large-v3-turbo-q5_0.bin` | whisper.cpp model for `/v1/audio/transcriptions` |
| `WHISPER_LANGUAGE` / `WHISPER_PROMPT` | `ja` / tech vocabulary | Recognition language and hint |

## Connected apps (MCP)

**Settings → Connected apps** has presets and a custom option (stdio command or HTTPS URL). Tools that only read are
on by default; tools that create, change or delete start off, and the pet asks before using one. Results are sent to
Gemini as part of the conversation, so keep confidential apps disconnected on the free tier.

### Your Mac's calendar (Google, iCloud, Exchange; macOS only)

1. System Settings → Internet Accounts: add the account and turn on **Calendars**.
2. Install [che-ical-mcp](https://github.com/PsychQuant/che-ical-mcp):
   ```bash
   mkdir -p ~/bin
   curl -L https://github.com/PsychQuant/che-ical-mcp/releases/latest/download/CheICalMCP -o ~/bin/CheICalMCP
   chmod +x ~/bin/CheICalMCP
   ```
3. Settings → Connected apps → **Mac Calendar** → Save and connect.
4. The first time the pet reads your calendar, macOS asks whether **Tonarin** may access it.

### Your own servers (Custom)

Give a command (stdio) or an HTTPS URL (Streamable HTTP). A command can be a full path or a name found on your PATH,
such as `npx` with the arguments `-y` and the package name; on Windows `npx` and other `.cmd` commands work too.
`~/` (and `~\` on Windows) is your home folder. Local servers get a minimal environment plus the variables you enter,
never the proxy's own keys.

### GitHub (read-only)

Click **Sign in with GitHub**, enter the code GitHub shows, and authorize Tonarin. The connection uses GitHub's
remote MCP server with `X-MCP-Readonly: true`. Organizations that restrict OAuth Apps must approve Tonarin before
their repositories are readable. You can still paste a fine-grained token instead.

## OpenAI-compatible endpoint

The proxy started life as a bridge for [Project AIRI](https://github.com/moeru-ai/airi) and still serves:

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Chat through Copilot (model id `copilot`), streaming, with the news tools |
| `POST /v1/audio/speech` | Text to speech with macOS `say` (macOS only) |
| `POST /v1/audio/transcriptions` | Speech to text with whisper.cpp |
| `GET /v1/models` | Model list |

```bash
PROXY_API_KEY=<long random string> npm start    # http://127.0.0.1:8787/v1
```

In AIRI, point the Chat, Speech and Transcription "OpenAI Compatible" providers at `http://127.0.0.1:8787/v1/` with
that key, and pick `copilot`, `tts-1` and `whisper-1`.
