import { contextBridge, ipcRenderer } from "electron";
import { IPC, type KoviApi, type MonitorSnapshot } from "@kovi/shared";

const api: KoviApi = {
  getSystemInfo: () => ipcRenderer.invoke(IPC.getSystemInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.saveSettings, settings),
  getRuntimeStatus: () => ipcRenderer.invoke(IPC.getRuntimeStatus),
  detectRuntimeAsset: (backend) => ipcRenderer.invoke(IPC.detectRuntimeAsset, backend),
  installRuntime: (backend) => ipcRenderer.invoke(IPC.installRuntime, backend),
  checkRuntimeUpdate: (backend) => ipcRenderer.invoke(IPC.checkRuntimeUpdate, backend),
  ensureLatestRuntime: (backend, force) =>
    ipcRenderer.invoke(IPC.ensureLatestRuntime, backend, force),
  listModels: () => ipcRenderer.invoke(IPC.listModels),
  scanModels: () => ipcRenderer.invoke(IPC.scanModels),
  deleteModel: (modelId) => ipcRenderer.invoke(IPC.deleteModel, modelId),
  getModelRecommendations: () => ipcRenderer.invoke(IPC.getModelRecommendations),
  suggestHardwareLoadSettings: (opts) =>
    ipcRenderer.invoke(IPC.suggestHardwareLoadSettings, opts),
  applyHardwareLoadSettings: (opts) =>
    ipcRenderer.invoke(IPC.applyHardwareLoadSettings, opts),
  applyLoadProfileToSettings: (opts) =>
    ipcRenderer.invoke(IPC.applyLoadProfileToSettings, opts),
  searchHf: (query) => ipcRenderer.invoke(IPC.searchHf, query),
  listHfFiles: (modelId) => ipcRenderer.invoke(IPC.listHfFiles, modelId),
  downloadHfFile: (modelId, filePath) =>
    ipcRenderer.invoke(IPC.downloadHfFile, modelId, filePath),
  getHfCliStatus: () => ipcRenderer.invoke(IPC.getHfCliStatus),
  ensureHfCli: () => ipcRenderer.invoke(IPC.ensureHfCli),
  loadModel: (modelId, params) => ipcRenderer.invoke(IPC.loadModel, modelId, params),
  unloadModel: () => ipcRenderer.invoke(IPC.unloadModel),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  createSession: (mode, title) => ipcRenderer.invoke(IPC.createSession, mode, title),
  updateSession: (session) => ipcRenderer.invoke(IPC.updateSession, session),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC.deleteSession, sessionId),
  getMessages: (sessionId) => ipcRenderer.invoke(IPC.getMessages, sessionId),
  sendChat: (req) => ipcRenderer.invoke(IPC.sendChat, req),
  sendMessage: (req) => ipcRenderer.invoke(IPC.sendMessage, req),
  stopGeneration: () => ipcRenderer.invoke(IPC.stopGeneration),
  startAgent: (req) => ipcRenderer.invoke(IPC.startAgent, req),
  resolveConfirmation: (req) => ipcRenderer.invoke(IPC.resolveConfirmation, req),
  cancelAgent: () => ipcRenderer.invoke(IPC.cancelAgent),
  pickDirectory: () => ipcRenderer.invoke(IPC.pickDirectory),
  pickFile: (filters) => ipcRenderer.invoke(IPC.pickFile, filters),
  getStatusBar: () => ipcRenderer.invoke(IPC.getStatusBar),
  getMonitorSnapshot: () => ipcRenderer.invoke(IPC.getMonitorSnapshot),
  openMonitorWindow: () => ipcRenderer.invoke(IPC.openMonitorWindow),
  setMonitorAlwaysOnTop: (flag) => ipcRenderer.invoke(IPC.setMonitorAlwaysOnTop, flag),
  exportSession: (sessionId) => ipcRenderer.invoke(IPC.exportSession, sessionId),
  importSession: (bundle) => ipcRenderer.invoke(IPC.importSession, bundle),
  getErrorLog: () => ipcRenderer.invoke(IPC.getErrorLog),
  checkMcpHealth: (server) => ipcRenderer.invoke(IPC.checkMcpHealth, server),
  verifyGguf: (modelId) => ipcRenderer.invoke(IPC.verifyGguf, modelId),
  previewFileDiff: (filePath, content) =>
    ipcRenderer.invoke(IPC.previewFileDiff, filePath, content),
  getCodebaseIndexStatus: () => ipcRenderer.invoke(IPC.getCodebaseIndexStatus),
  reindexCodebase: () => ipcRenderer.invoke(IPC.reindexCodebase),
  listEmbeddingModels: () => ipcRenderer.invoke(IPC.listEmbeddingModels),
  getEmbeddingStatus: () => ipcRenderer.invoke(IPC.getEmbeddingStatus),
  downloadEmbeddingModel: (id) => ipcRenderer.invoke(IPC.downloadEmbeddingModel, id),
  setEmbeddingModel: (id) => ipcRenderer.invoke(IPC.setEmbeddingModel, id),
  onRuntimeProgress: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, p: { progress: number; label: string }) =>
      cb(p);
    ipcRenderer.on(IPC.runtimeProgress, listener);
    return () => ipcRenderer.removeListener(IPC.runtimeProgress, listener);
  },
  onDownloadProgress: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, p: { progress: number; label: string }) =>
      cb(p);
    ipcRenderer.on(IPC.downloadProgress, listener);
    return () => ipcRenderer.removeListener(IPC.downloadProgress, listener);
  },
  onChatToken: (cb) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      p: { sessionId: string; text: string; thinking?: boolean },
    ) => cb(p);
    ipcRenderer.on(IPC.chatToken, listener);
    return () => ipcRenderer.removeListener(IPC.chatToken, listener);
  },
  onAgentEvent: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, p: unknown) =>
      cb(p as { sessionId: string; event: import("@kovi/shared").AgentEvent });
    ipcRenderer.on(IPC.agentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener);
  },
  onMonitorUpdate: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, p: MonitorSnapshot) => cb(p);
    ipcRenderer.on(IPC.monitorUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.monitorUpdate, listener);
  },
};

contextBridge.exposeInMainWorld("kovi", api);
