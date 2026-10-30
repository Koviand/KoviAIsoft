import fs from "node:fs";
import path from "node:path";
import type { AppSettings, LoadProfile } from "@kovi/shared";
import {
  createDefaultSettings,
  DEFAULT_LOAD_PROFILES,
  isThemePreset,
  migrateLoadProfileId,
} from "@kovi/shared";
import { writeFileAtomic, writeFileAtomicSync } from "./fsAtomic.js";
import { getSettingsPath, ensureDir, getModelsDir } from "./paths.js";

const LEGACY_PROFILE_IDS = new Set(["max-quality", "low-vram"]);

function migrateLoadProfiles(profiles: LoadProfile[]): LoadProfile[] {
  const mapped = profiles.map((p) => {
    const id = migrateLoadProfileId(p.id) || p.id;
    if (id === p.id) return p;
    const name =
      id === "quality" ? "Качество" : id === "fast" ? "Быстро" : p.name;
    return { ...p, id, name, hardwareAware: p.hardwareAware ?? true };
  });
  const byId = new Map<string, LoadProfile>();
  for (const p of mapped) {
    if (!byId.has(p.id)) byId.set(p.id, p);
  }
  // If user still only has legacy set without new defaults, ensure core tiers exist.
  const hasLegacyOnly =
    profiles.some((p) => LEGACY_PROFILE_IDS.has(p.id)) &&
    !profiles.some((p) => p.id === "fast" || p.id === "quality");
  if (hasLegacyOnly || !byId.has("fast") || !byId.has("balanced") || !byId.has("quality")) {
    for (const d of DEFAULT_LOAD_PROFILES) {
      if (!byId.has(d.id)) byId.set(d.id, { ...d });
    }
  }
  // Prefer canonical order: fast, balanced, quality, then others (cpu, auto-pc, custom).
  const order = ["fast", "balanced", "quality", "cpu", "auto-pc"];
  const ordered: LoadProfile[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (p) {
      ordered.push(p);
      byId.delete(id);
    }
  }
  for (const p of byId.values()) ordered.push(p);
  return ordered;
}

export class SettingsStore {
  private appData: string;
  private settings: AppSettings;

  constructor(appData: string) {
    this.appData = appData;
    ensureDir(appData);
    this.settings = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  async save(next: AppSettings): Promise<AppSettings> {
    this.settings = structuredClone(next);
    await writeFileAtomic(
      getSettingsPath(this.appData),
      JSON.stringify(this.settings, null, 2),
    );
    return this.get();
  }

  private mergePartial(defaults: AppSettings, parsed: Partial<AppSettings>): AppSettings {
    const loadProfiles: LoadProfile[] = migrateLoadProfiles(
      parsed.loadProfiles?.length
        ? parsed.loadProfiles
        : DEFAULT_LOAD_PROFILES.map((p) => ({ ...p })),
    );
    const rawActive =
      typeof parsed.activeLoadProfileId === "string" || parsed.activeLoadProfileId === null
        ? parsed.activeLoadProfileId ?? null
        : defaults.activeLoadProfileId;
    const activeLoadProfileId = migrateLoadProfileId(rawActive);
    return {
      ...defaults,
      ...parsed,
      themePreset: isThemePreset(parsed.themePreset) ? parsed.themePreset : defaults.themePreset,
      themeCustom: { ...defaults.themeCustom, ...(parsed.themeCustom || {}) },
      defaultParams: { ...defaults.defaultParams, ...(parsed.defaultParams || {}) },
      modelRoots: parsed.modelRoots?.length ? parsed.modelRoots : defaults.modelRoots,
      downloadDir:
        typeof parsed.downloadDir === "string" && parsed.downloadDir.trim()
          ? parsed.downloadDir.trim()
          : defaults.downloadDir,
      mcpServers: parsed.mcpServers || [],
      autoUpdateRuntime:
        typeof parsed.autoUpdateRuntime === "boolean"
          ? parsed.autoUpdateRuntime
          : defaults.autoUpdateRuntime,
      runtimeLastCheckAt:
        typeof parsed.runtimeLastCheckAt === "string"
          ? parsed.runtimeLastCheckAt
          : parsed.runtimeLastCheckAt === null
            ? null
            : defaults.runtimeLastCheckAt,
      githubToken:
        typeof parsed.githubToken === "string" ? parsed.githubToken : defaults.githubToken,
      hfDownloadMethod:
        parsed.hfDownloadMethod === "auto" ||
        parsed.hfDownloadMethod === "cli" ||
        parsed.hfDownloadMethod === "http"
          ? parsed.hfDownloadMethod
          : defaults.hfDownloadMethod,
      hfToken: typeof parsed.hfToken === "string" ? parsed.hfToken : defaults.hfToken,
      onboardingCompleted:
        typeof parsed.onboardingCompleted === "boolean"
          ? parsed.onboardingCompleted
          : // Existing installs skip wizard.
            true,
      agentRiskMode:
        parsed.agentRiskMode === "ask" ||
        parsed.agentRiskMode === "auto-safe" ||
        parsed.agentRiskMode === "full"
          ? parsed.agentRiskMode
          : defaults.agentRiskMode,
      loadProfiles,
      activeLoadProfileId,
      sessionFolders: Array.isArray(parsed.sessionFolders)
        ? parsed.sessionFolders.filter((f) => typeof f === "string")
        : [],
      embeddingModelId:
        parsed.embeddingModelId === "minilm" || parsed.embeddingModelId === "lfm25"
          ? parsed.embeddingModelId
          : defaults.embeddingModelId,
    };
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings(this.appData);
    defaults.downloadDir = getModelsDir(this.appData);
    const settingsPath = getSettingsPath(this.appData);
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return this.mergePartial(defaults, parsed);
    } catch {
      // Corrupt or missing: keep a backup of the broken file when present.
      try {
        if (fs.existsSync(settingsPath)) {
          const bak = path.join(
            path.dirname(settingsPath),
            `settings.json.bak`,
          );
          fs.copyFileSync(settingsPath, bak);
        }
      } catch {
        // ignore backup failure
      }
      writeFileAtomicSync(settingsPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
  }
}
