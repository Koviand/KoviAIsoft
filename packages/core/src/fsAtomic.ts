import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const writeLocks = new Map<string, Promise<void>>();

function tmpName(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const id = randomBytes(6).toString("hex");
  return path.join(dir, `.${base}.${process.pid}.${id}.tmp`);
}

function replaceSync(tmp: string, filePath: string): void {
  try {
    fs.renameSync(tmp, filePath);
    return;
  } catch {
    // Windows often cannot rename over an existing target.
  }
  // Prefer copy so a failed replace never deletes the target first.
  fs.copyFileSync(tmp, filePath);
  try {
    fs.unlinkSync(tmp);
  } catch {
    // ignore leftover tmp
  }
}

async function replaceAsync(tmp: string, filePath: string): Promise<void> {
  try {
    await fsp.rename(tmp, filePath);
    return;
  } catch {
    // Windows often cannot rename over an existing target.
  }
  await fsp.copyFile(tmp, filePath);
  try {
    await fsp.unlink(tmp);
  } catch {
    // ignore leftover tmp
  }
}

async function withPathLock(filePath: string, fn: () => Promise<void>): Promise<void> {
  const key = path.resolve(filePath).toLowerCase();
  const prev = writeLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tail = prev.then(() => gate);
  writeLocks.set(key, tail);
  await prev.catch(() => undefined);
  try {
    await fn();
  } finally {
    release();
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  }
}

/** Write file via unique temp + replace to avoid torn content on crash. */
export function writeFileAtomicSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpName(filePath);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    replaceSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await withPathLock(filePath, async () => {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = tmpName(filePath);
    try {
      await fsp.writeFile(tmp, content, "utf8");
      await replaceAsync(tmp, filePath);
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  });
}
