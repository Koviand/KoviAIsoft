import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function replaceSync(tmp: string, filePath: string): void {
  try {
    fs.renameSync(tmp, filePath);
    return;
  } catch {
    // Windows often cannot rename over an existing target.
  }
  try {
    // Prefer copy over unlink+rename so a failed replace never deletes the target.
    fs.copyFileSync(tmp, filePath);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore leftover tmp
    }
    return;
  } catch {
    // fall through
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore missing target
  }
  fs.renameSync(tmp, filePath);
}

async function replaceAsync(tmp: string, filePath: string): Promise<void> {
  try {
    await fsp.rename(tmp, filePath);
    return;
  } catch {
    // Windows often cannot rename over an existing target.
  }
  try {
    await fsp.copyFile(tmp, filePath);
    try {
      await fsp.unlink(tmp);
    } catch {
      // ignore leftover tmp
    }
    return;
  } catch {
    // fall through
  }
  try {
    await fsp.unlink(filePath);
  } catch {
    // ignore missing target
  }
  await fsp.rename(tmp, filePath);
}

/** Write file via temp + replace to avoid torn content on crash. */
export function writeFileAtomicSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
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
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
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
}
