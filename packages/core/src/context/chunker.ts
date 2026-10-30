export interface TextChunk {
  /** Stable id within a file: `${relPath}#${startLine}-${endLine}` */
  id: string;
  relPath: string;
  startLine: number;
  endLine: number;
  text: string;
}

const TARGET_CHARS = 550;
const OVERLAP_CHARS = 80;
const MAX_FILE_BYTES = 400_000;

const FUNC_LIKE =
  /^\s*(export\s+)?(async\s+)?(function|class|def|fn|pub\s+fn|impl|struct|interface|type|const|let|var)\b/;

/**
 * Split source text into overlapping line-based chunks (~400–700 chars).
 */
export function chunkSourceText(
  relPath: string,
  content: string,
  opts?: { targetChars?: number; overlapChars?: number },
): TextChunk[] {
  const target = opts?.targetChars ?? TARGET_CHARS;
  const overlap = opts?.overlapChars ?? OVERLAP_CHARS;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (!lines.length || (lines.length === 1 && !lines[0])) return [];

  const chunks: TextChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    // Prefer starting at a function-like boundary when not at file start.
    if (i > 0) {
      let adjusted = i;
      for (let k = i; k < Math.min(i + 12, lines.length); k++) {
        if (FUNC_LIKE.test(lines[k]!) || lines[k]!.trim() === "") {
          adjusted = k;
          break;
        }
      }
      i = adjusted;
    }

    let chars = 0;
    let j = i;
    const piece: string[] = [];
    while (j < lines.length) {
      const line = lines[j]!;
      const add = line.length + 1;
      if (piece.length > 0 && chars + add > target) {
        // Soft break on blank / function boundary if we already have content.
        if (line.trim() === "" || FUNC_LIKE.test(line)) break;
        if (chars > target * 0.7) break;
      }
      piece.push(line);
      chars += add;
      j += 1;
      if (chars >= target * 1.35) break;
    }
    if (!piece.length) {
      piece.push(lines[i]!);
      j = i + 1;
    }
    const startLine = i + 1;
    const endLine = j;
    const text = piece.join("\n").trim();
    if (text) {
      chunks.push({
        id: `${relPath.replace(/\\/g, "/")}#${startLine}-${endLine}`,
        relPath: relPath.replace(/\\/g, "/"),
        startLine,
        endLine,
        text,
      });
    }
    if (j >= lines.length) break;
    // Overlap: step back by ~overlap chars worth of lines.
    let backChars = 0;
    let next = j;
    while (next > i + 1 && backChars < overlap) {
      next -= 1;
      backChars += (lines[next]?.length || 0) + 1;
    }
    i = Math.max(i + 1, next);
  }
  return chunks;
}

export function shouldIndexFileBytes(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_BYTES;
}

export const CHUNKER_LIMITS = {
  TARGET_CHARS,
  OVERLAP_CHARS,
  MAX_FILE_BYTES,
  MAX_CHUNKS_PER_PROJECT: 8_000,
};
