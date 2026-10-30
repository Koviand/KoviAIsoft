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
    // pnpm lock v9: packages["/@scope/name@version"] — fall back to desktop package.json
    void lock;
  } catch {
    // ignore
  }
  try {
    const desktopPkg = JSON.parse(
      fs.readFileSync(path.join(desktop, "package.json"), "utf8"),
    );
    const fromDev = desktopPkg.devDependencies?.[pkgName];
    const fromDep = desktopPkg.dependencies?.[pkgName];
    const raw = fromDev || fromDep;
    if (typeof raw === "string") return raw.replace(/^\^/, "");
  } catch {
    // ignore
  }
  const fallback = {
    electron: "34.0.1",
    "electron-builder": "25.1.8",
    playwright: "1.50.1",
    "@modelcontextprotocol/sdk": "1.6.1",
  };
  return fallback[pkgName] || "0.0.0";
}

function stagePackageJson() {
  const electronVer = resolveLockedVersion("electron");
  const builderVer = resolveLockedVersion("electron-builder");
  const playwrightVer = resolveLockedVersion("playwright");
  const mcpVer = resolveLockedVersion("@modelcontextprotocol/sdk");
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  writeJson(path.join(stage, "package.json"), {
    name: "kovi-ai-soft",
    version: rootPkg.version || "0.1.0",
    private: true,
    main: "dist/main.js",
    description: "KoviAIsoft portable",
    author: "Kovi",
    dependencies: {
      "@modelcontextprotocol/sdk": mcpVer,
      "extract-zip": "2.0.1",
      playwright: playwrightVer,
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
      asarUnpack: ["**/node_modules/playwright/**", "**/node_modules/playwright-core/**"],
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
        ],
        icon: path.join(root, "apps", "desktop", "build", "icon.png"),
        artifactName: "KoviAIsoft-${version}-portable.${ext}",
        signAndEditExecutable: false,
      },
      portable: {
        artifactName: "KoviAIsoft-${version}-portable.${ext}",
      },
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
    },
  });
}

function installStageDeps() {
  const electronVer = resolveLockedVersion("electron");
  const builderVer = resolveLockedVersion("electron-builder");
  // Prefer mirror when registry.npmjs.org is flaky (ECONNRESET on some networks).
  const npmEnv = {
    ...process.env,
    npm_config_registry: process.env.npm_config_registry || "https://registry.npmmirror.com",
  };
  delete npmEnv.npm_config_shamefully_hoist;
  // Use npm in stage for a classic flat node_modules electron-builder understands.
  const res1 = spawnSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--fetch-retries=5"],
    { cwd: stage, stdio: "inherit", shell: process.platform === "win32", env: npmEnv },
  );
  if (res1.status !== 0) {
    throw new Error(`npm install deps failed (${res1.status})`);
  }
  const res2 = spawnSync(
    "npm",
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
    { cwd: stage, stdio: "inherit", shell: process.platform === "win32", env: npmEnv },
  );
  if (res2.status !== 0) {
    throw new Error(`npm install electron-builder failed (${res2.status})`);
  }
  // Ensure Electron binary is actually downloaded (npm may skip scripts).
  run("node", ["node_modules/electron/install.js"], stage);
}

function buildElectron() {
  // Reads the "build" field from package.json by default.
  run("npx", ["electron-builder", "--win", "dir", "portable", "--x64"], stage);
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
  rmrf(stage);
  mkdirp(stage);
  stagePackageJson();
  await bundleMain();
  installStageDeps();
  buildElectron();
  assemblePortableFolder();
  await preseedHfCli();

  console.log("\nPortable app ready:");
  console.log(`  ${portableDir}`);
  console.log(`  EXE: ${path.join(portableDir, "KoviAIsoft.exe")}`);
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
