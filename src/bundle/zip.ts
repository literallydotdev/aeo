import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { bundlePathError } from './paths';

// ============================================================================
// The .aeo.zip container (specs/aeo-open-source-cli-spec.md §8.1, §8.2). The
// writer is deterministic (sorted entries, a fixed 1980 timestamp, no extra
// fields), so the same finalized revision always yields the same archive
// bytes. The reader never touches the filesystem: entries are read into
// memory under versioned limits, and anything outside the bundle path set,
// a symlink, a duplicate or an encrypted entry refuses the whole archive.
// ============================================================================

export const archiveLimits = {
  version: 1,
  maxEntries: 50_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
} as const;

export type ArchiveLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

/** Thrown when an archive or directory is refused before verification. */
export class BundleRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BundleRefusedError';
    this.code = code;
  }
}

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endSignature = 0x06054b50;
const methodStored = 0;
const methodDeflated = 8;
// 1980-01-01 00:00, the earliest DOS date: no export-time field in the bytes.
const dosDate = (0 << 9) | (1 << 5) | 1;
const dosTime = 0;
const flagUtf8 = 0x0800;
const flagEncrypted = 0x0001;
const unixFileMode = 0o100644;
const unixTypeMask = 0o170000;
const unixRegularFile = 0o100000;
const unixDirectory = 0o040000;
const madeByUnix = (3 << 8) | 20;
const maxZip32 = 0xffffffff;

export type ArchiveEntry = { path: string; bytes: Buffer };

/** writeArchive packs bundle files into deterministic ZIP bytes. */
export const writeArchive = (entries: readonly ArchiveEntry[]): Buffer => {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : 1,
  );
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const checksum = crc32(entry.bytes);

    if (entry.bytes.length > maxZip32 || offset > maxZip32) {
      throw new Error(`Archive entry exceeds ZIP32 limits: ${entry.path}.`);
    }

    const local = Buffer.alloc(30);

    local.writeUInt32LE(localHeaderSignature, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flagUtf8, 6);
    local.writeUInt16LE(methodDeflated, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(centralHeaderSignature, 0);
    central.writeUInt16LE(madeByUnix, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flagUtf8, 8);
    central.writeUInt16LE(methodDeflated, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((unixFileMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  if (sorted.length > 0xffff) {
    throw new Error(`Archive has more than 65535 entries: ${sorted.length}.`);
  }

  end.writeUInt32LE(endSignature, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...locals, centralBytes, end]);

  return archive;
};

const refuse = (code: string, message: string): never => {
  throw new BundleRefusedError(code, message);
};

const findEnd = (archive: Buffer): number => {
  const earliest = Math.max(0, archive.length - 22 - 0xffff);

  for (let at = archive.length - 22; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === endSignature) {
      return at;
    }
  }

  return refuse('archive_malformed', 'No ZIP end-of-directory record found.');
};

/** readArchive reads bundle files from ZIP bytes under the given limits. */
export const readArchive = (
  archive: Buffer,
  limits: ArchiveLimits = archiveLimits,
): Map<string, Buffer> => {
  if (archive.length < 22) {
    refuse('archive_malformed', 'The archive is too short to be a ZIP file.');
  }

  const end = findEnd(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);

  if (entryCount > limits.maxEntries) {
    refuse(
      'archive_too_large',
      `The archive has ${entryCount} entries; the limit is ${limits.maxEntries}.`,
    );
  }

  if (centralOffset + centralSize > end) {
    refuse('archive_malformed', 'The central directory lies outside the file.');
  }

  const files = new Map<string, Buffer>();
  let cursor = centralOffset;
  let totalBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > end ||
      archive.readUInt32LE(cursor) !== centralHeaderSignature
    ) {
      refuse(
        'archive_malformed',
        `Central directory entry ${index} is invalid.`,
      );
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const unixMode = archive.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString(
      'utf8',
      cursor + 46,
      cursor + 46 + nameLength,
    );

    cursor += 46 + nameLength + extraLength + commentLength;

    const type = unixMode & unixTypeMask;

    if (name.endsWith('/') || type === unixDirectory) {
      continue;
    }

    if (type !== 0 && type !== unixRegularFile) {
      refuse('archive_entry_type', `Entry ${name} is not a regular file.`);
    }

    const pathError = bundlePathError(name);

    if (pathError) {
      refuse('archive_entry_path', `Entry ${name} is refused: ${pathError}.`);
    }

    if (files.has(name)) {
      refuse('archive_duplicate_entry', `Entry ${name} appears twice.`);
    }

    if ((flags & flagEncrypted) !== 0) {
      refuse('archive_encrypted', `Entry ${name} is encrypted.`);
    }

    if (method !== methodStored && method !== methodDeflated) {
      refuse('archive_method', `Entry ${name} uses compression ${method}.`);
    }

    totalBytes += size;

    if (size > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
      refuse('archive_too_large', `Entry ${name} exceeds the size limits.`);
    }

    if (
      localOffset + 30 > archive.length ||
      archive.readUInt32LE(localOffset) !== localHeaderSignature
    ) {
      refuse('archive_malformed', `Entry ${name} has no local header.`);
    }

    const dataStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);

    if (data.length !== compressedSize) {
      refuse('archive_malformed', `Entry ${name} is truncated.`);
    }

    let bytes: Buffer;

    try {
      bytes =
        method === methodStored
          ? Buffer.from(data)
          : inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
    } catch {
      // A zlib failure here is a malformed or oversized entry; the refusal
      // code is what a caller acts on, not zlib's wording.
      bytes = refuse(
        'archive_malformed',
        `Entry ${name} does not decompress to its declared size.`,
      );
    }

    if (bytes.length !== size || crc32(bytes) !== checksum) {
      refuse('archive_malformed', `Entry ${name} fails its size or CRC check.`);
    }

    files.set(name, bytes);
  }

  return files;
};
