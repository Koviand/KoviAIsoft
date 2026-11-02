/**
 * Builds a portable Windows folder:
 *   release/KoviAIsoft-Portable/
 *     KoviAIsoft.exe
 *     resources/...
 *     data/                 (created on first run)
 *     playwright-browsers/  (optional, if install succeeds)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps", "desktop");
const stage = path.join(desktop, "pack-stage");
const outDir = path.join(root, "release");
const portableDir = path.join(outDir, "KoviAIsoft-Portable");

function run(cmd, args, cwd = root) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}`);
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dest) {
  mkdirp(dest);
  fs.cpSync(src, dest, { recursive: true });
}

function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

async function bundleMain() {
  const dist = path.join(stage, "dist");
  mkdirp(dist);

  await esbuild.build({
    entryPoints: [path.join(desktop, "src", "main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(dist, "main.js"),
    external: [
      "electron",
      "playwright",
      "playwright-core",
      "chromium-bidi",
      "@modelcontextprotocol/sdk",
      "@modelcontextprotocol/sdk/*",
      // Native ONNX bindings — must stay outside the esbuild bundle.
      "@huggingface/transformers",
      "onnxruntime-node",
      "sharp",
    ],
    plugins: [
      {
        name: "external-native-node",
        setup(build) {
          build.onResolve({ filter: /\.node$/ }, (args) => ({
            path: args.path,
            external: true,
          }));
        },
      },
    ],
    sourcemap: false,
    logLevel: "info",
  });

  await esbuild.build({
    entryPoints: [path.join(desktop, "src", "preload.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(dist, "preload.js"),
    external: ["electron"],
    sourcemap: false,
    logLevel: "info",
  });

  await esbuild.build({
    entryPoints: [path.join(desktop, "src", "monitorPreload.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(dist, "monitorPreload.js"),
    external: ["electron"],
    sourcemap: false,
    logLevel: "info",
  });
}

function resolveLockedVersion(pkgName) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
    // pnpm lock v9: packages["/@scope/name@version"] — fall back to package.json
    void lock;
  } catch {
    // ignore
  }
  const pkgFiles = [
    path.join(desktop, "package.json"),
    path.join(root, "packages", "core", "package.json"),
    path.join(root, "package.json"),
  ];
  for (const file of pkgFiles) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      const raw = pkg.devDependencies?.[pkgName] || pkg.dependencies?.[pkgName];
      if (typeof raw === "string") return raw.replace(/^\^/, "");
    } catch {
      // try next
    }
  }
  try {
    const resolved = path.join(root, "node_modules", ...pkgName.split("/"), "package.json");
    const installed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (typeof installed.version === "string") return installed.version;
  } catch {
    // ignore
  }
  const fallback = {
    electron: "34.0.1",
    "electron-builder": "25.1.8",
    playwright: "1.50.1",
    "@modelcontextprotocol/sdk": "1.6.1",
    "@huggingface/transformers": "3.8.1",
  };
  return fallback[pkgName] || "0.0.0";
}

function stagePackageJson() {
  const electronVer = resolveLockedVersion("electron");
  const builderVer = resolveLockedVersion("electron-builder");
  const playwrightVer = resolveLockedVersion("playwright");
  const mcpVer = resolveLockedVersion("@modelcontextprotocol/sdk");
  const transformersVer = resolveLockedVersion("@huggingface/transformers");
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  writeJson(path.join(stage, "package.json"), {
    name: "kovi-ai-soft",
    version: rootPkg.version || "0.1.0",
    private: true,
    main: "dist/main.js",
    description: "KoviAIsoft portable",
    author: "Kovi",
    dependencies: {
      "@huggingface/transformers": transformersVer,
      "@modelcontextprotocol/sdk": mcpVer,
      "extract-zip": "2.0.1",
      "onnxruntime-node":
        resolveLockedVersion("onnxruntime-node") !== "0.0.0"
          ? resolveLockedVersion("onnxruntime-node")
          : "1.21.0",
      playwright: playwrightVer,
      // Required by @huggingface/transformers; must be real deps + asarUnpack.
      sharp:
        resolveLockedVersion("sharp") !== "0.0.0"
          ? resolveLockedVersion("sharp")
          : "0.33.5",
      uuid: "11.0.5",
      zod: "3.24.1",
    },
    devDependencies: {
      electron: electronVer,
      "electron-builder": builderVer,
    },
    build: {
      appId: "com.kovi.aisoft",
      productName: "KoviAIsoft",
      copyright: "Copyright © Kovi",
      directories: {
        output: path.join(outDir, "builder-out"),
        app: stage,
        buildResources: path.join(root, "apps", "desktop", "build"),
      },
      files: [
        "dist/**/*",
        "package.json",
        "node_modules/**/*",
        "!node_modules/**/{CHANGELOG.md,README.md,readme.md,*.map}",
        "!node_modules/.cache/**",
        "!**/node_modules/*/{test,tests,__tests__}/**",
      ],
      asar: true,
      asarUnpack: [
        "**/node_modules/playwright/**",
        "**/node_modules/playwright-core/**",
        "**/node_modules/onnxruntime-node/**",
        "**/node_modules/@huggingface/transformers/**",
        "**/node_modules/sharp/**",
        "**/node_modules/@img/**",
      ],
      extraResources: [
        {
          from: path.join(root, "apps", "ui", "dist"),
          to: "ui",
        },
        {
          from: path.join(root, "apps", "desktop", "build", "icon.png"),
          to: "icon.png",
        },
      ],
      win: {
        target: [
          { target: "dir", arch: ["x64"] },
          { target: "portable", arch: ["x64"] },
          { target: "nsis", arch: ["x64"] },
        ],
        icon: path.join(root, "apps", "desktop", "build", "icon.png"),
        // Default for non-nsis targets; nsis overrides via nsis.artifactName.
        artifactName: "KoviAIsoft-${version}-portable.${ext}",
        signAndEditExecutable: false,
      },
      portable: {
        artifactName: "KoviAIsoft-${version}-portable.${ext}",
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "KoviAIsoft",
        artifactName: "KoviAIsoft-Setup-${version}.${ext}",
      },
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
    },
  });
}

function npmInstallWithFallback(args, label) {
  const registries = [
    process.env.npm_config_registry,
    "https://registry.npmjs.org",
    "https://registry.npmmirror.com",
  ].filter(Boolean);
  const unique = [...new Set(registries)];
  let lastStatus = 1;
  for (const registry of unique) {
    const npmEnv = { ...process.env, npm_config_registry: registry };
    delete npmEnv.npm_config_shamefully_hoist;
    console.log(`[pack] ${label} via ${registry}`);
    const res = spawnSync("npm", args, {
      cwd: stage,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: npmEnv,
      timeout: 10 * 60 * 1000,
    });
    lastStatus = res.status ?? 1;
    if (lastStatus === 0) return;
    console.warn(`[pack] ${label} failed (${lastStatus}) at ${registry}, trying next…`);
  }
  throw new Error(`${label} failed (${lastStatus})`);
}

function installStageDeps() {
  const electronVer = resolveLockedVersion("electron");
  const builderVer = resolveLockedVersion("electron-builder");
  if (fs.existsSync(path.join(stage, "node_modules"))) {
    console.log("[pack] refreshing existing pack-stage/node_modules");
  }
  npmInstallWithFallback(
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--fetch-retries=5"],
    "npm install deps",
  );
  npmInstallWithFallback(
    [
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts=false",
      "--fetch-retries=5",
      `electron@${electronVer}`,
      `electron-builder@${builderVer}`,
    ],
    "npm install electron-builder",
  );
  // Ensure Electron binary is actually downloaded (npm may skip scripts).
  run("node", ["node_modules/electron/install.js"], stage);
}

function buildElectron() {
  // Reads the "build" field from package.json by default.
  run("npx", ["electron-builder", "--win", "dir", "portable", "nsis", "--x64"], stage);
}

function copySetupInstaller() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = rootPkg.version || "0.1.0";
  const setupName = `KoviAIsoft-Setup-${version}.exe`;
  const builderOut = path.join(outDir, "builder-out");
  const candidates = [
    path.join(builderOut, setupName),
    // electron-builder may nest under win-unpacked sibling
    ...fs.existsSync(builderOut)
      ? fs
          .readdirSync(builderOut)
          .filter((f) => /^KoviAIsoft-Setup-.*\.exe$/i.test(f))
          .map((f) => path.join(builderOut, f))
      : [],
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) {
    console.warn(`[pack] NSIS Setup EXE not found in ${builderOut}`);
    return null;
  }
  const dest = path.join(outDir, path.basename(src));
  fs.copyFileSync(src, dest);
  console.log(`[pack] Setup installer: ${dest}`);
  return dest;
}

function assemblePortableFolder() {
  const unpacked = path.join(outDir, "builder-out", "win-unpacked");
  if (!fs.existsSync(unpacked)) {
    throw new Error(`Unpacked app not found: ${unpacked}`);
  }
  // Best-effort: stop a running portable instance that locks the folder on Windows.
  // WARNING: kills KoviAIsoft.exe globally — close the app before pack if you need its locks.
  console.warn("[pack] taskkill KoviAIsoft.exe (if running) to unlock release folder…");
  spawnSync("taskkill", ["/IM", "KoviAIsoft.exe", "/F"], {
    stdio: "ignore",
    shell: true,
  });

  // Preserve user data / browsers across rebuilds.
  const dataBackup = path.join(outDir, "_portable-data-backup");
  const browsersBackup = path.join(outDir, "_portable-browsers-backup");
  const existingData = path.join(portableDir, "data");
  const existingBrowsers = path.join(portableDir, "playwright-browsers");
  try {
    if (fs.existsSync(existingData)) {
      rmrf(dataBackup);
      copyDir(existingData, dataBackup);
      console.log("Preserved portable data/ for restore after pack");
    }
    if (fs.existsSync(existingBrowsers)) {
      rmrf(browsersBackup);
      copyDir(existingBrowsers, browsersBackup);
      console.log("Preserved portable playwright-browsers/ for restore after pack");
    }
  } catch (err) {
    console.warn("Could not backup portable data:", err);
  }

  try {
    rmrf(portableDir);
  } catch (err) {
    const alt = `${portableDir}-${Date.now()}`;
    console.warn(`Cannot replace ${portableDir} (file locked). Writing to ${alt}`);
    copyDir(unpacked, alt);
    mkdirp(path.join(alt, "data"));
    mkdirp(path.join(alt, "playwright-browsers"));
    if (fs.existsSync(dataBackup)) {
      copyDir(dataBackup, path.join(alt, "data"));
      rmrf(dataBackup);
    }
    if (fs.existsSync(browsersBackup)) {
      copyDir(browsersBackup, path.join(alt, "playwright-browsers"));
      rmrf(browsersBackup);
    }
    fs.writeFileSync(
      path.join(alt, ".kovi-portable"),
      "KoviAIsoft portable layout\n",
      "utf8",
    );
    console.log(`\nPortable app ready (alternate path):\n  ${alt}`);
    return;
  }
  copyDir(unpacked, portableDir);
  mkdirp(path.join(portableDir, "data"));
  mkdirp(path.join(portableDir, "playwright-browsers"));
  if (fs.existsSync(dataBackup)) {
    copyDir(dataBackup, path.join(portableDir, "data"));
    rmrf(dataBackup);
  }
  if (fs.existsSync(browsersBackup)) {
    copyDir(browsersBackup, path.join(portableDir, "playwright-browsers"));
    rmrf(browsersBackup);
  }

  // Install Chromium into portable folder (best-effort).
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(portableDir, "playwright-browsers");
  const pw = spawnSync(
    "npx",
    ["playwright", "install", "chromium"],
    {
      cwd: stage,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(portableDir, "playwright-browsers"),
      },
    },
  );
  if (pw.status !== 0) {
    console.warn("Playwright Chromium install failed — browser tools may need first-run download.");
  }

  // Marker so main.ts keeps data/ next to EXE (not AppData).
  fs.writeFileSync(
    path.join(portableDir, ".kovi-portable"),
    "KoviAIsoft portable layout\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(portableDir, "README-PORTABLE.txt"),
    [
      "KoviAIsoft Portable",
      "===================",
      "",
      "Запуск: KoviAIsoft.exe",
      "",
      "Папку можно копировать целиком на другой Windows x64 ПК.",
      "Данные приложения: .\\data\\",
      "llama.cpp runtime скачивается в: .\\data\\runtimes\\",
      "Модели по умолчанию сканируются из C:\\Models\\LFM (настраивается в UI).",
      "Браузер для агента: .\\playwright-browsers\\",
      "",
      "Установщик (NSIS Setup): release\\KoviAIsoft-Setup-*.exe",
      "Один файл portable EXE также лежит в release\\builder-out\\",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

async function main() {
  console.log("Building packages...");
  run("pnpm", ["build"]);

  console.log("Preparing stage...");
  // Preserve node_modules across packs — npm install is the slow/flaky step.
  const preservedNm = path.join(outDir, "_pack-stage-node_modules");
  const stageNm = path.join(stage, "node_modules");
  try {
    if (fs.existsSync(stageNm)) {
      rmrf(preservedNm);
      fs.renameSync(stageNm, preservedNm);
      console.log("[pack] parked node_modules for reuse");
    }
  } catch (err) {
    console.warn("[pack] could not park node_modules:", err);
  }
  rmrf(stage);
  mkdirp(stage);
  try {
    if (fs.existsSync(preservedNm)) {
      fs.renameSync(preservedNm, stageNm);
      console.log("[pack] restored node_modules into stage");
    }
  } catch (err) {
    console.warn("[pack] could not restore node_modules:", err);
  }
  stagePackageJson();
  await bundleMain();
  installStageDeps();
  buildElectron();
  const setupPath = copySetupInstaller();
  assemblePortableFolder();
  await preseedHfCli();

  console.log("\nPortable app ready:");
  console.log(`  ${portableDir}`);
  console.log(`  EXE: ${path.join(portableDir, "KoviAIsoft.exe")}`);
  if (setupPath) {
    console.log("\nSetup installer ready:");
    console.log(`  ${setupPath}`);
  }
}

/** Install portable HF CLI into release/.../tools/hf so users don't need pip. */
async function preseedHfCli() {
  console.log("Preseeding bundled HF CLI into portable tools/hf…");
  const dataDir = path.join(portableDir, "data");
  mkdirp(dataDir);
  process.env.KOVI_DATA_DIR = dataDir;
  try {
    const { pathToFileURL } = await import("node:url");
    const modUrl = pathToFileURL(
      path.join(root, "packages", "core", "dist", "models", "hfBundle.js"),
    ).href;
    const { ensureBundledHfCli } = await import(modUrl);
    await ensureBundledHfCli({
      onProgress: (p, label) => console.log(`  [hf ${p}%] ${label}`),
    });
    console.log("HF CLI preseed OK:", path.join(portableDir, "tools", "hf"));
  } catch (err) {
    console.warn(
      "HF CLI preseed failed (will install on first download):",
      err instanceof Error ? err.message : err,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
