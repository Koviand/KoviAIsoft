import fs from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

/**
 * Lightweight GGUF metadata reader — extracts *.block_count (layer count).
 * Reads only the header + KV section (capped), never the full tensor blob.
 */
export async function readGgufLayerCount(
  filePath: string,
  maxBytes = 512 * 1024,
): Promise<number | null> {
  let fh: FileHandle | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 24) return null;
    fh = await fsOpen(filePath, "r");
    const toRead = Math.min(maxBytes, stat.size);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    if (bytesRead < 24) return null;
    return parseGgufBlockCount(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Sync variant for scanner / sync paths. */
export function readGgufLayerCountSync(
  filePath: string,
  maxBytes = 512 * 1024,
): number | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 24) return null;
    const fd = fs.openSync(filePath, "r");
    try {
      const toRead = Math.min(maxBytes, stat.size);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
      if (bytesRead < 24) return null;
      return parseGgufBlockCount(buf.subarray(0, bytesRead));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Parse GGUF header metadata for keys ending with `.block_count`.
 * Exported for unit tests.
 */
export function parseGgufBlockCount(buf: Buffer): number | null {
  if (buf.length < 24) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== GGUF_MAGIC) return null;
  const version = buf.readUInt32LE(4);
  if (version < 2 || version > 3) return null;

  // v3: tensor_count u64, kv_count u64 at offset 8
  let offset = 8;
  if (offset + 16 > buf.length) return null;
  offset += 8; // skip tensor_count
  const kvCount = Number(buf.readBigUInt64LE(offset));
  offset += 8;
  if (!Number.isFinite(kvCount) || kvCount < 0 || kvCount > 10_000) return null;

  for (let i = 0; i < kvCount; i++) {
    const key = readGgufString(buf, offset);
    if (!key) return null;
    offset = key.next;
    if (offset + 4 > buf.length) return null;
    const valueType = buf.readUInt32LE(offset);
    offset += 4;
    const value = readGgufValue(buf, offset, valueType);
    if (!value) return null;
    offset = value.next;
    if (key.str.endsWith(".block_count") || key.str === "block_count") {
      const n = Number(value.val);
      if (Number.isFinite(n) && n > 0 && n < 10_000) return Math.floor(n);
    }
  }
  return null;
}

function readGgufString(
  buf: Buffer,
  offset: number,
): { str: string; next: number } | null {
  if (offset + 8 > buf.length) return null;
  const len = Number(buf.readBigUInt64LE(offset));
  offset += 8;
  if (!Number.isFinite(len) || len < 0 || len > 1024 || offset + len > buf.length) {
    return null;
  }
  const str = buf.subarray(offset, offset + len).toString("utf8");
  return { str, next: offset + len };
}

/** GGUF value types (subset). */
const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

function readGgufValue(
  buf: Buffer,
  offset: number,
  valueType: number,
): { val: number | string | bigint; next: number } | null {
  switch (valueType) {
    case GGUF_TYPE.UINT8:
      if (offset + 1 > buf.length) return null;
      return { val: buf.readUInt8(offset), next: offset + 1 };
    case GGUF_TYPE.INT8:
      if (offset + 1 > buf.length) return null;
      return { val: buf.readInt8(offset), next: offset + 1 };
    case GGUF_TYPE.UINT16:
      if (offset + 2 > buf.length) return null;
      return { val: buf.readUInt16LE(offset), next: offset + 2 };
    case GGUF_TYPE.INT16:
      if (offset + 2 > buf.length) return null;
      return { val: buf.readInt16LE(offset), next: offset + 2 };
    case GGUF_TYPE.UINT32:
      if (offset + 4 > buf.length) return null;
      return { val: buf.readUInt32LE(offset), next: offset + 4 };
    case GGUF_TYPE.INT32:
      if (offset + 4 > buf.length) return null;
      return { val: buf.readInt32LE(offset), next: offset + 4 };
    case GGUF_TYPE.FLOAT32:
      if (offset + 4 > buf.length) return null;
      return { val: buf.readFloatLE(offset), next: offset + 4 };
    case GGUF_TYPE.BOOL:
      if (offset + 1 > buf.length) return null;
      return { val: buf.readUInt8(offset), next: offset + 1 };
    case GGUF_TYPE.STRING: {
      const s = readGgufString(buf, offset);
      if (!s) return null;
      return { val: s.str, next: s.next };
    }
    case GGUF_TYPE.UINT64:
      if (offset + 8 > buf.length) return null;
      return { val: buf.readBigUInt64LE(offset), next: offset + 8 };
    case GGUF_TYPE.INT64:
      if (offset + 8 > buf.length) return null;
      return { val: buf.readBigInt64LE(offset), next: offset + 8 };
    case GGUF_TYPE.FLOAT64:
      if (offset + 8 > buf.length) return null;
      return { val: buf.readDoubleLE(offset), next: offset + 8 };
    case GGUF_TYPE.ARRAY: {
      // type u32 + count u64 + elements — skip without materializing
      if (offset + 12 > buf.length) return null;
      const elemType = buf.readUInt32LE(offset);
      offset += 4;
      const count = Number(buf.readBigUInt64LE(offset));
      offset += 8;
      if (!Number.isFinite(count) || count < 0 || count > 1_000_000) return null;
      for (let i = 0; i < count; i++) {
        const el = readGgufValue(buf, offset, elemType);
        if (!el) return null;
        offset = el.next;
      }
      return { val: 0, next: offset };
    }
    default:
      return null;
  }
}
