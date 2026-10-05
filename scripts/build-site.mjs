/**
 * Builds the download site into _site/: npm run site
 *
 * site/ holds the page. This adds the characters (pet/ui/characters/*.svg) and releases.json: every published
 * release, newest first, with its downloads (file, size, SHA-256) and its notes in English and Japanese. The notes
 * come from docs/releases/<tag>.md and <tag>.ja.md, rendered by GitHub's Markdown API (the release body is the
 * fallback when a release has no notes file). The page reads only these files and requests nothing from other sites;
 * the download links point at GitHub Releases.
 *
 *   npm run site                                releases from the GitHub API (set GITHUB_TOKEN to raise the rate limit)
 *   npm run site -- --fixture <releases.json>   releases from a saved API response, to try the page without a release
 *   npm run site -- --serve                     then serve _site on http://127.0.0.1:4173
 *
 * .github/workflows/pages.yml runs it and publishes _site to GitHub Pages.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareArtifacts, parseArtifact } from "./lib/artifacts.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(ROOT, "_site");
const API = "https://api.github.com";

/** The page's view of one release from GET /repos/{owner}/{repo}/releases. `notes` holds rendered HTML per language. */
export function siteRelease(release, notes = {}) {
  const assets = release.assets ?? [];
  const downloads = assets
    .map((asset) => {
      const artifact = parseArtifact(asset.name);
      if (!artifact) return undefined;
      const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "")?.[1] ?? null;
      return { ...artifact, size: asset.size, url: asset.browser_download_url, sha256 };
    })
    .filter(Boolean)
    .sort(compareArtifacts);
  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^v/, ""),
    date: release.published_at,
    prerelease: Boolean(release.prerelease),
    url: release.html_url,
    notes: { en: notes.en || release.body_html || "", ja: notes.ja || null },
    downloads,
    checksums: assets.find((asset) => asset.name === "SHA256SUMS.txt")?.browser_download_url ?? null,
  };
}

/** Published releases, newest first. `latest` follows GitHub: the newest release that is not a pre-release. */
export function siteData(releases, notesByTag = {}, repo = "himiyosh/tonarin") {
  const list = releases
    .filter((release) => !release.draft && release.published_at)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .map((release) => siteRelease(release, notesByTag[release.tag_name]));
  const latest = list.find((release) => !release.prerelease) ?? list[0];
  return { repo, releasesUrl: `https://github.com/${repo}/releases`, latest: latest?.tag ?? null, releases: list };
}

async function github(path, { method = "GET", accept = "application/vnd.github+json", body } = {}) {
  const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tonarin-site" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response;
}

/** Notes files rendered to HTML ({ en, ja }); a language without a file, or a failed render, is left out. */
async function renderNotes(tag, repo) {
  const notes = {};
  for (const [language, file] of [["en", `${tag}.md`], ["ja", `${tag}.ja.md`]]) {
    const path = join(ROOT, "docs", "releases", file);
    if (!existsSync(path)) continue;
    try {
      const response = await github("/markdown", { method: "POST", accept: "text/html", body: { text: readFileSync(path, "utf8"), mode: "gfm", context: repo } });
      notes[language] = await response.text();
    } catch (error) {
      console.warn(`could not render docs/releases/${file} (${error.message}); using the release body`);
    }
  }
  return notes;
}

async function build({ fixture, repo }) {
  let releases;
  if (fixture) {
    const saved = JSON.parse(readFileSync(fixture, "utf8"));
    releases = Array.isArray(saved) ? saved : saved.releases;
  } else {
    // The HTML media type adds body_html, GitHub's own rendering of each release body.
    releases = await (await github(`/repos/${repo}/releases?per_page=50`, { accept: "application/vnd.github.html+json" })).json();
  }
  const notesByTag = {};
  for (const release of releases.filter((r) => !r.draft)) notesByTag[release.tag_name] = await renderNotes(release.tag_name, repo);
  // `upcoming` is the version on main: the page names it while no release is out yet.
  const upcoming = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const data = { ...siteData(releases, notesByTag, repo), upcoming, generatedAt: new Date().toISOString() };

  rmSync(OUT, { recursive: true, force: true });
  cpSync(join(ROOT, "site"), OUT, { recursive: true });
  cpSync(join(ROOT, "pet", "ui", "characters"), join(OUT, "characters"), { recursive: true });
  writeFileSync(join(OUT, "releases.json"), `${JSON.stringify(data, null, 2)}\n`);
  const files = data.releases.reduce((sum, release) => sum + release.downloads.length, 0);
  console.log(`_site/ written: ${data.releases.length} releases, ${files} downloads, latest ${data.latest ?? "none yet"}`);
}

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function serve(port = 4173) {
  createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = normalize(join(OUT, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    if (!file.startsWith(OUT + sep) || !existsSync(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": `${TYPES[extname(file)] ?? "application/octet-stream"}; charset=utf-8` }).end(readFileSync(file));
  }).listen(port, "127.0.0.1", () => console.log(`serving _site on http://127.0.0.1:${port}/`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { fixture: { type: "string" }, serve: { type: "boolean" }, repo: { type: "string" } } });
  mkdirSync(OUT, { recursive: true });
  try {
    await build({ fixture: values.fixture, repo: values.repo || process.env.GITHUB_REPOSITORY || "himiyosh/tonarin" });
  } catch (error) {
    console.error(`could not build the site: ${error.message}`);
    process.exit(1);
  }
  if (values.serve) serve();
}
