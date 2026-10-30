import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let overrideAppData: string | null = null;

/** Allow Electron to pin data next to the portable EXE. */
export function setAppDataDir(dir: string): void {
  overrideAppData = dir;
  ensureDir(dir);
}

export function getAppDataDir(appName = "KoviAIsoft"): string {
  if (overrideAppData) {
    ensureDir(overrideAppData);
    return overrideAppData;
  }
  if (process.env.KOVI_DATA_DIR) {
    ensureDir(process.env.KOVI_DATA_DIR);
    return process.env.KOVI_DATA_DIR;
  }
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(base, appName);
  ensureDir(dir);
  return dir;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function getRuntimesDir(appData: string): string {
  const dir = path.join(appData, "runtimes");
  ensureDir(dir);
  return dir;
}

export function getModelsDir(appData: string): string {
  const dir = path.join(appData, "models");
  ensureDir(dir);
  return dir;
}

export function getDbPath(appData: string): string {
  ensureDir(appData);
  return path.join(appData, "store.json");
}

export function getSettingsPath(appData: string): string {
  return path.join(appData, "settings.json");
}

export function getAttachmentsDir(appData: string): string {
  const dir = path.join(appData, "attachments");
  ensureDir(dir);
  return dir;
}

/**
 * Portable root: parent of data/ when Electron pins appData next to EXE.
 * Fallback: appData itself.
 */
export function getPortableRoot(appData = getAppDataDir()): string {
  const base = path.resolve(appData);
  if (path.basename(base).toLowerCase() === "data") {
    return path.dirname(base);
  }
  return base;
}

/** Bundled Hugging Face CLI lives at {portable}/tools/hf */
export function getHfToolsDir(appData = getAppDataDir()): string {
  const dir = path.join(getPortableRoot(appData), "tools", "hf");
  ensureDir(dir);
  return dir;
}
