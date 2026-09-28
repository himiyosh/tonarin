/**
 * A small read-only zip reader for pet downloads (codex-pets.net zips). It lists the entries from the central
 * directory and inflates single files in memory, so adding a pet needs no unzip tool (Windows has none) and nothing
 * from an archive is ever written to disk under its own name.
 *
 * Only what pet zips use is supported: stored and deflated entries, no encryption, no ZIP64. Sizes and CRCs are
 * checked, and inflating stops at the size the archive declares.
 */
const zlib = require("node:zlib");

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MADE_BY_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY = 0x10;

class ZipError extends Error {}

function endOfCentralDirectory(buffer) {
  // 22 bytes, followed by a comment of up to 65535 bytes.
  const last = buffer.length - 22;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) return at;
  }
  throw new ZipError("not a zip file");
}

/**
 * Entries of the archive in central-directory order. Names use "/" (a few Windows tools write "\").
 * @returns {{ name: string, size: number, compressedSize: number, method: number, crc: number, encrypted: boolean,
 *   directory: boolean, symlink: boolean, localOffset: number }[]}
 */
function readEntries(buffer) {
  const end = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  if (offset + size > end) throw new ZipError("broken central directory");
  const entries = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError("broken central directory");
    const madeBy = buffer.readUInt16LE(at + 4) >> 8;
    const flags = buffer.readUInt16LE(at + 8);
    const nameLength = buffer.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    if (next > end) throw new ZipError("broken central directory");
    const external = buffer.readUInt32LE(at + 38);
    const mode = madeBy === MADE_BY_UNIX ? (external >>> 16) & S_IFMT : 0;
    const name = buffer.toString(flags & 0x800 ? "utf8" : "latin1", at + 46, at + 46 + nameLength).replaceAll("\\", "/");
    entries.push({
      name,
      method: buffer.readUInt16LE(at + 10),
      crc: buffer.readUInt32LE(at + 16),
      compressedSize: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      localOffset: buffer.readUInt32LE(at + 42),
      encrypted: (flags & 0x1) !== 0,
      directory: name.endsWith("/") || mode === S_IFDIR || (external & DOS_DIRECTORY) !== 0,
      symlink: mode === S_IFLNK,
    });
    at = next;
  }
  return entries;
}

/** The contents of one entry, at most `maxBytes` long. */
function extract(buffer, entry, maxBytes) {
  if (entry.encrypted) throw new ZipError("encrypted entries are not supported");
  if (entry.directory || entry.symlink) throw new ZipError("not a regular file");
  if (entry.size > maxBytes) throw new ZipError("entry too large");
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new ZipError("broken local header");
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (raw.length !== entry.compressedSize) throw new ZipError("truncated entry");
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipError("corrupt entry");
    }
  } else throw new ZipError(`compression method ${entry.method} is not supported`);
  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc) throw new ZipError("corrupt entry");
  return data;
}

module.exports = { ZipError, readEntries, extract };
