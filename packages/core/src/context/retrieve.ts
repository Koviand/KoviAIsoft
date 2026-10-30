import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isPathInside, normalizePath } from "../tools/sandbox.js";
import { isProbablyBinaryPath, isTextSourcePath, shouldIgnoreDirName } from "./ignore.js";
import { semanticSearch } from "./semanticIndex.js";

const execFileAsync = promisify(execFile);

let lastSemanticError: string | null = null;

/** Last semantic/@codebase embed failure (null if ok / skipped). */
export function getLastSemanticError(): string | null {
  return lastSemanticError;
}

export interface RetrievedSnippet {
  path: string; // relative
  absPath: string;
  score: number;
  reason: string;
  excerpt: string;
  startLine: number;
}

export interface RetrieveOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  /** Force semantic layer even without @codebase (agent coding tasks). */
  forceSemantic?: boolean;
}

/** True when user explicitly asked for @codebase. */
export function hasCodebaseMention(query: string): boolean {
  return /@codebase\b/i.test(query);
}

/** Strip @codebase tokens so they don't pollute keyword extraction. */
export function stripCodebaseMention(query: string): string {
  return query.replace(/@codebase\b/gi, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(
  [
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "in",
    "on",
    "of",
    "for",
    "with",
    "is",
    "are",
    "be",
    "this",
    "that",
    "it",
    "as",
    "at",
    "by",
    "from",
    "я",
    "ты",
    "он",
    "она",
    "мы",
    "вы",
    "они",
    "и",
    "или",
    "в",
    "на",
    "с",
    "по",
    "для",
    "как",
    "что",
    "это",
    "чтобы",
    "хочу",
    "нужно",
    "сделай",
    "напиши",
    "создай",
    "пожалуйста",
    "папке",
    "проекта",
    "файл",
    "файлы",
    "код",
  ].map((s) => s.toLowerCase()),
);

/** Extract @path / Windows / relative path mentions from user text. */
export function extractPathMentions(query: string, projectRoot: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const t = p.trim().replace(/^[@`"'([]+|[`"'\])]+$/g, "");
    if (!t || t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  // @file or @folder/path
  for (const m of query.matchAll(/@([A-Za-z0-9_.\-]+(?:[\\/][A-Za-z0-9_.\-]+)+|[A-Za-z0-9_.\-]+\.[A-Za-z0-9]+)/g)) {
    push(m[1]!);
  }
  // Windows absolute
  for (const m of query.matchAll(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+/g)) {
    push(m[0]!);
  }
  // relative with slash + extension or known folder
  for (const m of query.matchAll(
    /(?:^|[\s`"'(])((?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+)/g,
  )) {
    push(m[1]!);
  }

  if (projectRoot) {
    // Prefer paths that resolve under project
    return out.filter((p) => {
      try {
        const abs = path.isAbsolute(p)
          ? normalizePath(p)
          : normalizePath(path.join(projectRoot, p));
        return isPathInside(abs, projectRoot) || abs.toLowerCase() === normalizePath(projectRoot).toLowerCase();
      } catch {
        return true;
      }
    });
  }
  return out;
}

export function extractKeywords(query: string): string[] {
  const raw = query
    .replace(/[^\p{L}\p{N}_\-./\\]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of raw) {
    const low = w.toLowerCase();
    if (low.length < 3 || STOP.has(low)) continue;
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

function languageBoost(query: string, filePath: string): number {
  const q = query.toLowerCase();
  const f = filePath.toLowerCase();
  const rules: Array<[RegExp, RegExp, number]> = [
    [/python|\.py|pygame|django|flask/i, /\.py$/, 8],
    [/typescript|tsx|react|next/i, /\.(tsx?|jsx?)$/, 8],
    [/javascript|node|express/i, /\.(js|mjs|cjs)$/, 6],
    [/rust|cargo/i, /\.rs$/, 8],
    [/golang|\bgo\b/i, /\.go$/, 8],
    [/html|css|ui|интерфейс/i, /\.(html?|css|tsx|jsx)$/, 5],
    [/тест|test|spec/i, /\.(test|spec)\./i, 4],
  ];
  let score = 0;
  for (const [qRe, fRe, pts] of rules) {
    if (qRe.test(q) && fRe.test(f)) score += pts;
  }
  return score;
}

function readExcerpt(absPath: string, maxBytes: number, preferQuery?: string): { text: string; startLine: number } {
  let raw: string;
  try {
    const st = fs.statSync(absPath);
    if (st.size > 400_000) {
      // Read head only for huge files
      const fd = fs.openSync(absPath, "r");
      const buf = Buffer.alloc(Math.min(maxBytes * 2, 64_000));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      raw = buf.slice(0, n).toString("utf8");
    } else {
      raw = fs.readFileSync(absPath, "utf8");
    }
  } catch {
    return { text: "", startLine: 1 };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (preferQuery) {
    const keys = extractKeywords(preferQuery).map((k) => k.toLowerCase());
    let best = -1;
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i]!.toLowerCase();
      const hits = keys.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0);
      if (hits > 0 && hits >= best) {
        best = hits;
        start = Math.max(0, i - 8);
      }
    }
  }
  const chunk: string[] = [];
  let bytes = 0;
  for (let i = start; i < lines.length; i++) {
    const line = `${i + 1}| ${lines[i]}`;
    const add = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + add > maxBytes && chunk.length > 0) break;
    chunk.push(line);
    bytes += add;
  }
  return { text: chunk.join("\n"), startLine: start + 1 };
}

async function rgFiles(projectRoot: string, keyword: string, limit: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "-l",
        "-F",
        "--max-count",
        "1",
        "--glob",
        "!node_modules",
        "--glob",
        "!.git",
        "--glob",
        "!dist",
        "--glob",
        "!release",
        keyword,
        projectRoot,
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function walkMatchFiles(projectRoot: string, keywords: string[], limit: number): string[] {
  const hits: string[] = [];
  const stack = [projectRoot];
  while (stack.length && hits.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!shouldIgnoreDirName(e.name)) stack.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const full = path.join(dir, e.name);
      if (!isTextSourcePath(full) || isProbablyBinaryPath(full)) continue;
      const rel = path.relative(projectRoot, full).toLowerCase();
      const nameScore = keywords.some((k) => rel.includes(k.toLowerCase()));
      if (nameScore) hits.push(full);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * Cursor-like retrieval: @mentions + semantic @codebase + keyword/rg → scored snippets.
 */
export async function retrieveProjectContext(
  projectRoot: string | null,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedSnippet[]> {
  if (!projectRoot || !fs.existsSync(projectRoot)) return [];
  const maxFiles = opts.maxFiles ?? 6;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 3_500;
  const maxTotalBytes = opts.maxTotalBytes ?? 14_000;
  const wantSemantic = opts.forceSemantic === true || hasCodebaseMention(query);
  const cleanQuery = stripCodebaseMention(query);

  const scores = new Map<string, { score: number; reason: string; excerpt?: string; startLine?: number }>();
  const bump = (
    abs: string,
    score: number,
    reason: string,
    extra?: { excerpt?: string; startLine?: number },
  ) => {
    try {
      const n = normalizePath(abs);
      if (!isPathInside(n, projectRoot)) return;
      if (!fs.existsSync(n) || !fs.statSync(n).isFile()) return;
      if (isProbablyBinaryPath(n)) return;
      const cur = scores.get(n);
      if (!cur || score > cur.score) {
        scores.set(n, {
          score,
          reason,
          excerpt: extra?.excerpt ?? cur?.excerpt,
          startLine: extra?.startLine ?? cur?.startLine,
        });
      } else if (cur && reason && !cur.reason.includes(reason)) {
        scores.set(n, {
          score: cur.score + Math.max(1, Math.floor(score / 3)),
          reason: `${cur.reason}+${reason}`,
          excerpt: cur.excerpt || extra?.excerpt,
          startLine: cur.startLine ?? extra?.startLine,
        });
      }
    } catch {
      // skip
    }
  };

  for (const mention of extractPathMentions(cleanQuery, projectRoot)) {
    const abs = path.isAbsolute(mention)
      ? normalizePath(mention)
      : normalizePath(path.join(projectRoot, mention));
    bump(abs, 100, "mention");
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        const inner = walkMatchFiles(abs, extractKeywords(cleanQuery), 4);
        for (const f of inner) bump(f, 70, "mention-dir");
      }
    } catch {
      // ignore
    }
  }

  lastSemanticError = null;
  if (wantSemantic && cleanQuery.trim()) {
    try {
      const hits = await semanticSearch(projectRoot, cleanQuery, Math.max(8, maxFiles));
      for (const h of hits) {
        // Map cosine ~0..1 → score 40..90
        const mapped = 40 + Math.round(Math.max(0, Math.min(1, h.score)) * 50);
        bump(h.absPath, mapped, h.reason, {
          excerpt: h.excerpt
            .split("\n")
            .map((line, i) => `${h.startLine + i}| ${line}`)
            .join("\n")
            .slice(0, maxBytesPerFile),
          startLine: h.startLine,
        });
      }
    } catch (err) {
      // Lexical still runs; surface embedder failure for UI/agent thinking.
      lastSemanticError = err instanceof Error ? err.message : String(err);
      console.warn("[retrieve] semantic failed:", lastSemanticError);
    }
  }

  const keywords = extractKeywords(cleanQuery);
  for (const kw of keywords) {
    for (const f of walkMatchFiles(projectRoot, [kw], 20)) {
      bump(f, 20 + languageBoost(cleanQuery, f), `name:${kw}`);
    }
    for (const f of await rgFiles(projectRoot, kw, 15)) {
      bump(f, 25 + languageBoost(cleanQuery, f), `rg:${kw}`);
    }
  }

  for (const name of ["README.md", "readme.md", "package.json", "pyproject.toml", "main.py", "index.ts", "index.tsx", "App.tsx"]) {
    const abs = path.join(projectRoot, name);
    if (fs.existsSync(abs)) bump(abs, 8, "entrypoint");
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, maxFiles);

  const snippets: RetrievedSnippet[] = [];
  let total = 0;
  for (const [abs, meta] of ranked) {
    if (total >= maxTotalBytes) break;
    const room = Math.min(maxBytesPerFile, maxTotalBytes - total);
    let text = meta.excerpt || "";
    let startLine = meta.startLine || 1;
    if (!text) {
      const ex = readExcerpt(abs, room, cleanQuery);
      text = ex.text;
      startLine = ex.startLine;
    } else if (Buffer.byteLength(text, "utf8") > room) {
      text = text.slice(0, room);
    }
    if (!text) continue;
    total += Buffer.byteLength(text, "utf8");
    snippets.push({
      path: path.relative(projectRoot, abs).split(path.sep).join("/"),
      absPath: abs,
      score: meta.score,
      reason: meta.reason,
      excerpt: text,
      startLine,
    });
  }
  return snippets;
}

export function formatRetrievedSnippets(snippets: RetrievedSnippet[]): string {
  if (!snippets.length) return "";
  const parts = snippets.map(
    (s) =>
      `### ${s.path} (score=${s.score}, ${s.reason}, ~L${s.startLine})\n\`\`\`\n${s.excerpt}\n\`\`\``,
  );
  return `# Релевантный код (автоподбор)\n${parts.join("\n\n")}`;
}
