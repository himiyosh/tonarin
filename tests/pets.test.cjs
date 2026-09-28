// Adding Codex / ChatGPT pets from a zip or a bare spritesheet (pet/pets.cjs), in a temporary pets folder.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createPets } = require("../pet/pets.cjs");
const { makeZip } = require("./make-zip.cjs");

const t = (key) => key; // error messages come back as their keys
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tonarin-pets-"));
  const petsDir = path.join(root, "pets");
  const write = (name, data) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, data);
    return file;
  };
  return { pets: createPets(petsDir), petsDir, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("installs pet.json and the sheet from a codex-pets.net style zip, and nothing else", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  const zip = box.write(
    "momo.zip",
    makeZip([
      { name: "__MACOSX/momo.codex-pet/._pet.json", data: "junk" },
      { name: "momo.codex-pet/", data: "", method: 0 },
      { name: "momo.codex-pet/pet.json", data: JSON.stringify({ id: "momo", displayName: "Momo", spritesheetPath: "sheet.webp" }) },
      { name: "momo.codex-pet/sheet.webp", data: Buffer.alloc(4096, 3) },
      { name: "momo.codex-pet/run.sh", data: "#!/bin/sh\necho hi" },
    ]),
  );
  assert.deepEqual(await box.pets.install(zip, t), { id: "codex:momo", name: "Momo" });
  assert.deepEqual(fs.readdirSync(path.join(box.petsDir, "momo")).sort(), ["pet.json", "spritesheet.webp"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(box.petsDir, "momo", "pet.json"), "utf8"));
  assert.equal(manifest.spritesheetPath, "spritesheet.webp");
  assert.ok(fs.readFileSync(path.join(box.petsDir, "momo", "spritesheet.webp")).equals(Buffer.alloc(4096, 3)));
  assert.deepEqual(box.pets.scan(), [{ id: "codex:momo", name: "Momo", url: "pet://app/codex-pets/momo/spritesheet.webp" }]);
});

test("a zip with only a spritesheet uses the file name for the pet", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  const zip = box.write("Tiny Cat.zip", makeZip([{ name: "spritesheet.png", data: PNG }]));
  assert.deepEqual(await box.pets.install(zip, t), { id: "codex:Tiny-Cat", name: "Tiny Cat" });
  assert.ok(fs.existsSync(path.join(box.petsDir, "Tiny-Cat", "spritesheet.png")));
});

test("the shallowest pet folder wins, deeper than 3 levels is ignored", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  const deep = box.write("deep.zip", makeZip([{ name: "a/b/c/d/spritesheet.png", data: PNG }]));
  await assert.rejects(box.pets.install(deep, t), /errNoPet/);
  const two = box.write(
    "two.zip",
    makeZip([
      { name: "x/y/spritesheet.png", data: Buffer.from("deeper") },
      { name: "x/spritesheet.png", data: PNG },
    ]),
  );
  await box.pets.install(two, t);
  assert.ok(fs.readFileSync(path.join(box.petsDir, "two", "spritesheet.png")).equals(PNG));
});

test("symlinks, traversal names and zip bombs are refused", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  const link = box.write("link.zip", makeZip([{ name: "spritesheet.png", data: "/etc/passwd", method: 0, madeBy: 3, external: (0o120777 << 16) >>> 0 }]));
  await assert.rejects(box.pets.install(link, t), /errNoPet/);
  const traversal = box.write("up.zip", makeZip([{ name: "../spritesheet.png", data: PNG }]));
  await assert.rejects(box.pets.install(traversal, t), /errNoPet/);
  const bomb = box.write("bomb.zip", makeZip([{ name: "spritesheet.png", data: PNG, size: 200 * 1024 * 1024 }]));
  await assert.rejects(box.pets.install(bomb, t), /errZipTooLarge/);
  const broken = box.write("broken.zip", "PK not really");
  await assert.rejects(box.pets.install(broken, t), /errZipTooLarge/);
  assert.equal(fs.existsSync(box.petsDir), false, "nothing was written");
});

test("a pet.json without a readable sheet, and other file types, are refused", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  const noSheet = box.write("nosheet.zip", makeZip([{ name: "pet.json", data: '{"spritesheetPath":"../../x.png"}' }]));
  await assert.rejects(box.pets.install(noSheet, t), /errNoSheet/);
  await assert.rejects(box.pets.install(box.write("pet.gif", "GIF89a"), t), /errWrongType/);
});

test("a bare spritesheet image is copied as is", async (context) => {
  const box = sandbox();
  context.after(box.cleanup);
  assert.deepEqual(await box.pets.install(box.write("Blob.PNG", PNG), t), { id: "codex:Blob", name: "Blob" });
  assert.ok(fs.readFileSync(path.join(box.petsDir, "Blob", "spritesheet.png")).equals(PNG));
});
