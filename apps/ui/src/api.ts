import type { KoviApi } from "@kovi/shared";

function mockApi(): KoviApi {
  const err = async () => {
    throw new Error("Electron bridge недоступен. Запустите через desktop app.");
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

export const api: KoviApi = typeof window !== "undefined" && window.kovi ? window.kovi : mockApi();
