import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** Write file via temp + rename to avoid torn JSON on crash. */
export function writeFileAtomicSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Windows: replace existing target
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
    fs.renameSync(tmp, filePath);
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, filePath);
  } catch {
    try {
      await fsp.unlink(filePath);
    } catch {
      // ignore
    }
    await fsp.rename(tmp, filePath);
  }
}
