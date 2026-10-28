import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AppSettings, LoadProfile } from "@kovi/shared";
import { createDefaultSettings, DEFAULT_LOAD_PROFILES } from "@kovi/shared";
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
    await fsp.writeFile(
      getSettingsPath(this.appData),
      JSON.stringify(this.settings, null, 2),
      "utf8",
    );
    return this.get();
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings(this.appData);
    defaults.downloadDir = getModelsDir(this.appData);
    try {
      const raw = fs.readFileSync(getSettingsPath(this.appData), "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
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
    } catch {
      fs.writeFileSync(getSettingsPath(this.appData), JSON.stringify(defaults, null, 2), "utf8");
      return defaults;
    }
  }
}
