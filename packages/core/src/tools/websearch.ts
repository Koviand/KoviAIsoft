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

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo error: ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < 8) {
    hits.push({
      url: m[1],
      title: stripTags(m[2]),
      snippet: stripTags(m[3]),
    });
  }
  if (hits.length === 0) {
    // simpler fallback parse
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
}

async function searchSearxng(query: string, baseUrl: string): Promise<SearchHit[]> {
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetch(url);
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

export async function webSearch(query: string, settings: AppSettings): Promise<string> {
  const hits =
    settings.webSearchProvider === "searxng" && settings.searxngUrl
      ? await searchSearxng(query, settings.searxngUrl)
      : await searchDuckDuckGo(query);
  if (!hits.length) return "Ничего не найдено";
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`)
    .join("\n\n");
}
