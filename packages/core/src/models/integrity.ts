import fs from "node:fs";
import fsp from "node:fs/promises";
import type { LocalModel } from "@kovi/shared";

const GGUF_MAGIC = Buffer.from("GGUF");

export async function verifyGgufFile(filePath: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return { ok: false, error: "Путь не является файлом" };
    if (st.size < 24) return { ok: false, error: "Файл слишком маленький для GGUF" };
    const fh = await fsp.open(filePath, "r");
    try {
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      if (!buf.equals(GGUF_MAGIC)) {
        return { ok: false, error: "Нет сигнатуры GGUF (файл повреждён или не GGUF)" };
      }
    } finally {
      await fh.close();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function verifyGgufSync(filePath: string): { ok: boolean; error?: string } {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: "Путь не является файлом" };
    if (st.size < 24) return { ok: false, error: "Файл слишком маленький для GGUF" };
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      if (!buf.equals(GGUF_MAGIC)) {
        return { ok: false, error: "Нет сигнатуры GGUF (файл повреждён или не GGUF)" };
      }
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function withIntegrity(model: LocalModel): LocalModel {
  const v = verifyGgufSync(model.path);
  return {
    ...model,
    integrityOk: v.ok,
    integrityError: v.ok ? undefined : v.error,
  };
}
