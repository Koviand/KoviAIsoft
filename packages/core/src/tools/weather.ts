/**
 * Live weather for chat: wttr.in (primary) + Open-Meteo fallback. No API keys.
 */

export type WeatherBrief = {
  place: string;
  summary: string;
};

const CITY_HINTS: Array<{ re: RegExp; name: string; query: string; lat: number; lon: number }> = [
  { re: /москв|moscow/i, name: "Москва", query: "Moscow", lat: 55.7558, lon: 37.6173 },
  {
    re: /питер|петербург|saint[-\s]?petersburg|spb\b/i,
    name: "Санкт-Петербург",
    query: "Saint Petersburg",
    lat: 59.9343,
    lon: 30.3351,
  },
  {
    re: /новосибирск|novosibirsk/i,
    name: "Новосибирск",
    query: "Novosibirsk",
    lat: 55.0084,
    lon: 82.9357,
  },
  {
    re: /екатеринбург|yekaterinburg|ekaterinburg/i,
    name: "Екатеринбург",
    query: "Yekaterinburg",
    lat: 56.8389,
    lon: 60.6057,
  },
  { re: /казан|kazan/i, name: "Казань", query: "Kazan", lat: 55.7961, lon: 49.1064 },
  { re: /сочи|sochi/i, name: "Сочи", query: "Sochi", lat: 43.6028, lon: 39.7342 },
];

function wmoLabel(code: number): string {
  if (code === 0) return "ясно";
  if (code <= 3) return "переменная облачность";
  if (code <= 48) return "туман";
  if (code <= 57) return "морось";
  if (code <= 67) return "дождь";
  if (code <= 77) return "снег";
  if (code <= 82) return "ливень";
  if (code <= 86) return "снегопад";
  if (code <= 99) return "гроза";
  return `код погоды ${code}`;
}

async function fetchText(
  url: string,
  ms = 10_000,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Отменено");
  const ac = new AbortController();
  const onExt = () => ac.abort();
  signal?.addEventListener("abort", onExt, { once: true });
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "User-Agent": "KoviAIsoft/0.1 (local weather)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onExt);
  }
}

async function fetchJson(
  url: string,
  ms = 10_000,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await fetchText(url, ms, signal);
  return JSON.parse(text) as unknown;
}

/** Exported for unit tests (city cleaning must not eat letters inside city names). */
export function resolvePlace(
  userQuery: string,
): { name: string; query: string; lat: number; lon: number; known: boolean } {
  for (const c of CITY_HINTS) {
    if (c.re.test(userQuery)) {
      return { name: c.name, query: c.query, lat: c.lat, lon: c.lon, known: true };
    }
  }
  const cleaned = userQuery
    // Word boundaries via \p{L} — bare `в\s+` ate the trailing letter of cities («Киев»→«Кие»).
    .replace(
      /(?<!\p{L})(погод\p{L}*|weather|forecast|прогноз\p{L}*|температур\p{L}*|сегодня|сейчас|какая|какой|какое|tell|me|what|is|the)(?!\p{L})/giu,
      " ",
    )
    .replace(/(?<!\p{L})в(?!\p{L})\s+/giu, " ")
    .replace(/[?!.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const q = cleaned || "Moscow";
  // Unknown city: wttr can geocode by name; do NOT invent Moscow lat/lon for Open-Meteo.
  return { name: q, query: q, lat: 55.7558, lon: 37.6173, known: false };
}

async function fromWttr(
  place: { name: string; query: string },
  signal?: AbortSignal,
): Promise<WeatherBrief | null> {
  const enc = encodeURIComponent(place.query);
  // Compact one-liner first (fast / reliable).
  const line = (await fetchText(`https://wttr.in/${enc}?format=3`, 10_000, signal)).trim();
  if (!line || /unknown/i.test(line)) return null;
  let detail = "";
  try {
    // Keep j1 short — one-liner is enough if detail is slow.
    const j = (await fetchJson(`https://wttr.in/${enc}?format=j1`, 3_000, signal)) as {
      current_condition?: Array<{
        temp_C?: string;
        FeelsLikeC?: string;
        humidity?: string;
        weatherDesc?: Array<{ value?: string }>;
        windspeedKmph?: string;
      }>;
      weather?: Array<{
        maxtempC?: string;
        mintempC?: string;
        hourly?: Array<{ tempC?: string; weatherDesc?: Array<{ value?: string }> }>;
      }>;
    };
    const cur = j.current_condition?.[0];
    const day = j.weather?.[0];
    if (cur) {
      const desc = cur.weatherDesc?.[0]?.value || "";
      detail = [
        `Сейчас: ${cur.temp_C}°C (ощущается ${cur.FeelsLikeC}°C), ${desc}.`,
        `Влажность: ${cur.humidity}%, ветер: ${cur.windspeedKmph} км/ч.`,
        day ? `Сегодня: мин ${day.mintempC}°C / макс ${day.maxtempC}°C.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // one-liner is enough
  }
  const summary = [
    `Место: ${place.name}`,
    line,
    detail,
    "Источник: wttr.in",
  ]
    .filter(Boolean)
    .join("\n");
  return { place: place.name, summary };
}

async function fromOpenMeteo(
  place: {
    name: string;
    lat: number;
    lon: number;
  },
  signal?: AbortSignal,
): Promise<WeatherBrief | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  const data = (await fetchJson(url, 8_000, signal)) as {
    timezone?: string;
    current?: {
      time?: string;
      temperature_2m?: number;
      apparent_temperature?: number;
      relative_humidity_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const cur = data.current;
  if (!cur || typeof cur.temperature_2m !== "number") return null;
  const code = typeof cur.weather_code === "number" ? cur.weather_code : 0;
  const tmax = data.daily?.temperature_2m_max?.[0];
  const tmin = data.daily?.temperature_2m_min?.[0];
  const lines = [
    `Место: ${place.name}`,
    `Сейчас (${cur.time || "n/a"}, TZ ${data.timezone || "?"}): ${cur.temperature_2m}°C, ощущается ${cur.apparent_temperature ?? "?"}°C, ${wmoLabel(code)}.`,
    `Влажность: ${cur.relative_humidity_2m ?? "?"}%, ветер: ${cur.wind_speed_10m ?? "?"} км/ч.`,
  ];
  if (typeof tmax === "number" && typeof tmin === "number") {
    lines.push(`Сегодня: мин ${tmin}°C / макс ${tmax}°C.`);
  }
  lines.push("Источник: Open-Meteo");
  return { place: place.name, summary: lines.join("\n") };
}

/** Returns a Russian brief for the model, or null if not resolvable. */
export async function fetchWeatherBrief(
  userQuery: string,
  opts?: { signal?: AbortSignal },
): Promise<WeatherBrief | null> {
  if (opts?.signal?.aborted) throw new Error("Отменено");
  const place = resolvePlace(userQuery);
  try {
    const wttr = await fromWttr(place, opts?.signal);
    if (wttr) return wttr;
  } catch (err) {
    if (opts?.signal?.aborted) throw err instanceof Error ? err : new Error("Отменено");
    /* try open-meteo only for known cities (coords are trustworthy) */
  }
  if (!place.known) return null;
  try {
    return await fromOpenMeteo(place, opts?.signal);
  } catch (err) {
    if (opts?.signal?.aborted) throw err instanceof Error ? err : new Error("Отменено");
    return null;
  }
}
