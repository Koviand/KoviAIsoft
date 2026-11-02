import type { AppSettings } from "@kovi/shared";

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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 12_000,
): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "text/html",
        },
      });
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
            url: m[1],
            title: stripTags(m[2] || m[1]),
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
            url: decodeURIComponent(a[1]),
            title: decodeURIComponent(a[1]),
            snippet: "",
          });
        }
      }
      return hits;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function searchSearxng(query: string, baseUrl: string): Promise<SearchHit[]> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetchWithTimeout(url.toString(), {});
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

async function searchTavily(query: string, apiKey: string): Promise<SearchHit[]> {
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 8,
      include_answer: false,
    }),
  });
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

export async function webSearch(query: string, settings: AppSettings): Promise<string> {
  const q = query.trim();
  if (!q) return "Пустой запрос";
  let hits: SearchHit[] = [];
  const provider = settings.webSearchProvider || "duckduckgo";
  if (provider === "tavily") {
    const key = (settings.webSearchApiKey || "").trim();
    if (!key) throw new Error("Tavily: укажите webSearchApiKey в настройках");
    hits = await searchTavily(q, key);
  } else if (provider === "searxng") {
    const url = (settings.searxngUrl || "").trim();
    if (!url) {
      throw new Error("SearXNG: укажите URL инстанса в Настройках → Веб-поиск");
    }
    hits = await searchSearxng(q, url);
  } else {
    hits = await searchDuckDuckGo(q);
  }
  if (!hits.length) return "Ничего не найдено";
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`)
    .join("\n\n");
}
