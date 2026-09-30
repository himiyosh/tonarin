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

### News sources

In **Settings → News**, switch public sources on individually or by topic (technology, general, business, science,
living). The original 12 technology feeds remain the language-specific defaults; new built-in sources are opt-in,
and existing saved selections are preserved. With the default selection, a personal site is enabled when its
language matches the pet's speech language (English practice uses the English set). Up to 10 personal sites may
be saved and up to 30 feeds selected.

Add either a public HTTPS RSS/Atom URL or a public HTTPS site URL. Tonarin checks advertised
`<link rel="alternate" type="application/rss+xml">` / Atom links and a few standard feed paths; it will not save
a site without a readable feed. Removing the site revokes its article permission. A feed host is **not** an article
host: only the exact hostname of the URL you entered is authorized for the added site's `read_article` calls.
When the feed links to a different article host, the headline works but article text cannot be fetched; add that
article site's own URL separately only if it also publishes RSS/Atom. Original technology built-ins retain their
publisher-domain matching for the **restriction** (including subdomains); new built-ins list exact article hosts.
**Every original technology
built-in and the Osaka feeds are feed-only** because article-body reuse has not been individually licensed.
This restriction takes precedence over a matching personal feed, including one saved before this version.
The other listed built-ins with verified article-text reuse terms retain article access. Feeds whose publisher
explicitly disallows this app's RSS/AI use cannot be added as personal sites or reached through feed redirects.
Personal feeds with publisher or article links identifying such a source are rejected too; rewritten links on an
unrelated third-party feed cannot be reliably attributed, so users must still check the publisher's terms.

News fetching uses native HTTPS without a proxy, pins validated public DNS addresses to each socket and
rechecks the connected IP. Redirects (at most four) undergo the same checks; article redirects must also stay
on the original site hostname. Before a **personal article** GET, Tonarin fetches that site's `robots.txt` over
the same pinned HTTPS transport (up to 500 KiB) and checks the article path for its `Tonarin-news` user-agent;
it also checks each article redirect's path. A missing robots.txt (204, 404, 410) has no rules, whereas denial,
authentication errors, server errors, unreadable policies and network failures stop the article request.
Requests to local/private/link-local networks (including IPv4-mapped IPv6) and compressed responses are refused.
Feed/site responses are capped at 1 MiB, article HTML at 2 MiB, and article checks share a 12-second timeout
(15 seconds for discovery). No cookies or credentials are sent. Anonymous public article GET is allowed after
these checks; a 401/402/403 response or detectable paywall/membership marker returns the original link and a
reason **without article text**. Unknown soft paywalls cannot be identified before a GET; Tonarin does not bypass
login, membership or payment. XML DTDs and external entities are refused. Tool results mark headlines, descriptions
and permitted article text as untrusted data, not instructions. Feed-only summaries use RSS `description` or Atom
`summary`, never embedded full-content fields. Keyword watches continue to check the original 12 feeds and also
check enabled new and personal sources.

As of 2026-09-30, verified Japanese built-ins beyond technology cover **general, prefectural industry and
public-life notices**, not large-media reporting. No Japanese science source met the same feed/rights criteria;
its Japanese category visibly says **候補なし** (or **No sources available** in English UI). The topic switches
cover available sources from both languages; add a personal feed for other topics only after checking its terms.

The added built-in feeds were checked on 2026-09-30 against the publishers' own feed and reuse pages. The original technology
feeds and default selection are unchanged. GOV.UK explicitly offers its feeds to other applications and licenses
most content under the OGL; sample articles in each selected category carry an OGL v3.0 footer. This app displays
the required attribution in News settings and includes it in tool results. NSF describes its news RSS as
headlines/summaries/links for standalone readers and permits reuse of most government-authored text; NSF's
optional credit also appears in the app. Images, separately marked third-party works and content noted as
exceptions are not licensed by these statements.
The Digital Agency and MIC apply Japan's [Public Data License 1.0](https://www.digital.go.jp/resources/open_data/public_data_license_v1.0)
to their published content unless marked otherwise. This permits commercial reuse with source attribution;
Tonarin labels its summaries as its own adaptations and includes the original article URLs in tool results.
Osaka Prefecture [offers its RSS in readers](https://www.pref.osaka.lg.jp/o070050/koho/information/rss.html)
but [reserves article-text rights](https://www.pref.osaka.lg.jp/o070050/koho/information/use.html)
outside permitted private use or quotation. Tonarin therefore uses its feed titles/descriptions and links
only, with source attribution; it does not GET Osaka articles.

| Category | Official HTTPS feed | Publisher's feed / article-rights evidence | Article access |
|---|---|---|---|
| General / administration (JA) | [Digital Agency updates](https://www.digital.go.jp/rss/news.xml) | [Official RSS listing](https://www.digital.go.jp/rss), [copyright/PDL1.0 policy](https://www.digital.go.jp/copyright-policy) | Licensed article text |
| General / administration (JA) | [MIC updates (Shift_JIS RDF)](https://www.soumu.go.jp/news.rdf) | [Official RSS listing](https://www.soumu.go.jp/menu_kyotsuu/rss_information.html), [copyright/PDL1.0 policy](https://www.soumu.go.jp/menu_kyotsuu/policy/tyosaku.html) | Licensed article text |
| General (JA) | [Osaka latest notices](https://www.pref.osaka.lg.jp/shinchaku/shinchaku.xml) | [Official RSS listing](https://www.pref.osaka.lg.jp/o070050/koho/information/rss.html), [site use / copyright](https://www.pref.osaka.lg.jp/o070050/koho/information/use.html) | Feed-only |
| Industry / work (JA) | [Osaka business/industry notices](https://www.pref.osaka.lg.jp/shigotosangyou/oshirase/oshirase.xml) | [Official RSS listing](https://www.pref.osaka.lg.jp/o070050/koho/information/rss.html), [site use / copyright](https://www.pref.osaka.lg.jp/o070050/koho/information/use.html) | Feed-only |
| Living (JA) | [Osaka living/environment notices](https://www.pref.osaka.lg.jp/kurashi/oshirase/oshirase.xml) | [Official RSS listing](https://www.pref.osaka.lg.jp/o070050/koho/information/rss.html), [site use / copyright](https://www.pref.osaka.lg.jp/o070050/koho/information/use.html) | Feed-only |
| General (EN) | [GOV.UK news](https://www.gov.uk/search/news-and-communications.atom) | [Feed use and OGL terms](https://www.gov.uk/help/terms-conditions), [OGL v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) | Licensed article text |
| Business (EN) | [HM Treasury news](https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=hm-treasury) | [GOV.UK feed and OGL terms](https://www.gov.uk/help/terms-conditions) | Licensed article text |
| Science (EN) | [Science department news](https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=department-for-science-innovation-and-technology) | [GOV.UK feed and OGL terms](https://www.gov.uk/help/terms-conditions) | Licensed article text |
| Living / health (EN) | [Health department news](https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=department-of-health-and-social-care) | [GOV.UK feed and OGL terms](https://www.gov.uk/help/terms-conditions) | Licensed article text |
| Science (EN) | [NSF news](https://www.nsf.gov/rss/rss_www_news.xml) | [Official RSS listing](https://www.nsf.gov/rss), [text reuse policy](https://www.nsf.gov/policies/digital) | Licensed government-authored text |

**Large-media gap:** a working RSS URL is not permission to send its metadata to an AI assistant. The
[Guardian terms §3](https://www.theguardian.com/help/terms-of-service) explicitly forbid AI synthesis
of associated metadata. [Yahoo!ニュース RSS conditions](https://news.yahoo.co.jp/rss) forbid publishing
an RSS-derived application. The [BBC RSS licence §2.4](https://news.bbc.co.uk/sport2/hi/help/rss/4517815.stm)
forbids summaries, and the available licence is old; current eligible AI use could not be established.
[NPR's current Content Feeds and Use of Content terms](https://www.npr.org/about-npr/179876898/terms-of-use)
permit limited personal-app display but bar altering content/derivatives and using it to build or train AI
systems, so its use for Tonarin's AI summaries is not confidently licensed. These publishers are not
built-ins, and directly adding their RSS/hosts does not bypass those restrictions. Bloomberg RSS/terms,
an official Nikkei RSS, and a compatible NHK/Asahi AI-use basis were not independently verified; none
was added. The Government Public Relations portal's RSS and terms pages returned 403 when checked,
so they were likewise not bundled.

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
