/**
 * Codex / ChatGPT pets (~/.codex/pets/<folder>/pet.json + spritesheet.webp|png).
 * Pets are read in place and never copied into the app. Only sheets found by a scan can be served to the pages.
 * Adding a pet (zip from codex-pets.net or a bare spritesheet) copies ONLY pet.json and the sheet; nothing is executed.
 * Zips are read in memory (zip.cjs): only those two files are inflated, and nothing else in the archive touches the disk.
 */
const fs = require("node:fs");
const path = require("node:path");
const zip = require("./zip.cjs");

const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SHEET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(webp|png)$/i;
const MAX_SHEET_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 120 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const PET_FILES = new Set(["pet.json", "spritesheet.webp", "spritesheet.png"]);

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile(); // lstat: a symlinked pet.json is not followed
  } catch {
    return false;
  }
}

function parseManifest(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function readManifest(file) {
  try {
    if (!isRegularFile(file) || fs.statSync(file).size > MAX_MANIFEST_BYTES) return {};
    return parseManifest(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function safeId(raw) {
  const id = String(raw ?? "")
    .replace(/\.codex-pet$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return SAFE_FOLDER.test(id) ? id : `pet-${Date.now()}`;
}

/**
 * The folder inside a zip that holds pet.json (or a spritesheet), up to 3 levels deep: "" for the top, else "a/b/".
 * The shallowest one wins; macOS "__MACOSX" metadata folders and odd paths are skipped.
 */
function findPetDir(entries) {
  let best;
  for (const entry of entries) {
    if (entry.directory || entry.symlink) continue;
    const parts = entry.name.split("/");
    const base = parts.pop().toLowerCase();
    if (!PET_FILES.has(base) || parts.length > 3) continue;
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("__MACOSX"))) continue;
    if (!best || parts.length < best.depth) best = { dir: parts.map((part) => `${part}/`).join(""), depth: parts.length };
  }
  return best?.dir;
}

/** Reads pet.json and the spritesheet out of a zip download. */
function readPetZip(file, t) {
  const buffer = fs.readFileSync(file);
  let entries;
  try {
    entries = zip.readEntries(buffer);
  } catch {
    throw new Error(t("errZipTooLarge"));
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_UNZIPPED_BYTES) throw new Error(t("errZipTooLarge"));
  const dir = findPetDir(entries);
  if (dir === undefined) throw new Error(t("errNoPet"));
  const fileIn = (name) => {
    const wanted = `${dir}${name}`.toLowerCase();
    return entries.find((entry) => !entry.directory && !entry.symlink && entry.name.toLowerCase() === wanted);
  };
  const read = (entry, max) => {
    try {
      return zip.extract(buffer, entry, max);
    } catch {
      throw new Error(t("errZipTooLarge"));
    }
  };
  const manifest = fileIn("pet.json");
  const meta = manifest && manifest.size <= MAX_MANIFEST_BYTES ? parseManifest(read(manifest, MAX_MANIFEST_BYTES).toString("utf8")) : {};
  const sheetName = [meta.spritesheetPath, "spritesheet.webp", "spritesheet.png"].find(
    (name) => typeof name === "string" && SAFE_SHEET.test(name) && fileIn(name),
  );
  if (!sheetName) throw new Error(t("errNoSheet"));
  const sheet = fileIn(sheetName);
  if (sheet.size > MAX_SHEET_BYTES) throw new Error(t("errSheetTooLarge"));
  return { meta, sheet: read(sheet, MAX_SHEET_BYTES), extension: path.extname(sheetName).toLowerCase() };
}

function createPets(dir) {
  const servable = new Set();

  function scan() {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const pets = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_FOLDER.test(entry.name)) continue;
      const folder = path.join(dir, entry.name);
      const meta = readManifest(path.join(folder, "pet.json"));
      const sheet = [meta.spritesheetPath, "spritesheet.webp", "spritesheet.png"]
        .filter((name) => typeof name === "string" && SAFE_SHEET.test(name))
        .find((name) => {
          try {
            const stat = fs.statSync(path.join(folder, name));
            return stat.isFile() && stat.size <= MAX_SHEET_BYTES;
          } catch {
            return false;
          }
        });
      if (!sheet) continue;
      servable.add(`${entry.name}/${sheet}`);
      const name = typeof meta.displayName === "string" && meta.displayName.trim() ? meta.displayName.trim().slice(0, 40) : entry.name;
      pets.push({ id: `codex:${entry.name}`, name, url: `pet://app/codex-pets/${entry.name}/${sheet}` });
    }
    return pets.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
  }

  /** Path of a sheet the pages may load, or undefined. */
  function sheetFile(folder, file) {
    return servable.has(`${folder}/${file}`) ? path.join(dir, folder, file) : undefined;
  }

  /** Installs a zip or a bare spritesheet. `t` localizes error messages. */
  async function install(file, t) {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(t("errNotFile"));
    const lower = file.toLowerCase();
    const baseName = path.basename(file).replace(/\.(zip|webp|png)$/i, "");
    let meta = {};
    let sheet; // the image bytes
    let extension;
    if (lower.endsWith(".zip")) {
      if (stat.size > MAX_ZIP_BYTES) throw new Error(t("errTooLarge"));
      ({ meta, sheet, extension } = readPetZip(file, t));
    } else if (/\.(webp|png)$/.test(lower)) {
      if (stat.size > MAX_SHEET_BYTES) throw new Error(t("errSheetTooLarge"));
      sheet = fs.readFileSync(file);
      extension = path.extname(lower);
    } else {
      throw new Error(t("errWrongType"));
    }

    const id = SAFE_FOLDER.test(String(meta.id ?? "")) ? meta.id : safeId(baseName);
    const sheetName = `spritesheet${extension}`;
    const displayName =
      typeof meta.displayName === "string" && meta.displayName.trim() ? meta.displayName.trim().slice(0, 40) : baseName.slice(0, 40);
    const target = path.join(dir, id);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, sheetName), sheet);
    const manifest = { ...meta, id, displayName, spritesheetPath: sheetName };
    fs.writeFileSync(path.join(target, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { id: `codex:${id}`, name: displayName };
  }

  return { dir, scan, sheetFile, install };
}

module.exports = { createPets };
