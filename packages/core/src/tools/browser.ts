import { chromium, type Browser, type Page } from "playwright";

export class BrowserTooling {
  private browser: Browser | null = null;
  private page: Page | null = null;

  private async ensurePage(): Promise<Page> {
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
      }
      if (!this.page) {
        const ctx = await this.browser.newContext();
        this.page = await ctx.newPage();
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Некорректный URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Разрешены только http/https URL (получено ${parsed.protocol})`);
    }
    const page = await this.ensurePage();
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
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
    return `Clicked ${selector}`;
  }

  async type(selector: string, text: string): Promise<string> {
    const page = await this.ensurePage();
    await page.fill(selector, text, { timeout: 15000 });
    return `Typed into ${selector}`;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }
}
