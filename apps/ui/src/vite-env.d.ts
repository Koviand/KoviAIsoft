/// <reference types="vite/client" />

import type { KoviApi, MonitorSnapshot } from "@kovi/shared";

/** Restricted bridge exposed to the monitor window (P1-9). */
export type KoviMonitorApi = {
  getMonitorSnapshot(): Promise<MonitorSnapshot>;
  setMonitorAlwaysOnTop(flag: boolean): Promise<boolean>;
  onMonitorUpdate(cb: (snap: MonitorSnapshot) => void): () => void;
};

declare global {
  interface Window {
    kovi?: KoviApi;
    koviMonitor?: KoviMonitorApi;
  }
}

export {};
