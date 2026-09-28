// The in-memory zip reader used to add Codex / ChatGPT pets (pet/zip.cjs).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ZipError, extract, readEntries } = require("../pet/zip.cjs");
const { makeZip } = require("./make-zip.cjs");

test("lists entries and reads stored and deflated files", () => {
  const sheet = Buffer.alloc(5000, 7);
  const buffer = makeZip([
    { name: "pet/", data: "", method: 0 },
    { name: "pet/pet.json", data: '{"displayName":"Momo"}', method: 0 },
    { name: "pet/spritesheet.webp", data: sheet, method: 8 },
  ]);
  const entries = readEntries(buffer);
  assert.deepEqual(
    entries.map((e) => [e.name, e.size, e.directory]),
    [
      ["pet/", 0, true],
      ["pet/pet.json", 22, false],
      ["pet/spritesheet.webp", 5000, false],
    ],
  );
  assert.equal(extract(buffer, entries[1], 100).toString("utf8"), '{"displayName":"Momo"}');
  assert.ok(extract(buffer, entries[2], 10_000).equals(sheet));
  assert.ok(entries[2].compressedSize < 5000, "the sheet was deflated");
});

test("names written with backslashes (some Windows tools) use slashes", () => {
  const [entry] = readEntries(makeZip([{ name: "folder\\pet.json", data: "{}" }]));
  assert.equal(entry.name, "folder/pet.json");
});

test("symlinks and directories are flagged from the Unix and DOS attributes", () => {
  const entries = readEntries(
    makeZip([
      { name: "link.png", data: "/etc/passwd", method: 0, madeBy: 3, external: (0o120777 << 16) >>> 0 },
      { name: "dir", data: "", method: 0, external: 0x10 },
      { name: "file.png", data: "x", method: 0, madeBy: 3, external: (0o100644 << 16) >>> 0 },
    ]),
  );
  assert.deepEqual(
    entries.map((e) => [e.symlink, e.directory]),
    [
      [true, false],
      [false, true],
      [false, false],
    ],
  );
  assert.throws(() => extract(Buffer.alloc(0), entries[0], 100), ZipError);
});

test("refuses entries larger than allowed before inflating them", () => {
  const buffer = makeZip([{ name: "big.png", data: Buffer.alloc(2048) }]);
  const [entry] = readEntries(buffer);
  assert.throws(() => extract(buffer, entry, 1024), /too large/);
});

test("a declared size smaller than the real data is caught (no zip bombs)", () => {
  const buffer = makeZip([{ name: "bomb.png", data: Buffer.alloc(100_000), size: 10 }]);
  const [entry] = readEntries(buffer);
  assert.throws(() => extract(buffer, entry, 1_000_000), /corrupt/);
});

test("a wrong CRC is caught", () => {
  const buffer = makeZip([{ name: "pet.json", data: "{}", method: 0, crc: 1234 }]);
  assert.throws(() => extract(buffer, readEntries(buffer)[0], 100), /corrupt/);
});

test("encrypted entries and other compression methods are refused", () => {
  const encrypted = makeZip([{ name: "a.png", data: "x", method: 0, flags: 0x1 }]);
  assert.throws(() => extract(encrypted, readEntries(encrypted)[0], 100), /encrypted/);
  const bzip = makeZip([{ name: "a.png", data: "x", method: 0 }]);
  bzip.writeUInt16LE(12, 8); // local header method
  const [entry] = readEntries(bzip);
  assert.throws(() => extract(bzip, { ...entry, method: 12 }, 100), /method 12/);
});

test("something that is not a zip is refused", () => {
  assert.throws(() => readEntries(Buffer.from("definitely not a zip file, just some text")), /not a zip/);
  assert.throws(() => readEntries(Buffer.alloc(0)), /not a zip/);
  const truncated = makeZip([{ name: "pet.json", data: "{}" }]);
  truncated.writeUInt32LE(9999, truncated.length - 6); // central directory offset beyond the data
  assert.throws(() => readEntries(truncated), /broken central directory/);
});
