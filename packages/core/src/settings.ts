import fs from "node:fs";
import path from "node:path";
import type { AppSettings, LoadProfile } from "@kovi/shared";
import { createDefaultSettings, DEFAULT_LOAD_PROFILES } from "@kovi/shared";
import { writeFileAtomic, writeFileAtomicSync } from "./fsAtomic.js";
import { getSettingsPath, ensureDir, getModelsDir } from "./paths.js";

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
    const loadProfiles: LoadProfile[] =
      parsed.loadProfiles?.length
        ? parsed.loadProfiles
        : DEFAULT_LOAD_PROFILES.map((p) => ({ ...p }));
    return {
      ...defaults,
      ...parsed,
      themeCustom: { ...defaults.themeCustom, ...(parsed.themeCustom || {}) },
      defaultParams: { ...defaults.defaultParams, ...(parsed.defaultParams || {}) },
      modelRoots: parsed.modelRoots?.length ? parsed.modelRoots : defaults.modelRoots,
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
      activeLoadProfileId:
        typeof parsed.activeLoadProfileId === "string" || parsed.activeLoadProfileId === null
          ? parsed.activeLoadProfileId ?? null
          : defaults.activeLoadProfileId,
      sessionFolders: Array.isArray(parsed.sessionFolders)
        ? parsed.sessionFolders.filter((f) => typeof f === "string")
        : [],
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
