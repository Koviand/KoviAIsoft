/// <reference types="vite/client" />

import type { KoviApi } from "@kovi/shared";

declare global {
  interface Window {
    kovi?: KoviApi;
  }
}

export {};
