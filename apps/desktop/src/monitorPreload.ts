import { contextBridge, ipcRenderer } from "electron";
import { IPC, type MonitorSnapshot } from "@kovi/shared";

/** Restricted API for the monitor window — no sendMessage/settings/etc. (P1-9). */
const monitorApi = {
  getMonitorSnapshot: () => ipcRenderer.invoke(IPC.getMonitorSnapshot),
  setMonitorAlwaysOnTop: (flag: boolean) =>
    ipcRenderer.invoke(IPC.setMonitorAlwaysOnTop, flag),
  onMonitorUpdate: (cb: (snap: MonitorSnapshot) => void) => {
    const listener = (_: Electron.IpcRendererEvent, p: MonitorSnapshot) => cb(p);
    ipcRenderer.on(IPC.monitorUpdate, listener);
    return () => ipcRenderer.removeListener(IPC.monitorUpdate, listener);
  },
};

contextBridge.exposeInMainWorld("koviMonitor", monitorApi);
contextBridge.exposeInMainWorld("kovi", {
  getMonitorSnapshot: monitorApi.getMonitorSnapshot,
  setMonitorAlwaysOnTop: monitorApi.setMonitorAlwaysOnTop,
  onMonitorUpdate: monitorApi.onMonitorUpdate,
});
