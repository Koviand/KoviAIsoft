import type { CodebaseIndexStatus } from "@kovi/shared";
import {
  ensureProjectIndex,
  getCodebaseIndexStatus,
  reindexCodebase,
} from "../context/semanticIndex.js";

export type ProgressSink = (p: { progress: number; label: string }) => void;

/** Thin facade so AppService does not own index lifecycle details. */
export async function reindexProjectCodebase(
  projectRoot: string | null,
  onProgress?: ProgressSink,
): Promise<CodebaseIndexStatus> {
  if (!projectRoot) {
    return {
      ready: false,
      indexing: false,
      root: null,
      chunkCount: 0,
      modelId: "",
      updatedAt: null,
      error: "Сначала укажите папку проекта в настройках",
    };
  }
  onProgress?.({ progress: 5, label: "Индексация @codebase…" });
  try {
    const status = await reindexCodebase(projectRoot, (msg) => {
      onProgress?.({ progress: 40, label: msg });
    });
    onProgress?.({
      progress: 100,
      label: status.error
        ? `Индекс: ${status.error}`
        : `Индекс готов · ${status.chunkCount} чанков`,
    });
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ progress: 100, label: `Индекс: ${message}` });
    return {
      ready: false,
      indexing: false,
      root: projectRoot,
      chunkCount: 0,
      modelId: "",
      updatedAt: null,
      error: message,
    };
  }
}

export function readCodebaseIndexStatus(projectRoot: string | null): CodebaseIndexStatus {
  return getCodebaseIndexStatus(projectRoot);
}

export function warmProjectCodebaseIndex(projectRoot: string | null): void {
  if (!projectRoot) return;
  void ensureProjectIndex(projectRoot).catch(() => undefined);
}
