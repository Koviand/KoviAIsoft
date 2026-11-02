import type { AppSettings } from "@kovi/shared";
import { assertSafeNavigateUrl } from "./browser.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch with timeout; optional AbortSignal; manual redirects re-checked for SSRF. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 12_000,
  opts?: { signal?: AbortSignal; maxRedirects?: number },
): Promise<Response> {
  const external = opts?.signal;
  if (external?.aborted) throw new Error("Отменено");
  const ac = new AbortController();
  const onExt = () => ac.abort();
  external?.addEventListener("abort", onExt, { once: true });
  const t = setTimeout(() => ac.abort(), ms);
  try {
    let current = url;
    let redirects = 0;
    const maxRedirects = opts?.maxRedirects ?? 3;
    for (;;) {
      const res = await fetch(current, {
        ...init,
        signal: ac.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Redirect без Location (${res.status})`);
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new Error(`Слишком много redirect (${maxRedirects})`);
        }
        const next = new URL(loc, current).toString();
        await assertSafeNavigateUrl(next);
        current = next;
        continue;
      }
      return res;
    }
  } finally {
    clearTimeout(t);
    external?.removeEventListener("abort", onExt);
  }
}

async function searchDuckDuckGo(
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error("Отменено");
    try {
      const res = await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Accept: "text/html",
          },
        },
        12_000,
        { signal },
      );
      if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);
      const html = await res.text();
      const hits: SearchHit[] = [];
      const patterns = [
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div))?/gi,
        /<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && hits.length < 8) {
          hits.push({
            url: m[1]!,
            title: stripTags(m[2] || m[1]!),
            snippet: stripTags(m[3] || ""),
          });
        }
        if (hits.length) break;
      }
      if (hits.length === 0) {
        const alt = /uddg=([^&"]+)/g;
        let a: RegExpExecArray | null;
        while ((a = alt.exec(html)) && hits.length < 5) {
          hits.push({
            url: decodeURIComponent(a[1]!),
            title: decodeURIComponent(a[1]!),
            snippet: "",
          });
        }
      }
      return hits;
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw new Error("Отменено");
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function searchSearxng(
  query: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const safeBase = await assertSafeNavigateUrl(baseUrl);
  const url = new URL("/search", safeBase);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetchWithTimeout(url.toString(), {}, 12_000, { signal });
  if (!res.ok) throw new Error(`SearXNG error: ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || []).slice(0, 8).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

async function searchTavily(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const res = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: 8,
        include_answer: false,
      }),
    },
    12_000,
    { signal },
  );
  if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results || []).slice(0, 8).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

export async function webSearch(
  query: string,
  settings: AppSettings,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const q = query.trim();
  if (!q) return "Пустой запрос";
  if (opts?.signal?.aborted) throw new Error("Отменено");
  let hits: SearchHit[] = [];
  const provider = settings.webSearchProvider || "duckduckgo";
  if (provider === "tavily") {
    const key = (settings.webSearchApiKey || "").trim();
    if (!key) throw new Error("Tavily: укажите webSearchApiKey в настройках");
    hits = await searchTavily(q, key, opts?.signal);
  } else if (provider === "searxng") {
    const url = (settings.searxngUrl || "").trim();
    if (!url) {
      throw new Error("SearXNG: укажите URL инстанса в Настройках → Веб-поиск");
    }
    hits = await searchSearxng(q, url, opts?.signal);
  } else {
    hits = await searchDuckDuckGo(q, opts?.signal);
  }
  if (!hits.length) return "Ничего не найдено";
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`)
    .join("\n\n");
}
