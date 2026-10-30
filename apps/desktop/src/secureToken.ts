import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

const TOKEN_FILE = "github-token.bin";

function tokenPath(appData: string): string {
  return path.join(appData, TOKEN_FILE);
}

/** Persist GitHub token via Electron safeStorage when available. */
export function saveGithubTokenSecure(appData: string, token: string): boolean {
  const trimmed = token.trim();
  const file = tokenPath(appData);
  if (!trimmed) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
    return true;
  }
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const buf = safeStorage.encryptString(trimmed);
    fs.writeFileSync(file, buf);
    return true;
  } catch {
    return false;
  }
}

export function loadGithubTokenSecure(appData: string): string | null {
  const file = tokenPath(appData);
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = fs.readFileSync(file);
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function isSecureTokenAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}
