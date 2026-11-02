import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import type { AppSettings, McpServerConfig } from "@kovi/shared";
import {
  IPC,
  assertAppSettingsDeep,
  assertResolveConfirmation,
  assertSessionExportBundle,
  assertSessionPatch,
} from "@kovi/shared";
import { AppService, getAppDataDir, setAppDataDir } from "@kovi/core";
import {
  isSecureTokenAvailable,
  loadSecret,
  saveSecret,
} from "./secureToken";
import { verifyGithubToken } from "@kovi/core";

let mainWindow: BrowserWindow | null = null;
let monitorWindow: BrowserWindow | null = null;
let service: AppService | null = null;
let monitorTimer: NodeJS.Timeout | null = null;

function appIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "icon.png"),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

/** True when running the portable layout (data next to EXE), not NSIS install. */
function isPortableLayout(): boolean {
  if (!app.isPackaged) return false;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  const exeDir = path.dirname(process.execPath);
  return fs.existsSync(path.join(exeDir, ".kovi-portable"));
}

function appInstallRoot(): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, "..");
}

/**
 * Portable: data/ + playwright-browsers/ beside EXE.
 * Installed (NSIS): %APPDATA%/KoviAIsoft (Electron userData).
 */
function configureAppPaths(): void {
  if (isPortableLayout() || !app.isPackaged) {
    const root = appInstallRoot();
    const dataDir = path.join(root, "data");
    setAppDataDir(dataDir);
    app.setPath("userData", dataDir);
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, "playwright-browsers");
    return;
  }
  // NSIS / installed: keep default userData under AppData.
  const dataDir = app.getPath("userData");
  setAppDataDir(dataDir);
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataDir, "playwright-browsers");
}

function uiPath(): string {
  if (!app.isPackaged) {
    return process.env.KOVI_UI_URL || "http://127.0.0.1:5173";
  }
  return path.join(process.resourcesPath, "ui", "index.html");
}

function isAllowedUiNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  const target = uiPath();
  if (target.startsWith("http")) {
    try {
      const u = new URL(url);
      const allowed = new URL(target);
      return u.origin === allowed.origin;
    } catch {
      return false;
    }
  }
  // Packaged: only UI index.html (+ hash/query) — not arbitrary file: (P1-10).
  if (!url.startsWith("file:")) return false;
  try {
    const u = new URL(url);
    let filePath = decodeURIComponent(u.pathname);
    // Windows file:///C:/path → /C:/path
    if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.slice(1);
    }
    const normalized = path.normalize(filePath).toLowerCase();
    const allowedHtml = path.normalize(target).toLowerCase();
    const allowedDir = path.normalize(path.dirname(target)).toLowerCase();
    if (normalized === allowedHtml) return true;
    // Allow hash-only navigations that resolve to the same index.html
    return normalized.startsWith(allowedDir + path.sep) && normalized.endsWith("index.html");
  } catch {
    return false;
  }
}

function isCancelErrorMessage(message: string): boolean {
  return /отмен|abort/i.test(message);
}

function assertSendRequest(req: unknown): {
  sessionId: string;
  content: string;
  useAgent?: boolean;
  params?: unknown;
  attachments?: import("@kovi/shared").ChatAttachment[];
} {
  if (!req || typeof req !== "object") throw new Error("Некорректный запрос");
  const r = req as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId.trim()) {
    throw new Error("sessionId обязателен");
  }
  if (typeof r.content !== "string") {
    throw new Error("content должен быть строкой");
  }
  const attachments = Array.isArray(r.attachments)
    ? (r.attachments as import("@kovi/shared").ChatAttachment[])
    : undefined;
  return {
    sessionId: r.sessionId,
    content: r.content,
    useAgent: typeof r.useAgent === "boolean" ? r.useAgent : undefined,
    params: r.params,
    attachments,
  };
}

function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedUiNavigation(url)) {
      event.preventDefault();
    }
  });
}

/** Chat/agent stream events go to main UI only — not the monitor window. */
function broadcastMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function parentForDialog(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  const from = BrowserWindow.fromWebContents(event.sender);
  if (from && !from.isDestroyed()) return from;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return undefined;
}

function assertSettingsShape(settings: unknown): AppSettings {
  return assertAppSettingsDeep(settings);
}

function assertMcpServer(server: unknown): McpServerConfig {
  if (!server || typeof server !== "object") {
    throw new Error("Некорректный MCP server");
  }
  const s = server as McpServerConfig;
  if (typeof s.id !== "string" || !s.id.trim()) {
    throw new Error("MCP id обязателен");
  }
  if (s.transport === "stdio") {
    if (typeof s.command !== "string" || !s.command.trim()) {
      throw new Error("MCP command обязателен для stdio");
    }
  }
  if (s.transport === "sse") {
    if (typeof s.url !== "string" || !s.url.trim()) {
      throw new Error("MCP url обязателен для sse");
    }
  }
  return s;
}

async function loadUi(win: BrowserWindow, hash = ""): Promise<void> {
  const target = uiPath();
  if (target.startsWith("http")) {
    const url = hash ? `${target}${hash.startsWith("#") ? hash : `#${hash}`}` : target;
    await win.loadURL(url);
  } else if (hash) {
    await win.loadFile(target, { hash: hash.replace(/^#/, "") });
  } else {
    await win.loadFile(target);
  }
}

async function createWindow(): Promise<void> {
  const icon = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#e7ebf0",
    title: "KoviAIsoft",
    autoHideMenuBar: true,
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  hardenWindow(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (icon) {
    try {
      app.setAppUserModelId("com.kovi.aisoft");
      const img = nativeImage.createFromPath(icon);
      if (!img.isEmpty()) mainWindow.setIcon(img);
    } catch {
      // ignore
    }
  }

  await loadUi(mainWindow);

  if (!app.isPackaged && process.env.KOVI_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (monitorWindow && !monitorWindow.isDestroyed()) {
      monitorWindow.close();
    }
    void shutdown();
  });
}

async function createMonitorWindow(): Promise<void> {
  // Existing window: show if it was stuck hidden after a failed first paint.
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    if (!monitorWindow.isVisible()) monitorWindow.show();
    monitorWindow.focus();
    startMonitorPush();
    return;
  }

  const icon = appIconPath();
  const preloadPath = path.join(__dirname, "monitorPreload.js");
  if (!fs.existsSync(preloadPath)) {
    throw new Error(`monitorPreload не найден: ${preloadPath}`);
  }

  monitorWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: "#e7ebf0",
    title: "KoviAIsoft · Monitor",
    autoHideMenuBar: true,
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  hardenWindow(monitorWindow);

  // Register before load so we never miss the first ready-to-show.
  monitorWindow.once("ready-to-show", () => {
    if (monitorWindow && !monitorWindow.isDestroyed()) monitorWindow.show();
  });
  monitorWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[monitor] did-fail-load", code, desc);
  });
  monitorWindow.on("closed", () => {
    monitorWindow = null;
    stopMonitorPush();
  });

  try {
    await loadUi(monitorWindow, "#/monitor");
  } catch (err) {
    const win = monitorWindow;
    monitorWindow = null;
    if (win && !win.isDestroyed()) win.destroy();
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Fallback if ready-to-show already fired before listener (cached load).
  if (monitorWindow && !monitorWindow.isDestroyed() && !monitorWindow.isVisible()) {
    monitorWindow.show();
  }

  // Ensure hash route is applied (file:// loadFile hash can be flaky).
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    try {
      const url = monitorWindow.webContents.getURL();
      if (url && !/#\/?monitor\b/i.test(url)) {
        await monitorWindow.webContents.executeJavaScript(
          `if (!/#\\/?monitor\\b/i.test(location.hash)) { location.hash = '#/monitor'; location.reload(); }`,
        );
      }
    } catch {
      // non-fatal — UI may still work via first paint
    }
  }

  startMonitorPush();
}

function startMonitorPush(): void {
  stopMonitorPush();
  if (!service) return;
  monitorTimer = setInterval(() => {
    void service
      ?.getMonitorSnapshot()
      .then((snap) => {
        if (monitorWindow && !monitorWindow.isDestroyed()) {
          monitorWindow.webContents.send(IPC.monitorUpdate, snap);
        }
      })
      .catch(() => undefined);
  }, 1500);
}

function stopMonitorPush(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

async function shutdown(): Promise<void> {
  stopMonitorPush();
  await service?.dispose();
  service = null;
  if (process.platform !== "darwin") app.quit();
}

function registerIpc(svc: AppService): void {
  ipcMain.handle(IPC.getSystemInfo, () => svc.getSystemInfo());
  ipcMain.handle(IPC.getSettings, () => {
    const s = svc.getSettings();
    const appData = getAppDataDir();
    const github = loadSecret(appData, "github-token");
    const hf = loadSecret(appData, "hf-token");
    const web = loadSecret(appData, "websearch-api-key");
    return {
      ...s,
      githubToken: github || s.githubToken || "",
      hfToken: hf || s.hfToken || "",
      webSearchApiKey: web || s.webSearchApiKey || "",
    };
  });
  ipcMain.handle(IPC.saveSettings, (_e, settings) => {
    const shaped = assertSettingsShape(settings);
    const appData = getAppDataDir();
    const github = typeof shaped.githubToken === "string" ? shaped.githubToken : "";
    const hf = typeof shaped.hfToken === "string" ? shaped.hfToken : "";
    const web = typeof shaped.webSearchApiKey === "string" ? shaped.webSearchApiKey : "";
    let stored = { ...shaped };
    const applySecret = (
      id: "github-token" | "hf-token" | "websearch-api-key",
      value: string,
      setOverride: (v: string | null) => void,
      assign: (placeholder: string) => void,
    ) => {
      if (!isSecureTokenAvailable()) {
        setOverride(null);
        return;
      }
      if (saveSecret(appData, id, value)) {
        assign(value ? "__secure__" : "");
        if (value === "__secure__") {
          setOverride(loadSecret(appData, id));
        } else {
          setOverride(value || null);
        }
      } else if (value && value !== "__secure__") {
        // Encryption failed — keep plaintext in settings + memory override.
        setOverride(value);
      } else {
        setOverride(value === "__secure__" ? loadSecret(appData, id) : null);
      }
    };
    applySecret("github-token", github, (v) => svc.setGithubTokenOverride(v), (p) => {
      stored.githubToken = p;
    });
    applySecret("hf-token", hf, (v) => svc.setHfTokenOverride(v), (p) => {
      stored.hfToken = p;
    });
    applySecret("websearch-api-key", web, (v) => svc.setWebSearchApiKeyOverride(v), (p) => {
      stored.webSearchApiKey = p;
    });
    return svc.saveSettings(stored).then((saved) => ({
      ...saved,
      githubToken: github === "__secure__" ? loadSecret(appData, "github-token") || "" : github,
      hfToken: hf === "__secure__" ? loadSecret(appData, "hf-token") || "" : hf,
      webSearchApiKey: web === "__secure__" ? loadSecret(appData, "websearch-api-key") || "" : web,
    }));
  });
  ipcMain.handle(IPC.verifyGithubToken, async () => {
    const s = svc.getEffectiveSettings();
    return verifyGithubToken(s.githubToken || "");
  });
  ipcMain.handle(IPC.getRuntimeStatus, () => svc.getRuntimeStatus());
  ipcMain.handle(IPC.detectRuntimeAsset, (_e, backend) => svc.detectRuntimeAsset(backend));
  ipcMain.handle(IPC.installRuntime, (_e, backend) => svc.installRuntime(backend));
  ipcMain.handle(IPC.checkRuntimeUpdate, (_e, backend) => svc.checkRuntimeUpdate(backend));
  ipcMain.handle(IPC.ensureLatestRuntime, (_e, backend, force) =>
    svc.ensureLatestRuntime(backend, { force: Boolean(force) }),
  );
  ipcMain.handle(IPC.listModels, () => svc.listModels());
  ipcMain.handle(IPC.scanModels, () => svc.scanModels());
  ipcMain.handle(IPC.deleteModel, (_e, modelId) => {
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error("modelId должен быть непустой строкой");
    }
    return svc.deleteModel(modelId);
  });
  ipcMain.handle(IPC.getModelRecommendations, () => svc.getModelRecommendations());
  ipcMain.handle(IPC.suggestHardwareLoadSettings, (_e, opts) =>
    svc.suggestHardwareLoadSettings(opts),
  );
  ipcMain.handle(IPC.applyHardwareLoadSettings, (_e, opts) =>
    svc.applyHardwareLoadSettings(opts),
  );
  ipcMain.handle(IPC.applyLoadProfileToSettings, (_e, opts) =>
    svc.applyLoadProfileToSettings(opts),
  );
  ipcMain.handle(IPC.searchHf, (_e, query) => svc.searchHf(query));
  ipcMain.handle(IPC.listHfFiles, (_e, modelId) => svc.listHfFiles(modelId));
  ipcMain.handle(IPC.downloadHfFile, (_e, modelId, filePath) =>
    svc.downloadHf(modelId, filePath),
  );
  ipcMain.handle(IPC.getHfCliStatus, () => svc.getHfCliStatus());
  ipcMain.handle(IPC.ensureHfCli, () => svc.ensureHfCli());
  ipcMain.handle(IPC.loadModel, (_e, modelId, params) => svc.loadModel(modelId, params));
  ipcMain.handle(IPC.unloadModel, () => svc.unloadModel());
  ipcMain.handle(IPC.listSessions, () => svc.listSessions());
  ipcMain.handle(IPC.createSession, (_e, mode, title) => svc.createSession(mode, title));
  ipcMain.handle(IPC.updateSession, (_e, session) =>
    svc.updateSession(assertSessionPatch(session)),
  );
  ipcMain.handle(IPC.deleteSession, (_e, sessionId) => svc.deleteSession(sessionId));
  ipcMain.handle(IPC.getMessages, (_e, sessionId) => svc.getMessages(sessionId));
  // Deprecated thin wrappers — UI uses sendMessage / stopGeneration.
  ipcMain.handle(IPC.sendChat, (_e, req) => {
    const r = assertSendRequest(req);
    return svc.sendChat(r.sessionId, r.content, r.params as never);
  });
  // Always fire-and-forget: completion is signaled via agentEvent (started/done/error).
  ipcMain.handle(IPC.sendMessage, async (_e, req) => {
    const r = assertSendRequest(req);
    void svc
      .sendMessage(r.sessionId, r.content, {
        useAgent: r.useAgent,
        params: r.params as never,
        attachments: r.attachments,
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (isCancelErrorMessage(message)) return;
        broadcastMain(IPC.agentEvent, {
          sessionId: r.sessionId,
          event: { type: "error", message },
        });
      });
  });
  ipcMain.handle(IPC.stopGeneration, () => svc.stopGeneration());
  ipcMain.handle(IPC.startAgent, async (_e, req) => {
    const r = assertSendRequest(req);
    void svc.startAgent(r.sessionId, r.content).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isCancelErrorMessage(message)) return;
      broadcastMain(IPC.agentEvent, {
        sessionId: r.sessionId,
        event: { type: "error", message },
      });
    });
  });
  ipcMain.handle(IPC.resolveConfirmation, (_e, req) => {
    const r = assertResolveConfirmation(req);
    return svc.resolveConfirmation(r.confirmationId, r.approved, r.rememberForSession);
  });
  ipcMain.handle(IPC.cancelAgent, () => svc.stopGeneration());
  ipcMain.handle(IPC.pickDirectory, async (e) => {
    const parent = parentForDialog(e);
    const res = parent
      ? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  ipcMain.handle(IPC.pickFile, async (e, filters) => {
    const parent = parentForDialog(e);
    const opts = {
      properties: ["openFile"] as ("openFile")[],
      filters: filters || [{ name: "All", extensions: ["*"] }],
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled ? null : res.filePaths[0] || null;
  });
  ipcMain.handle(IPC.getStatusBar, () => svc.getStatusBar());
  ipcMain.handle(IPC.getMonitorSnapshot, () => svc.getMonitorSnapshot());
  ipcMain.handle(IPC.openMonitorWindow, async () => {
    await createMonitorWindow();
  });
  ipcMain.handle(IPC.setMonitorAlwaysOnTop, (_e, flag: boolean) => {
    if (!monitorWindow || monitorWindow.isDestroyed()) return false;
    monitorWindow.setAlwaysOnTop(Boolean(flag));
    return monitorWindow.isAlwaysOnTop();
  });
  ipcMain.handle(IPC.exportSession, (_e, sessionId: string) => svc.exportSession(sessionId));
  ipcMain.handle(IPC.exportSessionFolder, (_e, folder: string) => {
    if (typeof folder !== "string" || !folder.trim()) throw new Error("folder обязателен");
    return svc.exportSessionFolder(folder.trim());
  });
  ipcMain.handle(IPC.importSession, (_e, bundle) =>
    svc.importSession(assertSessionExportBundle(bundle)),
  );
  ipcMain.handle(IPC.openPath, async (_e, targetPath: string) => {
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      return { ok: false, error: "path обязателен" };
    }
    try {
      const resolved = svc.resolveOpenPath(targetPath.trim());
      const st = await import("node:fs").then((fs) => fs.promises.stat(resolved));
      if (st.isDirectory()) {
        const err = await shell.openPath(resolved);
        return err ? { ok: false, error: err } : { ok: true };
      }
      shell.showItemInFolder(resolved);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(IPC.listCheckpoints, () => svc.listCheckpoints());
  ipcMain.handle(IPC.restoreCheckpoint, (_e, checkpointPath: string) => {
    if (typeof checkpointPath !== "string" || !checkpointPath.trim()) {
      throw new Error("checkpointPath обязателен");
    }
    return svc.restoreCheckpoint(checkpointPath.trim());
  });
  ipcMain.handle(IPC.addChatAttachment, (_e, sourcePath: string) => {
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      throw new Error("sourcePath обязателен");
    }
    return svc.addChatAttachment(sourcePath.trim());
  });
  ipcMain.handle(IPC.getErrorLog, () => svc.getErrorLog());
  ipcMain.handle(IPC.checkMcpHealth, (_e, server) => svc.checkMcpHealth(assertMcpServer(server)));
  ipcMain.handle(IPC.verifyGguf, (_e, modelId: string) => svc.verifyGguf(modelId));
  ipcMain.handle(IPC.getCodebaseIndexStatus, () => svc.getCodebaseIndexStatus());
  ipcMain.handle(IPC.listProjectMentions, () => svc.listProjectMentions());
  ipcMain.handle(IPC.reindexCodebase, () => svc.reindexCodebase());
  ipcMain.handle(IPC.listEmbeddingModels, () => svc.listEmbeddingModels());
  ipcMain.handle(IPC.getEmbeddingStatus, () => svc.getEmbeddingStatus());
  ipcMain.handle(IPC.downloadEmbeddingModel, (_e, id) => svc.downloadEmbeddingModel(id));
  ipcMain.handle(IPC.setEmbeddingModel, (_e, id) => svc.setEmbeddingModel(id));
  ipcMain.handle(IPC.previewFileDiff, (_e, filePath: string, content: string) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("filePath обязателен");
    }
    if (typeof content !== "string") {
      throw new Error("content должен быть строкой");
    }
    return svc.previewFileDiff(filePath, content);
  });

  svc.onRuntimeProgress = (p) => broadcastAll(IPC.runtimeProgress, p);
  svc.onDownloadProgress = (p) => broadcastAll(IPC.downloadProgress, p);
  svc.onChatToken = (p) => broadcastMain(IPC.chatToken, p);
  svc.onAgentEvent = (p) => broadcastMain(IPC.agentEvent, p);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    configureAppPaths();
    service = new AppService();
    // Secrets before init — auto runtime update / MCP need GitHub token when present.
    const appData = getAppDataDir();
    const securedGh = loadSecret(appData, "github-token");
    if (securedGh) service.setGithubTokenOverride(securedGh);
    const securedHf = loadSecret(appData, "hf-token");
    if (securedHf) service.setHfTokenOverride(securedHf);
    const securedWeb = loadSecret(appData, "websearch-api-key");
    if (securedWeb) service.setWebSearchApiKeyOverride(securedWeb);
    await service.init();
    registerIpc(service);
    await createWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // Main window closed handler already disposes/quits.
  if (process.platform !== "darwin" && !mainWindow && !monitorWindow) {
    app.quit();
  }
});
