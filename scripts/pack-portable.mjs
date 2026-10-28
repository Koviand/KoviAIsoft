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
}

function stagePackageJson() {
  writeJson(path.join(stage, "package.json"), {
    name: "kovi-ai-soft",
    version: "0.1.0",
    private: true,
    main: "dist/main.js",
    description: "KoviAIsoft portable",
    author: "Kovi",
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.6.1",
      "extract-zip": "^2.0.1",
      playwright: "^1.50.1",
      uuid: "^11.0.5",
      zod: "^3.24.1",
    },
    devDependencies: {
      electron: "^34.0.1",
      "electron-builder": "^25.1.8",
    },
    build: {
      appId: "com.kovi.aichat",
      productName: "KoviAIsoft",
      copyright: "Copyright © Kovi",
      directories: {
        output: path.join(outDir, "builder-out"),
        app: stage,
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
      ],
      win: {
        target: [
          { target: "dir", arch: ["x64"] },
          { target: "portable", arch: ["x64"] },
        ],
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
  // Use npm in stage for a classic flat node_modules electron-builder understands.
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], stage);
  // electron + electron-builder as local tools for packaging
  run(
    "npm",
    [
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts=false",
      "electron@34.0.1",
      "electron-builder@25.1.8",
    ],
    stage,
  );
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

  console.log("\nPortable app ready:");
  console.log(`  ${portableDir}`);
  console.log(`  EXE: ${path.join(portableDir, "KoviAIsoft.exe")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
