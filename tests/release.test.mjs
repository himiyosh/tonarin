// Release files, release notes and the download site's data (scripts/lib/artifacts.mjs, scripts/release-notes.mjs,
// scripts/build-site.mjs), without the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compareArtifacts, parseArtifact } from "../scripts/lib/artifacts.mjs";
import { siteData } from "../scripts/build-site.mjs";
import { assembleNotes, newContributors } from "../scripts/release-notes.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/releases.json", import.meta.url), "utf8")).releases;

test("release file names say version, OS, architecture and kind", () => {
  assert.deepEqual(parseArtifact("Tonarin-0.2.0-mac-arm64.dmg"), {
    file: "Tonarin-0.2.0-mac-arm64.dmg",
    version: "0.2.0",
    os: "mac",
    arch: "arm64",
    kind: "dmg",
    preview: false,
  });
  assert.equal(parseArtifact("Tonarin-0.2.0-beta.1-win-arm64-setup.exe")?.version, "0.2.0-beta.1");
  assert.equal(parseArtifact("Tonarin-0.2.0-win-x64-setup.exe")?.preview, true);
  for (const other of ["SHA256SUMS.txt", "Tonarin-0.2.0-mac-arm64.dmg.blockmap", "Tonarin-0.2.0-win-x64.exe", "Tonarin-0.2.0-mac-arm64-setup.exe", "latest.yml"]) {
    assert.equal(parseArtifact(other), undefined, other);
  }
  const order = ["Tonarin-1.0.0-win-arm64-setup.exe", "Tonarin-1.0.0-mac-arm64.zip", "Tonarin-1.0.0-win-x64-setup.exe", "Tonarin-1.0.0-mac-arm64.dmg"]
    .map(parseArtifact)
    .sort(compareArtifacts)
    .map((a) => a.file);
  assert.deepEqual(order, ["Tonarin-1.0.0-mac-arm64.dmg", "Tonarin-1.0.0-mac-arm64.zip", "Tonarin-1.0.0-win-x64-setup.exe", "Tonarin-1.0.0-win-arm64-setup.exe"]);
});

test("release notes: hand-written notes, Japanese folded in, downloads, contributors and the changelog link", () => {
  const body = assembleNotes({
    tag: "v0.3.0",
    previous: "v0.2.0",
    repo: "himiyosh/tonarin",
    notes: "## v0.3.0 Highlights\n\nSomething new.\n",
    notesJa: "## v0.3.0 のハイライト\n\n新しいこと。\n",
    files: ["Tonarin-0.3.0-win-x64-setup.exe", "Tonarin-0.3.0-mac-arm64.dmg", "Tonarin-0.3.0-mac-arm64.zip", "SHA256SUMS.txt", "x.blockmap"],
    generated: "## What's Changed\n* feat: x by @a in #5\n\n## New Contributors\n* @a made their first contribution in #5\n\n**Full Changelog**: https://github.com/himiyosh/tonarin/compare/v0.2.0...v0.3.0",
  });
  const sections = ["## v0.3.0 Highlights", "<details>\n<summary>日本語のリリースノート</summary>", "### Downloads", "## New Contributors", "**Full Changelog**"];
  const positions = sections.map((section) => body.indexOf(section));
  assert.ok(positions.every((at) => at >= 0), `missing a section:\n${body}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections in order");
  assert.match(
    body,
    /\| macOS \(Apple Silicon\) \| \[Tonarin-0\.3\.0-mac-arm64\.dmg\]\(https:\/\/github\.com\/himiyosh\/tonarin\/releases\/download\/v0\.3\.0\/Tonarin-0\.3\.0-mac-arm64\.dmg\) · \[Tonarin-0\.3\.0-mac-arm64\.zip\]/,
  );
  assert.match(body, /\| Windows 10 \/ 11 \(x64\), preview \| \[Tonarin-0\.3\.0-win-x64-setup\.exe\]/);
  assert.match(body, /SHA-256 checksums: \[SHA256SUMS\.txt\]/);
  assert.match(body, /\*\*Full Changelog\*\*: https:\/\/github\.com\/himiyosh\/tonarin\/compare\/v0\.2\.0\.\.\.v0\.3\.0\n$/);
  assert.doesNotMatch(body, /What's Changed/, "only New Contributors is taken from the generated notes");
  assert.doesNotMatch(body, /blockmap/);
});

test("the first release links its commits, and missing parts are left out", () => {
  const body = assembleNotes({ tag: "v0.2.0", repo: "himiyosh/tonarin", notes: "## v0.2.0 Highlights\n\nHello." });
  assert.equal(body, "## v0.2.0 Highlights\n\nHello.\n\n**Full Changelog**: https://github.com/himiyosh/tonarin/commits/v0.2.0\n");
  assert.throws(() => assembleNotes({ tag: "v0.2.0", repo: "himiyosh/tonarin", notes: "  " }), /no release notes/);
  assert.equal(newContributors("## What's Changed\n* x\n\n**Full Changelog**: y"), "");
  assert.equal(newContributors("## New Contributors\n* @b made their first contribution in #9"), "## New Contributors\n\n* @b made their first contribution in #9");
});

test("the notes files for v0.2.0 exist in both languages, one line per paragraph", () => {
  for (const file of ["v0.2.0.md", "v0.2.0.ja.md"]) {
    const text = readFileSync(new URL(`../docs/releases/${file}`, import.meta.url), "utf8");
    assert.match(text, /^## v0\.2\.0 /, file);
    // GitHub keeps line breaks in release notes: a paragraph wrapped over two lines would break mid-sentence.
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const previous = lines[i - 1] ?? "";
      const continues = line.trim() && previous.trim() && !/^(#|- |\d+\. |```|\|)/.test(line.trim()) && !previous.startsWith("#");
      assert.ok(!continues, `${file}:${i + 1} continues the line before it`);
    });
  }
});

test("site data: published releases newest first, drafts left out, latest is not a pre-release", () => {
  const data = siteData(fixture, { "v0.2.0": { en: "<p>en</p>", ja: "<p>ja</p>" } });
  assert.deepEqual(
    data.releases.map((r) => r.tag),
    ["v0.2.0", "v0.2.0-beta.1"],
  );
  assert.equal(data.latest, "v0.2.0");
  const [latest, beta] = data.releases;
  assert.deepEqual(
    latest.downloads.map((d) => [d.file, d.os, d.arch, d.kind]),
    [
      ["Tonarin-0.2.0-mac-arm64.dmg", "mac", "arm64", "dmg"],
      ["Tonarin-0.2.0-mac-arm64.zip", "mac", "arm64", "zip"],
      ["Tonarin-0.2.0-win-x64-setup.exe", "win", "x64", "installer"],
      ["Tonarin-0.2.0-win-arm64-setup.exe", "win", "arm64", "installer"],
    ],
  );
  assert.equal(latest.downloads[0].sha256, "c1e5c13964ee7845e026de63fa9752d03fd611082ed958c394240d48809ec697");
  assert.ok(latest.downloads.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)), "every file has its checksum");
  assert.equal(latest.checksums, "https://github.com/himiyosh/tonarin/releases/download/v0.2.0/SHA256SUMS.txt");
  assert.deepEqual(latest.notes, { en: "<p>en</p>", ja: "<p>ja</p>" });
  assert.equal(beta.prerelease, true);
  assert.equal(beta.downloads[0].sha256, null, "an asset without a digest has no checksum");
  assert.deepEqual(beta.notes, { en: fixture[2].body_html, ja: null }, "no notes file: GitHub's rendering of the body");
});

test("site data: only pre-releases means the newest one is offered", () => {
  const data = siteData([fixture[2]]);
  assert.equal(data.latest, "v0.2.0-beta.1");
  assert.deepEqual(siteData([]), { repo: "himiyosh/tonarin", releasesUrl: "https://github.com/himiyosh/tonarin/releases", latest: null, releases: [] });
});
