/**
 * Release files are named <product>-<version>-<os>-<arch>[-setup].<ext> (artifactName in electron-builder.config.cjs),
 * for example Tonarin-0.2.0-mac-arm64.dmg or Tonarin-0.2.0-win-x64-setup.exe. The release notes and the download site
 * tell platforms apart by that name.
 */
const PATTERN =
  /^(?<product>.+?)-(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?<os>mac|win)-(?<arch>arm64|x64)(?<setup>-setup)?\.(?<ext>dmg|zip|exe)$/;

/** Platforms whose builds are still a preview (2026-09-28: Windows, tested in CI but not yet on many PCs). */
export const PREVIEW_PLATFORMS = new Set(["win"]);

/** { file, version, os: "mac" | "win", arch: "arm64" | "x64", kind: "dmg" | "zip" | "installer", preview } or undefined. */
export function parseArtifact(file) {
  const match = PATTERN.exec(file);
  if (!match) return undefined;
  const { version, os, arch, setup, ext } = match.groups;
  if ((ext === "exe") !== Boolean(setup) || (ext === "exe") !== (os === "win")) return undefined;
  return { file, version, os, arch, kind: ext === "exe" ? "installer" : ext, preview: PREVIEW_PLATFORMS.has(os) };
}

const RANK = { "mac-dmg": 0, "mac-zip": 1, "win-installer": 2 };

/** macOS before Windows, the disk image before the zip, x64 before ARM64. */
export function compareArtifacts(a, b) {
  return RANK[`${a.os}-${a.kind}`] - RANK[`${b.os}-${b.kind}`] || (a.arch === b.arch ? 0 : a.arch === "x64" ? -1 : 1);
}

/** "macOS (Apple Silicon)", "Windows 10 / 11 (x64)". */
export function platformLabel({ os, arch }) {
  if (os === "mac") return arch === "arm64" ? "macOS (Apple Silicon)" : "macOS (Intel)";
  return `Windows 10 / 11 (${arch === "arm64" ? "ARM64" : "x64"})`;
}
