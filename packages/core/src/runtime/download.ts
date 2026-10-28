import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import extract from "extract-zip";
import { ensureDir } from "../paths.js";

export type ProgressFn = (progress: number, label: string) => void;

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: ProgressFn,
  expectedSha?: string,
  expectedSize?: number,
): Promise<void> {
  ensureDir(path.dirname(destPath));
  // Remove partial leftovers from previous failed attempts.
  await fsp.rm(destPath, { force: true }).catch(() => undefined);

  const res = await fetch(url, {
    headers: {
      "User-Agent": "KoviAIsoft",
      Accept: "application/octet-stream",
    },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${url}`);
  }

  const total = Number(res.headers.get("content-length") || expectedSize || 0);
  let received = 0;
  const file = fs.createWriteStream(destPath);
  const nodeStream = Readable.fromWeb(
    res.body as import("node:stream/web").ReadableStream,
  );

  // Progress via Transform — do NOT attach .on('data') before pipeline
  // (that switches the stream to flowing mode and corrupts the download).
  const progressTap = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (total > 0 && onProgress) {
        onProgress(
          Math.min(99, Math.round((received / total) * 100)),
          path.basename(destPath),
        );
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(nodeStream, progressTap, file);
  } catch (err) {
    await fsp.unlink(destPath).catch(() => undefined);
    throw err;
  }

  const st = await fsp.stat(destPath);
  if (expectedSize && st.size !== expectedSize) {
    await fsp.unlink(destPath).catch(() => undefined);
    throw new Error(
      `Размер файла не совпал для ${path.basename(destPath)}: ${st.size} != ${expectedSize}`,
    );
  }
  if (total > 0 && st.size !== total) {
    await fsp.unlink(destPath).catch(() => undefined);
    throw new Error(
      `Неполная загрузка ${path.basename(destPath)}: ${st.size} из ${total} байт`,
    );
  }

  if (expectedSha) {
    const actual = await sha256File(destPath);
    if (actual !== expectedSha.toLowerCase()) {
      await fsp.unlink(destPath).catch(() => undefined);
      throw new Error(
        `SHA256 mismatch for ${path.basename(destPath)} (got ${actual.slice(0, 12)}…)`,
      );
    }
  }
  onProgress?.(100, path.basename(destPath));
}

export async function extractZipTo(zipPath: string, destDir: string): Promise<void> {
  ensureDir(destDir);
  await extract(zipPath, { dir: destDir });
}

export async function findLlamaServer(root: string): Promise<string | null> {
  const candidates = [
    path.join(root, "llama-server.exe"),
    path.join(root, "build", "bin", "llama-server.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === "llama-server.exe") return full;
      if (e.isDirectory() && e.name !== "node_modules") stack.push(full);
    }
  }
  return null;
}

export async function mergeDirectory(src: string, dest: string): Promise<void> {
  ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      await mergeDirectory(from, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
}
