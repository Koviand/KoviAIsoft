export interface ServerMetrics {
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  contextUsed: number | null;
  contextSize: number | null;
  source: "metrics" | "props" | "slots" | "none";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parsePrometheus(text: string): Partial<ServerMetrics> {
  const out: Partial<ServerMetrics> = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z0-9_:{}"=,.-]+)\s+([0-9.eE+-]+)/);
    if (!m) continue;
    const key = m[1];
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (/predicted_per_second|tokens_predicted_per_second|gen_tps/i.test(key)) {
      out.tokensPerSecond = value;
    } else if (/prompt_per_second|tokens_prompt_per_second|prompt_tps/i.test(key)) {
      out.promptTokensPerSecond = value;
    } else if (/n_ctx_used|tokens_cached|kv_cache_tokens/i.test(key)) {
      out.contextUsed = Math.round(value);
    } else if (/n_ctx[^_]|context_size/i.test(key) && !/used/i.test(key)) {
      out.contextSize = Math.round(value);
    }
  }
  return out;
}

async function fetchText(url: string, timeoutMs = 1200): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url: string, timeoutMs = 1200): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchLlamaServerMetrics(port: number): Promise<ServerMetrics> {
  const base = `http://127.0.0.1:${port}`;
  const empty: ServerMetrics = {
    tokensPerSecond: null,
    promptTokensPerSecond: null,
    contextUsed: null,
    contextSize: null,
    source: "none",
  };

  const metricsText = await fetchText(`${base}/metrics`);
  if (metricsText) {
    const parsed = parsePrometheus(metricsText);
    if (
      parsed.tokensPerSecond != null ||
      parsed.promptTokensPerSecond != null ||
      parsed.contextUsed != null ||
      parsed.contextSize != null
    ) {
      return { ...empty, ...parsed, source: "metrics" };
    }
  }

  const props = (await fetchJson(`${base}/props`)) as Record<string, unknown> | null;
  if (props && typeof props === "object") {
    const defaultGen = (props.default_generation_settings || props) as Record<string, unknown>;
    const nCtx =
      num(defaultGen.n_ctx) ||
      num(props.n_ctx) ||
      num((props as { total_slots?: number }).total_slots);
    if (nCtx != null) {
      return { ...empty, contextSize: nCtx, source: "props" };
    }
  }

  const slots = await fetchJson(`${base}/slots`);
  if (Array.isArray(slots) && slots.length > 0) {
    const s0 = slots[0] as Record<string, unknown>;
    const directTps = num(s0.tokens_per_second);
    const avgMs = num(s0.avg_token_time);
    const fromAvg = avgMs && avgMs > 0 ? 1000 / avgMs : null;
    return {
      ...empty,
      contextUsed: num(s0.n_past) ?? num(s0.n_decoded),
      contextSize: num(s0.n_ctx),
      tokensPerSecond: directTps ?? fromAvg,
      source: "slots",
    };
  }

  return empty;
}
