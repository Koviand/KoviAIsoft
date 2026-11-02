import { describe, expect, it } from "vitest";
import { parseGgufBlockCount } from "../packages/core/src/models/ggufMeta";

/** Build a minimal GGUF v3 buffer with one uint32 metadata key. */
function fakeGguf(key: string, blockCount: number): Buffer {
  const keyBuf = Buffer.from(key, "utf8");
  const parts: Buffer[] = [];
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x46554747, 0); // GGUF
  header.writeUInt32LE(3, 4); // version
  header.writeBigUInt64LE(0n, 8); // tensor_count
  header.writeBigUInt64LE(1n, 16); // kv_count
  parts.push(header);

  const keyLen = Buffer.alloc(8);
  keyLen.writeBigUInt64LE(BigInt(keyBuf.length), 0);
  parts.push(keyLen, keyBuf);

  const typeAndVal = Buffer.alloc(8);
  typeAndVal.writeUInt32LE(4, 0); // UINT32
  typeAndVal.writeUInt32LE(blockCount, 4);
  parts.push(typeAndVal);

  return Buffer.concat(parts);
}

describe("parseGgufBlockCount", () => {
  it("reads llama.block_count", () => {
    expect(parseGgufBlockCount(fakeGguf("llama.block_count", 33))).toBe(33);
  });

  it("rejects bad magic", () => {
    const bad = fakeGguf("llama.block_count", 10);
    bad.writeUInt32LE(0, 0);
    expect(parseGgufBlockCount(bad)).toBeNull();
  });
});
