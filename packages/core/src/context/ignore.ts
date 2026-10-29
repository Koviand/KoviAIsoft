/** Directories / files skipped when mapping or retrieving project context. */
export const DEFAULT_IGNORE_DIR_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "out",
  "release",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".vscode",
  "target",
  "bin",
  "obj",
  "playwright-browsers",
  "data",
]);

export const DEFAULT_IGNORE_FILE_GLOBS = [
  /^\./, // dotfiles at any level handled separately for known names
];

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".7z",
  ".rar",
  ".gz",
  ".tar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".gguf",
  ".pt",
  ".onnx",
  ".wasm",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".lock",
]);

export function shouldIgnoreDirName(name: string): boolean {
  return DEFAULT_IGNORE_DIR_NAMES.has(name.toLowerCase());
}

export function isProbablyBinaryPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXT.has(lower.slice(dot));
}

export function isTextSourcePath(filePath: string): boolean {
  if (isProbablyBinaryPath(filePath)) return false;
  const lower = filePath.toLowerCase();
  // Allow extensionless common names
  if (/(^|[\\/])(dockerfile|makefile|readme|license|agents\.md|kovi\.md)$/i.test(lower)) {
    return true;
  }
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|c|h|hpp|css|scss|html|htm|json|md|txt|yml|yaml|toml|xml|sql|sh|ps1|bat|cmd|vue|svelte|php|rb)$/i.test(
    lower,
  );
}
