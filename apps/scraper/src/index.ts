import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  DEFAULT_OUTPUT_DIR,
  TARGET_URL
} from "@web-scrapper/config";

type CliOptions = {
  headless: boolean;
  outputDir: string;
  url: string;
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

const SECURITY_VERIFICATION_PATTERNS = [
  "performing security verification",
  "verifies you are not a bot",
  "security service to protect against malicious bots",
  "checking if the site connection is secure",
  "please wait while we verify",
  "just a moment"
];

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), options.outputDir);

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext();

  try {
    const article = createSingleArticle(options.url);
    const result = await extractArticleContent(context, article, outputDir, 1);
    const outputPath = await writeExtraction(outputDir, result, 1);
    console.log(`Saved 1/1: ${outputPath}`);
    console.log(`Completed 1 file in ${outputDir}`);
  } finally {
    await browser.close();
  }
}

function parseCliArgs(args: string[]): CliOptions {
  let url: string | null = null;
  let headless = true;
  let outputDir = DEFAULT_OUTPUT_DIR;

  for (const arg of args) {
    if (arg === "--headless=false") {
      headless = false;
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

    if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length).trim();
      if (!value) {
        throw new Error("Missing value for --url.");
      }
      url = value;
    }
  }

  if (!url) {
    throw new Error("Missing required --url value.");
  }

  return {
    headless,
    outputDir,
    url
  };
}

function createSingleArticle(inputUrl: string): Article {
  const sourceUrl = normalizeArticleUrl(inputUrl);
  const title = deriveTitleFromUrl(sourceUrl);
  return { title, sourceUrl };
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
