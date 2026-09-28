/**
 * Writes the body of a GitHub release to stdout: node scripts/release-notes.mjs v0.2.0 [options] > notes.md
 *
 *   --previous <tag>     the release before, for the "Full Changelog" link (leave out for the first release)
 *   --assets <dir>       the folder with the files being released, for the download list
 *   --generated <file>   GitHub's generated notes (POST /repos/{repo}/releases/generate-notes), for "New Contributors"
 *   --repo <owner/name>  default: $GITHUB_REPOSITORY, else himiyosh/tonarin
 *
 * The notes are written by hand, in docs/releases/<tag>.md (English) and <tag>.ja.md (Japanese); see
 * docs/releases/README.md. This adds what every release has in the same place: the Japanese notes folded in, the
 * downloads, new contributors and the Full Changelog link. .github/workflows/release.yml runs it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareArtifacts, parseArtifact, platformLabel } from "./lib/artifacts.mjs";

export const SITE_URL = "https://himiyosh.github.io/tonarin/";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The "## New Contributors" section of GitHub's generated notes, or "" when there is none. */
export function newContributors(generated) {
  const match = /^## New Contributors[ \t]*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n\*\*Full Changelog\*\*|$(?![\s\S]))/m.exec(generated ?? "");
  const lines = match?.[1].trim();
  return lines ? `## New Contributors\n\n${lines}` : "";
}

function downloadsSection({ tag, repo, files, site }) {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const link = (file) => `[${file}](${base}/${encodeURIComponent(file)})`;
  const rows = new Map(); // one row per platform: "macOS (Apple Silicon)" -> links
  for (const artifact of files.map(parseArtifact).filter(Boolean).sort(compareArtifacts)) {
    const label = `${platformLabel(artifact)}${artifact.preview ? ", preview" : ""}`;
    rows.set(label, [...(rows.get(label) ?? []), link(artifact.file)]);
  }
  if (!rows.size) return "";
  const table = [...rows].map(([label, links]) => `| ${label} | ${links.join(" · ")} |`).join("\n");
  const checksums = files.includes("SHA256SUMS.txt") ? ` SHA-256 checksums: ${link("SHA256SUMS.txt")}.` : "";
  return [
    "### Downloads",
    `| Platform | Files |\n|---|---|\n${table}`,
    `The [download page](${site}) picks the right file for your computer and walks you through the first launch: the ` +
      `builds are not signed yet, so macOS and Windows ask once before opening them.${checksums}`,
  ].join("\n\n");
}

/** The whole release body. `notes` and `notesJa` are the hand-written Markdown files. */
export function assembleNotes({ tag, previous, repo, notes, notesJa, files = [], generated, site = SITE_URL }) {
  if (!notes?.trim()) throw new Error(`no release notes for ${tag}`);
  const parts = [notes.trim()];
  if (notesJa?.trim()) parts.push(`<details>\n<summary>日本語のリリースノート</summary>\n\n${notesJa.trim()}\n\n</details>`);
  const downloads = downloadsSection({ tag, repo, files, site });
  if (downloads) parts.push(downloads);
  const contributors = newContributors(generated);
  if (contributors) parts.push(contributors);
  const changes = previous ? `https://github.com/${repo}/compare/${previous}...${tag}` : `https://github.com/${repo}/commits/${tag}`;
  parts.push(`**Full Changelog**: ${changes}`);
  return `${parts.join("\n\n")}\n`;
}

/** docs/releases/<tag>.md and <tag>.ja.md ("" when missing). */
export function readNotes(tag, dir = join(ROOT, "docs", "releases")) {
  const read = (file) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");
  return { notes: read(`${tag}.md`), notesJa: read(`${tag}.ja.md`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { previous: { type: "string" }, assets: { type: "string" }, generated: { type: "string" }, repo: { type: "string" } },
  });
  const tag = positionals[0];
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag ?? "")) {
    console.error("usage: node scripts/release-notes.mjs vX.Y.Z [--previous vX.Y.Z] [--assets dir] [--generated file]");
    process.exit(1);
  }
  const { notes, notesJa } = readNotes(tag);
  if (!notes.trim()) {
    console.error(`docs/releases/${tag}.md is missing: every release needs its notes (see docs/releases/README.md)`);
    process.exit(1);
  }
  process.stdout.write(
    assembleNotes({
      tag,
      previous: values.previous || undefined,
      repo: values.repo || process.env.GITHUB_REPOSITORY || "himiyosh/tonarin",
      notes,
      notesJa,
      files: values.assets ? readdirSync(values.assets) : [],
      generated: values.generated ? readFileSync(values.generated, "utf8") : "",
    }),
  );
}
