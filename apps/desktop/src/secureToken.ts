import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export type SecureSecretId = "github-token" | "hf-token" | "websearch-api-key";

const FILE_BY_ID: Record<SecureSecretId, string> = {
  "github-token": "github-token.bin",
  "hf-token": "hf-token.bin",
  "websearch-api-key": "websearch-api-key.bin",
};

function secretPath(appData: string, id: SecureSecretId): string {
  return path.join(appData, FILE_BY_ID[id]);
}

export function isSecureTokenAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Persist a secret via Electron safeStorage when available. */
export function saveSecret(appData: string, id: SecureSecretId, value: string): boolean {
  const trimmed = value.trim();
  const file = secretPath(appData, id);
  // Empty → delete stored secret. Placeholder → keep existing .bin untouched.
  if (!trimmed) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
    return true;
  }
  if (trimmed === "__secure__") {
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

export function loadSecret(appData: string, id: SecureSecretId): string | null {
  const file = secretPath(appData, id);
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = fs.readFileSync(file);
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/** @deprecated use saveSecret(appData, "github-token", token) */
export function saveGithubTokenSecure(appData: string, token: string): boolean {
  return saveSecret(appData, "github-token", token);
}

/** @deprecated use loadSecret(appData, "github-token") */
export function loadGithubTokenSecure(appData: string): string | null {
  return loadSecret(appData, "github-token");
}
