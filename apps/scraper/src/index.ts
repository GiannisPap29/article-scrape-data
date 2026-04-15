import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "@playwright/test";
import {
  DEFAULT_DB_FILE,
  DEFAULT_OUTPUT_DIR,
  TARGET_URL
} from "@web-scrapper/config";

type BrowserName = "chrome" | "msedge" | "firefox" | "webkit";
type Command = "scrape" | "serve" | "reset";

type CliOptions = {
  browser: BrowserName;
  command: Command;
  connectUrl: string | null;
  headless: boolean;
  outputDir: string;
  port: number;
  dbFile: string;
  url: string | null;
};

type Article = {
  title: string;
  sourceUrl: string;
};

type ExtractionResult = {
  article: Article;
  content: string;
  footerContent: string | null;
};

type ScrapeResult = {
  outputPath: string;
  sourceUrl: string;
  status: "saved" | "skipped";
};

type BatchScrapeSummary = {
  failed: Array<{ error: string; inputUrl: string; }>;
  saved: ScrapeResult[];
  skipped: ScrapeResult[];
  total: number;
};

type ScrapedUrlRecord = {
  outputPath: string;
  scrapedAt: string;
  sourceUrl: string;
};

const SECURITY_VERIFICATION_PATTERNS = [
  "performing security verification",
  "verifies you are not a bot",
  "security service to protect against malicious bots",
  "checking if the site connection is secure",
  "please wait while we verify",
  "just a moment"
];

const BLOCKED_MEDIUM_PATH_PREFIXES = new Set([
  "about",
  "jobs",
  "jobs-at-medium",
  "m",
  "me",
  "policy",
  "search",
  "tag",
  "topics"
]);

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.command === "serve") {
    await startUiServer(options);
    return;
  }

  if (options.command === "reset") {
    resetTrackingDatabase(path.resolve(process.cwd(), options.dbFile));
    console.log(`Reset tracking database: ${path.resolve(process.cwd(), options.dbFile)}`);
    return;
  }

  if (!options.url) {
    throw new Error("Missing required --url value.");
  }

  const summary = await scrapeUrls([options.url], options);
  printBatchSummary(summary);
}

function parseCliArgs(args: string[]): CliOptions {
  let browser: BrowserName = "chrome";
  let command: Command = "scrape";
  let connectUrl: string | null = null;
  let headless = true;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let port = 3000;
  let dbFile = DEFAULT_DB_FILE;
  let url: string | null = null;

  for (const arg of args) {
    if (arg === "--serve") {
      command = "serve";
      continue;
    }

    if (arg === "--reset") {
      command = "reset";
      continue;
    }

    if (arg === "--headless=false") {
      headless = false;
      continue;
    }

    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length).trim();
      if (value !== "chrome" && value !== "msedge" && value !== "firefox" && value !== "webkit") {
        throw new Error(`Invalid --browser value: ${arg}`);
      }
      browser = value;
      continue;
    }

    if (arg.startsWith("--connectUrl=")) {
      const value = arg.slice("--connectUrl=".length).trim();
      if (!value) {
        throw new Error("Missing value for --connectUrl.");
      }
      connectUrl = value;
      continue;
    }

    if (arg.startsWith("--outputDir=")) {
      const value = arg.slice("--outputDir=".length).trim();
      if (!value) {
        throw new Error("Missing value for --outputDir.");
      }
      outputDir = value;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePositiveInteger(arg, "--port");
      continue;
    }

    if (arg.startsWith("--trackingFile=")) {
      const value = arg.slice("--trackingFile=".length).trim();
      if (!value) {
        throw new Error("Missing value for --trackingFile.");
      }
      dbFile = value;
      continue;
    }

    if (arg.startsWith("--dbFile=")) {
      const value = arg.slice("--dbFile=".length).trim();
      if (!value) {
        throw new Error("Missing value for --dbFile.");
      }
      dbFile = value;
      continue;
    }

    if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length).trim();
      if (!value) {
        throw new Error("Missing value for --url.");
      }
      url = value;
    }
  }

  return {
    browser,
    command,
    connectUrl,
    headless,
    outputDir,
    port,
    dbFile,
    url
  };
}

function parsePositiveInteger(arg: string, flagName: string): number {
  const value = Number(arg.slice(`${flagName}=`.length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${flagName} value: ${arg}`);
  }
  return value;
}

async function scrapeUrls(inputUrls: string[], options: CliOptions): Promise<BatchScrapeSummary> {
  const uniqueInputUrls = [...new Set(inputUrls.map((url) => url.trim()).filter(Boolean))];
  const failed: BatchScrapeSummary["failed"] = [];
  const saved: ScrapeResult[] = [];
  const skipped: ScrapeResult[] = [];

  for (const inputUrl of uniqueInputUrls) {
    try {
      const result = await scrapeSingleUrl(inputUrl, options);
      if (result.status === "saved") {
        saved.push(result);
      } else {
        skipped.push(result);
      }
    } catch (error) {
      failed.push({
        error: error instanceof Error ? error.message : String(error),
        inputUrl
      });
    }
  }

  return {
    failed,
    saved,
    skipped,
    total: uniqueInputUrls.length
  };
}

function printBatchSummary(summary: BatchScrapeSummary): void {
  console.log(`Processed ${summary.total} URL(s): ${summary.saved.length} saved, ${summary.skipped.length} skipped, ${summary.failed.length} failed.`);

  for (const result of summary.saved) {
    console.log(`Saved: ${result.sourceUrl} -> ${result.outputPath}`);
  }

  for (const result of summary.skipped) {
    console.log(`Skipped existing: ${result.sourceUrl} -> ${result.outputPath}`);
  }

  for (const failure of summary.failed) {
    console.log(`Failed: ${failure.inputUrl}: ${failure.error}`);
  }
}

async function scrapeSingleUrl(inputUrl: string, options: CliOptions): Promise<ScrapeResult> {
  const outputDir = path.resolve(process.cwd(), options.outputDir);
  const dbFile = path.resolve(process.cwd(), options.dbFile);

  await mkdir(outputDir, { recursive: true });

  const article = createSingleArticle(inputUrl);
  assertArticleUrl(article.sourceUrl);
  const db = openTrackingDatabase(dbFile);
  const existingRecord = getScrapedUrlRecord(db, article.sourceUrl);

  if (existingRecord) {
    db.close();
    return {
      outputPath: existingRecord.outputPath,
      sourceUrl: article.sourceUrl,
      status: "skipped"
    };
  }

  const { browser, context } = await openBrowserSession(options.browser, options.headless, options.connectUrl);

  try {
    const result = await extractArticleContent(context, article, outputDir, 1);
    const outputPath = await writeExtraction(outputDir, result, 1);
    upsertScrapedUrlRecord(db, {
      outputPath,
      scrapedAt: new Date().toISOString(),
      sourceUrl: article.sourceUrl
    });

    return {
      outputPath,
      sourceUrl: article.sourceUrl,
      status: "saved"
    };
  } finally {
    db.close();
    await browser.close();
  }
}

async function startUiServer(options: CliOptions): Promise<void> {
  let lastMessage: string | null = null;
  let isScraping = false;

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        await renderHome(response, options, lastMessage, isScraping);
        return;
      }

      if (request.method === "POST" && request.url === "/scrape") {
        if (isScraping) {
          redirect(response, "/");
          return;
        }

        const body = await readRequestBody(request);
        const inputUrls = parseUrlList(new URLSearchParams(body).get("urls") ?? "");
        if (inputUrls.length === 0) {
          lastMessage = "Missing article URL.";
          redirect(response, "/");
          return;
        }

        isScraping = true;
        try {
          const summary = await scrapeUrls(inputUrls, options);
          lastMessage = `Processed ${summary.total} URL(s): ${summary.saved.length} saved, ${summary.skipped.length} skipped, ${summary.failed.length} failed.`;
          if (summary.failed.length > 0) {
            lastMessage += ` First error: ${summary.failed[0].inputUrl}: ${summary.failed[0].error}`;
          }
        } catch (error) {
          lastMessage = error instanceof Error ? error.message : String(error);
        } finally {
          isScraping = false;
        }

        redirect(response, "/");
        return;
      }

      if (request.method === "POST" && request.url === "/reset") {
        resetTrackingDatabase(path.resolve(process.cwd(), options.dbFile));
        lastMessage = "Tracking database reset.";
        redirect(response, "/");
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack || error.message : String(error));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, "127.0.0.1", resolve);
  });
  console.log(`UI running at http://127.0.0.1:${options.port}`);
}

function parseUrlList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

async function renderHome(
  response: ServerResponse,
  options: CliOptions,
  message: string | null,
  isScraping: boolean
): Promise<void> {
  const db = openTrackingDatabase(path.resolve(process.cwd(), options.dbFile));
  const records = listScrapedUrlRecords(db);
  db.close();
  const rows = records.map((record) => {
    return `<tr>
      <td><a href="${escapeHtml(record.sourceUrl)}">${escapeHtml(record.sourceUrl)}</a></td>
      <td>${escapeHtml(record.scrapedAt)}</td>
      <td>${escapeHtml(record.outputPath)}</td>
    </tr>`;
  }).join("");

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web Scrapper</title>
  <style>
    :root { color-scheme: light; --bg: #f5efe6; --ink: #221f1b; --muted: #756b5f; --line: #d8cbbc; --accent: #0d5c63; --accent-2: #d9822b; }
    body { margin: 0; background: radial-gradient(circle at top left, #fff7dd 0, transparent 32rem), var(--bg); color: var(--ink); font-family: Georgia, "Times New Roman", serif; }
    main { width: min(1100px, calc(100% - 32px)); margin: 48px auto; }
    h1 { font-size: clamp(2.5rem, 7vw, 5.5rem); line-height: .9; margin: 0 0 24px; letter-spacing: -0.06em; }
    .panel { background: rgba(255,255,255,.72); border: 1px solid var(--line); border-radius: 22px; padding: 22px; box-shadow: 0 18px 50px rgba(74,48,25,.12); }
    form { display: flex; gap: 12px; flex-wrap: wrap; }
    textarea { flex: 1 1 100%; min-height: 145px; resize: vertical; border: 1px solid var(--line); border-radius: 20px; padding: 16px 18px; font: 15px ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.45; }
    button { border: 0; border-radius: 999px; padding: 14px 20px; background: var(--accent); color: white; font-weight: 700; cursor: pointer; }
    button.danger { background: #8f2d24; }
    .message { margin: 16px 0 0; color: var(--accent); font-weight: 700; }
    .meta { color: var(--muted); margin: 0 0 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); padding: 12px 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 28px 0 12px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <main>
    <p class="meta">Freedium extraction UI · source URL registry · duplicate skip</p>
    <h1>Article Scrapper</h1>
    <section class="panel">
      <form method="post" action="/scrape">
        <textarea name="urls" placeholder="Paste article URLs only, one per line. Do not paste Medium feed/profile/list URLs." required></textarea>
        <button type="submit" ${isScraping ? "disabled" : ""}>${isScraping ? "Scraping..." : "Scrape URL(s)"}</button>
      </form>
      ${message ? `<p class="message">${escapeHtml(message)}</p>` : ""}
    </section>
    <div class="toolbar">
      <h2>Scraped Sources (${records.length})</h2>
      <form method="post" action="/reset">
        <button class="danger" type="submit">Reset Database</button>
      </form>
    </div>
    <section class="panel">
      <table>
        <thead><tr><th>Source URL</th><th>Scraped At</th><th>Output</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3">No scraped URLs yet.</td></tr>`}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

function openTrackingDatabase(dbFile: string): DatabaseSync {
  mkdirSyncLike(path.dirname(dbFile));
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraped_urls (
      source_url TEXT PRIMARY KEY,
      output_path TEXT NOT NULL,
      scraped_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scraped_urls_scraped_at ON scraped_urls(scraped_at);
  `);
  return db;
}

function mkdirSyncLike(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function getScrapedUrlRecord(db: DatabaseSync, sourceUrl: string): ScrapedUrlRecord | null {
  const row = db
    .prepare("SELECT source_url AS sourceUrl, output_path AS outputPath, scraped_at AS scrapedAt FROM scraped_urls WHERE source_url = ?")
    .get(sourceUrl) as ScrapedUrlRecord | undefined;

  return row ?? null;
}

function listScrapedUrlRecords(db: DatabaseSync): ScrapedUrlRecord[] {
  return db
    .prepare("SELECT source_url AS sourceUrl, output_path AS outputPath, scraped_at AS scrapedAt FROM scraped_urls ORDER BY scraped_at DESC")
    .all() as ScrapedUrlRecord[];
}

function upsertScrapedUrlRecord(db: DatabaseSync, record: ScrapedUrlRecord): void {
  db
    .prepare(`
      INSERT INTO scraped_urls (source_url, output_path, scraped_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        output_path = excluded.output_path,
        scraped_at = excluded.scraped_at
    `)
    .run(record.sourceUrl, record.outputPath, record.scrapedAt);
}

function resetTrackingDatabase(dbFile: string): void {
  const db = openTrackingDatabase(dbFile);
  db.exec("DELETE FROM scraped_urls;");
  db.close();
}

function createSingleArticle(inputUrl: string): Article {
  const sourceUrl = normalizeArticleUrl(inputUrl);
  const title = deriveTitleFromUrl(sourceUrl);
  return { title, sourceUrl };
}

function assertArticleUrl(sourceUrl: string): void {
  const parsed = new URL(sourceUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "";
  const lastSegment = segments.at(-1) ?? "";

  if (BLOCKED_MEDIUM_PATH_PREFIXES.has(firstSegment) || segments.includes("following-feed")) {
    throw new Error(`Not an article URL: ${sourceUrl}`);
  }

  if (segments[0] === "p" && /^[a-f0-9]{8,}$/i.test(lastSegment)) {
    return;
  }

  if (/^[a-z0-9-]+-[a-f0-9]{8,}$/i.test(lastSegment)) {
    return;
  }

  throw new Error(`Not an article URL: ${sourceUrl}`);
}

async function openBrowserSession(browserName: BrowserName, headless: boolean, connectUrl: string | null) {
  const browser = connectUrl
    ? await chromium.connectOverCDP(connectUrl)
    : await launchBrowser(browserName, headless);

  const existingContext = browser.contexts()[0];
  const context = existingContext ?? await browser.newContext();

  return { browser, context };
}

async function launchBrowser(browserName: BrowserName, headless: boolean) {
  if (browserName === "chrome") {
    return chromium.launch({ channel: "chrome", headless });
  }

  if (browserName === "msedge") {
    return chromium.launch({ channel: "msedge", headless });
  }

  if (browserName === "firefox") {
    return firefox.launch({ headless });
  }

  return webkit.launch({ headless });
}

async function extractArticleContent(
  context: BrowserContext,
  article: Article,
  outputDir: string,
  index: number
): Promise<ExtractionResult> {
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

    const urlInput = page.locator('input[type="text"], input[type="url"], textarea').first();
    await urlInput.waitFor({ state: "visible", timeout: 30000 });
    await urlInput.fill(article.sourceUrl);
    await urlInput.press("Enter");

    await page.waitForURL((currentUrl) => currentUrl.pathname !== "/", { timeout: 30000 });
    await assertNoSecurityVerification(page, article.sourceUrl);

    const mainContent = page.locator(".main-content, main, article, .content").first();
    await mainContent.waitFor({ state: "visible", timeout: 30000 });
    const footerContent = await page
      .locator(".flex.flex-wrap.gap-2.mt-5")
      .first()
      .innerText()
      .then((value) => normalizeText(value))
      .catch(() => null);

    const content = normalizeText(await mainContent.innerText());
    if (!content) {
      throw new Error(`Empty content extracted for ${article.sourceUrl}`);
    }
    validateExtractedContent(content, article.sourceUrl);

    return {
      article,
      content,
      footerContent
    };
  } catch (error) {
    const safeName = `${String(index).padStart(3, "0")}-${slugify(article.title)}`;
    await page.screenshot({ path: path.join(outputDir, `${safeName}.png`), fullPage: true }).catch(() => undefined);
    await writeFile(path.join(outputDir, `${safeName}.html`), await page.content(), "utf8").catch(() => undefined);
    throw error;
  } finally {
    await page.close();
  }
}

async function assertNoSecurityVerification(page: Page, sourceUrl: string): Promise<void> {
  const pageTitle = (await page.title().catch(() => "")).toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const combinedText = `${pageTitle}\n${bodyText}`;

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (combinedText.includes(pattern)) {
      throw new Error(
        `Blocked by an anti-bot verification page while loading ${sourceUrl}. ` +
        "The scraper did not extract article content."
      );
    }
  }
}

function validateExtractedContent(content: string, sourceUrl: string): void {
  const normalized = content.toLowerCase();

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (normalized.includes(pattern)) {
      throw new Error(
        `Invalid article content extracted for ${sourceUrl}. ` +
        "The page content matches an anti-bot verification screen."
      );
    }
  }
}

function normalizeArticleUrl(inputUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid --url value: ${inputUrl}`);
  }

  if (parsed.origin === new URL(TARGET_URL).origin) {
    const embeddedUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, "");
    if (!embeddedUrl) {
      throw new Error("Freedium URL does not contain an embedded source article URL.");
    }

    try {
      parsed = new URL(embeddedUrl);
    } catch {
      throw new Error(`Unsupported Freedium URL: ${inputUrl}`);
    }
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function deriveTitleFromUrl(articleUrl: string): string {
  const pathname = new URL(articleUrl).pathname
    .split("/")
    .filter(Boolean)
    .pop();

  if (!pathname) {
    return "article";
  }

  return pathname
    .replace(/-[a-f0-9]{8,}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || "article";
}

async function writeExtraction(outputDir: string, result: ExtractionResult, index: number): Promise<string> {
  const safeName = `${String(index).padStart(3, "0")}-${slugify(result.article.title)}`;
  const outputPath = path.join(outputDir, `${safeName}.txt`);
  const body = result.footerContent
    ? `${result.content}\n\n${result.footerContent}\n`
    : `${result.content}\n`;
  await writeFile(outputPath, body, "utf8");
  return outputPath;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
