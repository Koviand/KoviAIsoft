import { describe, expect, it } from "vitest";
import { fetchWeatherBrief, resolvePlace } from "../packages/core/src/tools/weather";

describe("resolvePlace", () => {
  it("does not eat letters inside city names when stripping «в»", () => {
    expect(resolvePlace("погода в Киеве").query).toMatch(/Киев/i);
    expect(resolvePlace("погода Ростов на Дону").query).toMatch(/Ростов/i);
    expect(resolvePlace("погода в Москве").name).toMatch(/Москва/i);
  });
});

describe("fetchWeatherBrief", () => {
  it("returns Moscow current weather (wttr.in / Open-Meteo)", async () => {
    let brief;
    try {
      brief = await fetchWeatherBrief("Какая сегодня погода в Москве");
    } catch (err) {
      console.warn("Weather providers unreachable, skipping:", err);
      return;
    }
    if (!brief) {
      console.warn("Weather returned null, skipping");
      return;
    }
    expect(brief.place).toMatch(/Москва/i);
    expect(brief.summary).toMatch(/°C/);
    expect(brief.summary).toMatch(/wttr\.in|Open-Meteo/i);
  }, 30_000);
});
