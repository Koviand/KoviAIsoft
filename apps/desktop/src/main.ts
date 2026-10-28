import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { IPC } from "@kovi/shared";
import { AppService, setAppDataDir } from "@kovi/core";

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

function portableRoot(): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, "..");
}

function configurePortablePaths(): void {
  const root = portableRoot();
  const dataDir = path.join(root, "data");
  setAppDataDir(dataDir);
  app.setPath("userData", dataDir);

  const browsers = path.join(root, "playwright-browsers");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
}

function uiPath(): string {
  if (!app.isPackaged) {
    return process.env.KOVI_UI_URL || "http://127.0.0.1:5173";
  }
  return path.join(process.resourcesPath, "ui", "index.html");
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
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
      sandbox: false,
      webSecurity: true,
    },
  });
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
  if (monitorWindow && !monitorWindow.isDestroyed()) {
    monitorWindow.focus();
    return;
  }

  const icon = appIconPath();
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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Register before load so we never miss the first ready-to-show.
  monitorWindow.once("ready-to-show", () => {
    if (monitorWindow && !monitorWindow.isDestroyed()) monitorWindow.show();
  });
  monitorWindow.on("closed", () => {
    monitorWindow = null;
    stopMonitorPush();
  });
  await loadUi(monitorWindow, "#/monitor");
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
  ipcMain.handle(IPC.getSettings, () => svc.getSettings());
  ipcMain.handle(IPC.saveSettings, (_e, settings) => svc.saveSettings(settings));
  ipcMain.handle(IPC.getRuntimeStatus, () => svc.getRuntimeStatus());
  ipcMain.handle(IPC.detectRuntimeAsset, (_e, backend) => svc.detectRuntimeAsset(backend));
  ipcMain.handle(IPC.installRuntime, (_e, backend) => svc.installRuntime(backend));
  ipcMain.handle(IPC.checkRuntimeUpdate, (_e, backend) => svc.checkRuntimeUpdate(backend));
  ipcMain.handle(IPC.ensureLatestRuntime, (_e, backend, force) =>
    svc.ensureLatestRuntime(backend, { force: Boolean(force) }),
  );
  ipcMain.handle(IPC.listModels, () => svc.listModels());
  ipcMain.handle(IPC.scanModels, () => svc.scanModels());
  ipcMain.handle(IPC.searchHf, (_e, query) => svc.searchHf(query));
  ipcMain.handle(IPC.listHfFiles, (_e, modelId) => svc.listHfFiles(modelId));
  ipcMain.handle(IPC.downloadHfFile, (_e, modelId, filePath) =>
    svc.downloadHf(modelId, filePath),
  );
  ipcMain.handle(IPC.loadModel, (_e, modelId, params) => svc.loadModel(modelId, params));
  ipcMain.handle(IPC.unloadModel, () => svc.unloadModel());
  ipcMain.handle(IPC.listSessions, () => svc.listSessions());
  ipcMain.handle(IPC.createSession, (_e, mode, title) => svc.createSession(mode, title));
  ipcMain.handle(IPC.updateSession, (_e, session) => svc.updateSession(session));
  ipcMain.handle(IPC.deleteSession, (_e, sessionId) => svc.deleteSession(sessionId));
  ipcMain.handle(IPC.getMessages, (_e, sessionId) => svc.getMessages(sessionId));
  ipcMain.handle(IPC.sendChat, (_e, req) =>
    svc.sendChat(req.sessionId, req.content, req.params),
  );
  ipcMain.handle(IPC.sendMessage, async (_e, req) => {
    if (req.useAgent) {
      void svc
        .sendMessage(req.sessionId, req.content, {
          useAgent: true,
          params: req.params,
        })
        .catch((err) => {
          broadcast(IPC.agentEvent, {
            sessionId: req.sessionId,
            event: {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        });
      return;
    }
    return svc.sendMessage(req.sessionId, req.content, {
      useAgent: false,
      params: req.params,
    });
  });
  ipcMain.handle(IPC.stopGeneration, () => svc.stopGeneration());
  ipcMain.handle(IPC.startAgent, async (_e, req) => {
    void svc.startAgent(req.sessionId, req.content).catch((err) => {
      broadcast(IPC.agentEvent, {
        sessionId: req.sessionId,
        event: {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
  });
  ipcMain.handle(IPC.resolveConfirmation, (_e, req) =>
    svc.resolveConfirmation(req.confirmationId, req.approved, req.rememberForSession),
  );
  ipcMain.handle(IPC.cancelAgent, () => svc.cancelAgent());
  ipcMain.handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
    });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  ipcMain.handle(IPC.pickFile, async (_e, filters) => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: filters || [{ name: "All", extensions: ["*"] }],
    });
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
  ipcMain.handle(IPC.importSession, (_e, bundle) => svc.importSession(bundle));
  ipcMain.handle(IPC.getErrorLog, () => svc.getErrorLog());
  ipcMain.handle(IPC.checkMcpHealth, (_e, server) => svc.checkMcpHealth(server));
  ipcMain.handle(IPC.verifyGguf, (_e, modelId: string) => svc.verifyGguf(modelId));
  ipcMain.handle(IPC.previewFileDiff, (_e, filePath: string, content: string) =>
    svc.previewFileDiff(filePath, content),
  );

  svc.onRuntimeProgress = (p) => broadcast(IPC.runtimeProgress, p);
  svc.onDownloadProgress = (p) => broadcast(IPC.downloadProgress, p);
  svc.onChatToken = (p) => broadcast(IPC.chatToken, p);
  svc.onAgentEvent = (p) => broadcast(IPC.agentEvent, p);
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
    configurePortablePaths();
    service = new AppService();
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
