import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

/** Block SSRF to loopback / link-local / cloud metadata (P1-8). */
export async function assertSafeNavigateUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Некорректный URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Разрешены только http/https URL (получено ${parsed.protocol})`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Навигация к локальному/служебному хосту запрещена: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`Навигация к приватному IP запрещена: ${host}`);
    }
    return parsed;
  }
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error(`Хост ${host} резолвится в приватный IP (${r.address})`);
      }
    }
  } catch (err) {
    if (err instanceof Error && /приватн|запрещен/i.test(err.message)) throw err;
    // DNS failure — still block obvious names; let navigation fail later otherwise.
  }
  return parsed;
}

export class BrowserTooling {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ssrfRouteInstalled = false;

  private async ensurePage(): Promise<Page> {
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
      }
      if (!this.context) {
        this.context = await this.browser.newContext();
        this.page = await this.context.newPage();
        this.ssrfRouteInstalled = false;
      }
      if (!this.ssrfRouteInstalled && this.context) {
        // Abort navigations (incl. redirects) to private/local targets mid-flight.
        await this.context.route("**/*", async (route) => {
          const req = route.request();
          if (req.isNavigationRequest() || req.resourceType() === "document") {
            try {
              await assertSafeNavigateUrl(req.url());
              await route.continue();
            } catch {
              await route.abort("blockedbyclient");
            }
            return;
          }
          await route.continue();
        });
        this.ssrfRouteInstalled = true;
      }
      if (!this.page) {
        this.page = await this.context.newPage();
      }
      return this.page;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Браузер Playwright недоступен. Убедитесь, что папка playwright-browsers рядом с EXE заполнена. (${msg})`,
      );
    }
  }

  async navigate(url: string): Promise<string> {
    const parsed = await assertSafeNavigateUrl(url);
    const page = await this.ensurePage();
    try {
      await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/net::ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg)) {
        throw new Error(
          `Навигация/redirect заблокирован SSRF-защитой (приватный или служебный URL)`,
        );
      }
      throw err;
    }
    // Final URL after redirects must also pass the guard.
    await assertSafeNavigateUrl(page.url());
    return `Opened ${page.url()} title=${await page.title()}`;
  }

  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    const text = await page.evaluate(`document.body?.innerText?.slice(0, 12000) || ""`);
    return `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${text}`;
  }

  async click(selector: string): Promise<string> {
    const page = await this.ensurePage();
    await page.click(selector, { timeout: 15000 });
    await assertSafeNavigateUrl(page.url()).catch(() => undefined);
    return `Clicked ${selector}`;
  }

  async type(selector: string, text: string): Promise<string> {
    const page = await this.ensurePage();
    await page.fill(selector, text, { timeout: 15000 });
    return `Typed into ${selector}`;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.ssrfRouteInstalled = false;
  }
}
