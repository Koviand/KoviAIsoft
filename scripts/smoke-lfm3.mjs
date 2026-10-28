import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scanLocalModels } = require("../packages/core/dist/models/scanner.js");
const { pickBackend, detectSystemInfo } = require("../packages/core/dist/system/detect.js");
const { fetchLatestRuntimeAsset } = require("../packages/core/dist/runtime/assets.js");

const root = "C:\\Models\\LFM";
const models = scanLocalModels([root]);
const lfm3 = models.filter((m) => /lfm3/i.test(m.name) || /lfm3/i.test(m.path));
const sys = await detectSystemInfo("auto");
const backend = pickBackend(sys);
const asset = await fetchLatestRuntimeAsset(backend, sys.cudaVersion, 11960);

console.log(
  JSON.stringify(
    {
      modelsFound: models.length,
      lfm3: lfm3.map((m) => ({ name: m.name, quant: m.quant, sizeGb: +(m.sizeBytes / 1024 ** 3).toFixed(2) })),
      recommendedBackend: backend,
      runtimeAsset: { tag: asset.tag, asset: asset.assetName, cudart: asset.cudartAssetName || null },
      appExists:
        fs.existsSync(path.join(root, "KoviAIsoft", "package.json")) ||
        fs.existsSync(path.join(root, "KoviAiChat", "package.json")),
    },
    null,
    2,
  ),
);

if (!lfm3.length) {
  console.warn("LFM3 GGUF не найден в C:\\Models\\LFM — сканер работает, модель можно скачать из UI.");
}
