import type { AppSettings } from "@kovi/shared";
import {
  estimateTokens,
  truncateToTokens,
} from "../chat/contextBudget.js";
import { loadProjectMemory } from "../agent/projectMemory.js";
import { projectContextCache } from "./projectCache.js";
import { formatRetrievedSnippets } from "./retrieve.js";

export interface ContextLayer {
  /** Stable id for tests / debugging */
  id: string;
  /** Lower = higher priority (kept first when packing) */
  priority: number;
  title: string;
  content: string;
}

export interface PackedProjectContext {
  systemPrompt: string;
  layers: ContextLayer[];
  stats: {
    contextTokens: number;
    usedTokens: number;
    filesMapped: number;
    filesRetrieved: number;
    truncatedLayers: string[];
  };
}

/**
 * Pack layers into a budget like Cursor: keep high-priority layers whole,
 * shrink/drop low-priority ones.
 */
export function packLayers(layers: ContextLayer[], budgetTokens: number): {
  text: string;
  usedTokens: number;
  truncatedLayers: string[];
} {
  const sorted = [...layers]
    .filter((l) => l.content.trim())
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const kept: string[] = [];
  const truncatedLayers: string[] = [];
  let used = 0;

  for (const layer of sorted) {
    const cost = estimateTokens(layer.content) + 4;
    const remaining = budgetTokens - used;
    if (remaining < 48) {
      truncatedLayers.push(layer.id);
      continue;
    }
    if (cost <= remaining) {
      kept.push(layer.content);
      used += cost;
      continue;
    }
    // Shrink lower-priority layers; never drop priority 0–1 without trying truncate.
    if (layer.priority <= 2) {
      const piece = truncateToTokens(layer.content, remaining - 8);
      kept.push(piece);
      used += estimateTokens(piece) + 4;
      truncatedLayers.push(layer.id);
    } else {
      truncatedLayers.push(layer.id);
    }
  }

  return { text: kept.join("\n\n"), usedTokens: used, truncatedLayers };
}

export interface BuildProjectContextInput {
  settings: AppSettings;
  userQuery: string;
  baseSystem: string;
  toolBlock: string;
  contextTokens: number;
  /** Tokens reserved for completion + conversation turns */
  reserveTokens?: number;
}

/**
 * Cursor-style project context for agent/chat system prompt:
 * tools + rules + @mentions/retrieval + project map (budgeted).
 */
export async function buildProjectContext(
  input: BuildProjectContextInput,
): Promise<PackedProjectContext> {
  const ctx = Math.max(1024, input.contextTokens);
  const reserve = input.reserveTokens ?? Math.min(Math.floor(ctx * 0.4), 3200);
  const systemBudget = Math.max(600, ctx - reserve - 64);

  const projectRoot = input.settings.projectRoot;
  const projectHint =
    input.settings.fileAccessMode === "project"
      ? `Режим доступа: project. Корень: ${projectRoot || "(не задан)"}`
      : `Режим доступа: disk. Будь осторожен с записью/удалением.`;

  const layers: ContextLayer[] = [
    {
      id: "base",
      priority: 0,
      title: "base",
      content: `${input.baseSystem}\n\n${projectHint}`,
    },
    {
      id: "tools",
      priority: 1,
      title: "tools",
      content: input.toolBlock,
    },
  ];

  const memory = loadProjectMemory(projectRoot);
  if (memory) {
    layers.push({
      id: "memory",
      priority: 2,
      title: "memory",
      content: `# Память проекта (AGENTS.md)\n${memory}`,
    });
  }

  let filesRetrieved = 0;
  let filesMapped = 0;

  if (projectRoot) {
    const snippets = await projectContextCache.getRetrieved(projectRoot, input.userQuery, {
      maxFiles: ctx >= 12000 ? 8 : 5,
      maxBytesPerFile: ctx >= 12000 ? 4500 : 2800,
      maxTotalBytes: ctx >= 12000 ? 20_000 : 12_000,
    });
    filesRetrieved = snippets.length;
    const retrieved = formatRetrievedSnippets(snippets);
    if (retrieved) {
      layers.push({
        id: "retrieved",
        priority: 3,
        title: "retrieved",
        content: retrieved,
      });
    }

    try {
      const map = projectContextCache.getMap(projectRoot, {
        maxEntries: ctx >= 12000 ? 350 : 180,
        maxDepth: 5,
      });
      filesMapped = map.files.length;
      layers.push({
        id: "map",
        priority: 4,
        title: "map",
        content: map.treeText,
      });
    } catch {
      // ignore map failures
    }
  }

  layers.push({
    id: "context-policy",
    priority: 1,
    title: "policy",
    content: [
      "# Политика контекста (как в Cursor)",
      "- Ниже — сжатая карта проекта и автоподобранные фрагменты кода по запросу.",
      "- Не читай весь репозиторий подряд: пользуйся search / read_file точечно.",
      "- Пиши изменения через write_file / apply_patch; опирайся на пути из карты/фрагментов.",
      "- Если фрагмента не хватает — сначала read_file нужного пути, не выдумывай содержимое.",
    ].join("\n"),
  });

  const packed = packLayers(layers, systemBudget);
  return {
    systemPrompt: packed.text,
    layers,
    stats: {
      contextTokens: ctx,
      usedTokens: packed.usedTokens,
      filesMapped,
      filesRetrieved,
      truncatedLayers: packed.truncatedLayers,
    },
  };
}
