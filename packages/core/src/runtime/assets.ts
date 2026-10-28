import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { RuntimeAsset, RuntimeBackend } from "@kovi/shared";

interface GhAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  digest?: string;
}

interface GhRelease {
  tag_name: string;
  prerelease?: boolean;
  draft?: boolean;
  assets: GhAsset[];
}

interface CacheFile {
  fetchedAt: number;
  releases: GhRelease[];
}

let memoryCache: CacheFile | null = null;
let githubToken: string | undefined;
let cacheDir: string | null = null;

const MEMORY_TTL_MS = 30 * 60 * 1000;
const DISK_TTL_MS = 6 * 60 * 60 * 1000;

export function configureRuntimeAssetFetcher(opts: {
  cacheDir?: string;
  githubToken?: string;
}): void {
  if (opts.cacheDir) cacheDir = opts.cacheDir;
  githubToken = opts.githubToken || process.env.GITHUB_TOKEN || undefined;
}

function digestToSha(digest?: string): string | undefined {
  if (!digest) return undefined;
  const m = digest.match(/sha256:([a-f0-9]{64})/i);
  return m?.[1]?.toLowerCase();
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "KoviAIsoft",
  };
  const token = githubToken || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function cachePath(): string | null {
  if (!cacheDir) return null;
  return path.join(cacheDir, "github-releases-cache.json");
}

async function readDiskCache(): Promise<CacheFile | null> {
  const p = cachePath();
  if (!p) return null;
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function writeDiskCache(cache: CacheFile): Promise<void> {
  const p = cachePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(cache), "utf8");
  } catch {
    // ignore
  }
}

function pickCudaAsset(
  tag: string,
  assets: GhAsset[],
  cudaVersion?: string,
): { main?: GhAsset; cudart?: GhAsset } {
  const cudaAssets = assets.filter((a) => /^llama-.*-bin-win-cuda-[\d.]+-x64\.zip$/i.test(a.name));
  if (cudaAssets.length === 0) return {};

  const prefer13 = Boolean(cudaVersion && Number(cudaVersion.split(".")[0]) >= 13);
  const sorted = [...cudaAssets].sort((a, b) => {
    const va = a.name.includes("cuda-13") ? 13 : 12;
    const vb = b.name.includes("cuda-13") ? 13 : 12;
    if (prefer13) return vb - va;
    return va - vb;
  });
  const main = sorted[0];
  const verMatch = main.name.match(/cuda-([\d.]+)/i);
  const ver = verMatch?.[1];
  const cudart = assets.find((a) =>
    ver
      ? a.name.toLowerCase() === `cudart-llama-bin-win-cuda-${ver}-x64.zip`
      : /^cudart-llama-bin-win-cuda-[\d.]+-x64\.zip$/i.test(a.name),
  );
  return { main, cudart };
}

export function selectAssetFromRelease(
  release: GhRelease,
  backend: RuntimeBackend,
  cudaVersion?: string,
): RuntimeAsset | null {
  const tag = release.tag_name;
  const assets = release.assets || [];

  if (backend === "cuda") {
    const { main, cudart } = pickCudaAsset(tag, assets, cudaVersion);
    if (!main) return null;
    return {
      tag,
      backend,
      assetName: main.name,
      url: main.browser_download_url,
      size: main.size,
      sha256: digestToSha(main.digest),
      cudartAssetName: cudart?.name,
      cudartUrl: cudart?.browser_download_url,
      cudartSize: cudart?.size,
      cudartSha256: digestToSha(cudart?.digest),
    };
  }

  const pattern =
    backend === "vulkan"
      ? /^llama-.*-bin-win-vulkan-x64\.zip$/i
      : /^llama-.*-bin-win-cpu-x64\.zip$/i;
  const main = assets.find((a) => pattern.test(a.name));
  if (!main) return null;
  return {
    tag,
    backend,
    assetName: main.name,
    url: main.browser_download_url,
    size: main.size,
    sha256: digestToSha(main.digest),
  };
}

export function parseBuildNumber(tag: string): number {
  const m = tag.match(/^b(\d+)$/i);
  return m ? Number(m[1]) : 0;
}

function pickFromReleases(
  releases: GhRelease[],
  backend: RuntimeBackend,
  cudaVersion?: string,
  minBuild = 11960,
): RuntimeAsset | null {
  const ranked = releases
    .filter((r) => !r.draft)
    .map((r) => ({ release: r, build: parseBuildNumber(r.tag_name) }))
    .filter((x) => x.build > 0)
    .sort((a, b) => b.build - a.build);

  for (const { release, build } of ranked) {
    if (build < minBuild) continue;
    const asset = selectAssetFromRelease(release, backend, cudaVersion);
    if (asset) return asset;
  }
  for (const { release } of ranked) {
    const asset = selectAssetFromRelease(release, backend, cudaVersion);
    if (asset) return asset;
  }
  return null;
}

async function fetchApiReleases(): Promise<GhRelease[]> {
  const res = await fetch(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20",
    { headers: githubHeaders() },
  );
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toLocaleString() : "позже";
    throw new Error(
      `GitHub API rate limit (${res.status}). Повторите после ${when} или укажите GitHub Token в Настройках.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub releases error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as GhRelease[];
}

/** Parse latest bXXXX tags from public HTML/Atom — does not use REST API quota. */
async function discoverTagsWithoutApi(limit = 12): Promise<string[]> {
  const tags = new Set<string>();

  try {
    const atom = await fetch("https://github.com/ggml-org/llama.cpp/releases.atom", {
      headers: { "User-Agent": "KoviAIsoft", Accept: "application/atom+xml" },
    });
    if (atom.ok) {
      const text = await atom.text();
      for (const m of text.matchAll(/\/releases\/tag\/(b\d+)/gi)) {
        tags.add(m[1]);
      }
    }
  } catch {
    // ignore
  }

  try {
    const html = await fetch("https://github.com/ggml-org/llama.cpp/releases", {
      headers: { "User-Agent": "KoviAIsoft" },
    });
    if (html.ok) {
      const text = await html.text();
      for (const m of text.matchAll(/\/releases\/tag\/(b\d+)/gi)) {
        tags.add(m[1]);
      }
    }
  } catch {
    // ignore
  }

  return [...tags]
    .sort((a, b) => parseBuildNumber(b) - parseBuildNumber(a))
    .slice(0, limit);
}

async function urlExists(url: string): Promise<{ ok: boolean; size?: number }> {
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": "KoviAIsoft" },
    });
    if (head.ok) {
      const len = Number(head.headers.get("content-length") || 0);
      return { ok: true, size: len || undefined };
    }
    // Some CDNs dislike HEAD — try a ranged GET
    const get = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "KoviAIsoft", Range: "bytes=0-0" },
    });
    if (get.ok || get.status === 206) {
      const len = Number(
        get.headers.get("content-range")?.split("/")[1] ||
          get.headers.get("content-length") ||
          0,
      );
      return { ok: true, size: len || undefined };
    }
  } catch {
    // ignore
  }
  return { ok: false };
}

function buildCandidateNames(
  tag: string,
  backend: RuntimeBackend,
  cudaVersion?: string,
): { main: string[]; cudart: string[] } {
  if (backend === "cuda") {
    const prefer13 = Boolean(cudaVersion && Number(cudaVersion.split(".")[0]) >= 13);
    const mains = prefer13
      ? [
          `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
          `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
        ]
      : [
          `llama-${tag}-bin-win-cuda-12.4-x64.zip`,
          `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
        ];
    const cudarts = prefer13
      ? [
          `cudart-llama-bin-win-cuda-13.4-x64.zip`,
          `cudart-llama-bin-win-cuda-12.4-x64.zip`,
        ]
      : [
          `cudart-llama-bin-win-cuda-12.4-x64.zip`,
          `cudart-llama-bin-win-cuda-13.4-x64.zip`,
        ];
    return { main: mains, cudart: cudarts };
  }
  if (backend === "vulkan") {
    return { main: [`llama-${tag}-bin-win-vulkan-x64.zip`], cudart: [] };
  }
  return { main: [`llama-${tag}-bin-win-cpu-x64.zip`], cudart: [] };
}

async function resolveAssetByProbing(
  tag: string,
  backend: RuntimeBackend,
  cudaVersion?: string,
): Promise<RuntimeAsset | null> {
  const base = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}`;
  const names = buildCandidateNames(tag, backend, cudaVersion);
  for (const mainName of names.main) {
    const mainUrl = `${base}/${mainName}`;
    const main = await urlExists(mainUrl);
    if (!main.ok) continue;

    let cudartAssetName: string | undefined;
    let cudartUrl: string | undefined;
    let cudartSize: number | undefined;
    if (backend === "cuda") {
      const ver = mainName.match(/cuda-([\d.]+)/i)?.[1];
      const ordered = ver
        ? [`cudart-llama-bin-win-cuda-${ver}-x64.zip`, ...names.cudart]
        : names.cudart;
      for (const cName of ordered) {
        const cUrl = `${base}/${cName}`;
        const c = await urlExists(cUrl);
        if (c.ok) {
          cudartAssetName = cName;
          cudartUrl = cUrl;
          cudartSize = c.size;
          break;
        }
      }
    }

    return {
      tag,
      backend,
      assetName: mainName,
      url: mainUrl,
      size: main.size,
      cudartAssetName,
      cudartUrl,
      cudartSize,
    };
  }
  return null;
}

async function fetchViaHtmlFallback(
  backend: RuntimeBackend,
  cudaVersion?: string,
  minBuild = 11960,
): Promise<RuntimeAsset> {
  const tags = await discoverTagsWithoutApi(15);
  const ordered = tags.sort((a, b) => parseBuildNumber(b) - parseBuildNumber(a));
  for (const tag of ordered) {
    if (parseBuildNumber(tag) < minBuild) continue;
    const asset = await resolveAssetByProbing(tag, backend, cudaVersion);
    if (asset) return asset;
  }
  for (const tag of ordered) {
    const asset = await resolveAssetByProbing(tag, backend, cudaVersion);
    if (asset) return asset;
  }
  throw new Error(
    `Не найден llama.cpp (${backend}) даже через HTML fallback. Проверьте сеть.`,
  );
}

async function getCachedOrFetchReleases(): Promise<{
  releases: GhRelease[];
  fromCache: boolean;
  apiError?: string;
}> {
  const now = Date.now();
  if (memoryCache && now - memoryCache.fetchedAt < MEMORY_TTL_MS) {
    return { releases: memoryCache.releases, fromCache: true };
  }

  const disk = await readDiskCache();
  if (disk && now - disk.fetchedAt < DISK_TTL_MS) {
    memoryCache = disk;
    return { releases: disk.releases, fromCache: true };
  }

  try {
    const releases = await fetchApiReleases();
    const cache: CacheFile = { fetchedAt: now, releases };
    memoryCache = cache;
    await writeDiskCache(cache);
    return { releases, fromCache: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (disk?.releases?.length) {
      memoryCache = disk;
      return { releases: disk.releases, fromCache: true, apiError: message };
    }
    throw err;
  }
}

/**
 * Latest official Windows prebuilt for the requested backend.
 * Uses API with local cache; on rate-limit falls back to HTML/Atom + URL probing.
 */
export async function fetchLatestRuntimeAsset(
  backend: RuntimeBackend,
  cudaVersion?: string,
  minBuild = 11960,
): Promise<RuntimeAsset> {
  try {
    const { releases } = await getCachedOrFetchReleases();
    const asset = pickFromReleases(releases, backend, cudaVersion, minBuild);
    if (asset) return asset;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Rate limit / API down → HTML fallback (no REST quota).
    if (/rate limit|403|429|GitHub releases error/i.test(message)) {
      return fetchViaHtmlFallback(backend, cudaVersion, minBuild);
    }
    // Try HTML anyway, then rethrow original if that also fails.
    try {
      return await fetchViaHtmlFallback(backend, cudaVersion, minBuild);
    } catch {
      throw err;
    }
  }

  // API returned releases but none matched — try HTML probe.
  return fetchViaHtmlFallback(backend, cudaVersion, minBuild);
}

export function isNewerRuntime(latestTag: string, currentTag: string | null | undefined): boolean {
  if (!currentTag) return true;
  return parseBuildNumber(latestTag) > parseBuildNumber(currentTag);
}
