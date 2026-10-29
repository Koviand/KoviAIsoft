import type { KoviApi } from "@kovi/shared";

export const isElectronBridge =
  typeof window !== "undefined" && typeof window.kovi !== "undefined";

function mockApi(): KoviApi {
  const err = async () => {
    throw new Error("Electron bridge недоступен. Запустите через desktop app (`pnpm dev:desktop`).");
  };
  return new Proxy({} as KoviApi, {
    get: (_t, prop) => {
      if (
        prop === "onRuntimeProgress" ||
        prop === "onDownloadProgress" ||
        prop === "onChatToken" ||
        prop === "onAgentEvent" ||
        prop === "onMonitorUpdate"
      ) {
        return () => () => undefined;
      }
      return err;
    },
  });
}

export const api: KoviApi = isElectronBridge ? window.kovi! : mockApi();
