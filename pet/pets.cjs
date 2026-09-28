/**
 * Codex / ChatGPT pets (~/.codex/pets/<folder>/pet.json + spritesheet.webp|png).
 * Pets are read in place and never copied into the app. Only sheets found by a scan can be served to the pages.
 * Adding a pet (zip from codex-pets.net or a bare spritesheet) copies ONLY pet.json and the sheet; nothing is executed.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const SAFE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_SHEET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(webp|png)$/i;
const MAX_SHEET_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 120 * 1024 * 1024;

function isRegularFile(file) {
  try {
    return fs.lstatSync(file).isFile(); // lstat: a symlink inside a zip is not followed
  } catch {
    return false;
  }
}

function readManifest(file) {
  try {
    if (!isRegularFile(file) || fs.statSync(file).size > 64 * 1024) return {};
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
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

/** Finds the folder that holds pet.json (or a spritesheet) inside an extracted zip, up to 3 levels deep. */
function findPetDir(root, depth = 0) {
  if (isRegularFile(path.join(root, "pet.json"))) return root;
  if (["spritesheet.webp", "spritesheet.png"].some((name) => isRegularFile(path.join(root, name)))) return root;
  if (depth >= 3) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith("__MACOSX")) {
      const found = findPetDir(path.join(root, entry.name), depth + 1);
      if (found) return found;
    }
  }
  return undefined;
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pet-install-"));
    try {
      let meta = {};
      let sheetPath;
      if (lower.endsWith(".zip")) {
        if (stat.size > MAX_ZIP_BYTES) throw new Error(t("errTooLarge"));
        const { stdout } = await execFileAsync("/usr/bin/unzip", ["-l", file], { maxBuffer: 4 * 1024 * 1024 });
        const total = Number(/^\s*(\d+)\s+\d+\s+files?\s*$/m.exec(stdout.trim().split("\n").pop() ?? "")?.[1]);
        if (!Number.isFinite(total) || total > MAX_UNZIPPED_BYTES) throw new Error(t("errZipTooLarge"));
        await execFileAsync("/usr/bin/unzip", ["-qq", "-o", file, "-d", tmp]); // unzip skips "../" paths
        const petDir = findPetDir(tmp);
        if (!petDir) throw new Error(t("errNoPet"));
        meta = readManifest(path.join(petDir, "pet.json"));
        const sheetName = [meta.spritesheetPath, "spritesheet.webp", "spritesheet.png"].find(
          (name) => typeof name === "string" && SAFE_SHEET.test(name) && isRegularFile(path.join(petDir, name)),
        );
        if (!sheetName) throw new Error(t("errNoSheet"));
        sheetPath = path.join(petDir, sheetName);
      } else if (/\.(webp|png)$/.test(lower)) {
        sheetPath = file;
      } else {
        throw new Error(t("errWrongType"));
      }
      if (fs.statSync(sheetPath).size > MAX_SHEET_BYTES) throw new Error(t("errSheetTooLarge"));

      const id = SAFE_FOLDER.test(String(meta.id ?? "")) ? meta.id : safeId(baseName);
      const sheetName = `spritesheet${path.extname(sheetPath).toLowerCase()}`;
      const displayName =
        typeof meta.displayName === "string" && meta.displayName.trim() ? meta.displayName.trim().slice(0, 40) : baseName.slice(0, 40);
      const target = path.join(dir, id);
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(sheetPath, path.join(target, sheetName));
      const manifest = { ...meta, id, displayName, spritesheetPath: sheetName };
      fs.writeFileSync(path.join(target, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      return { id: `codex:${id}`, name: displayName };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return { dir, scan, sheetFile, install };
}

module.exports = { createPets };
