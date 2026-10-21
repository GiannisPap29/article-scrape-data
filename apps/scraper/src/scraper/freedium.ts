// Browser session and Freedium page loading/extraction.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "playwright";
import { extractFreediumEmbeddedArticle, type FreediumEmbeddedArticle } from "./freedium-data.js";
import { convertFreediumMarkdown, toPermanentImageUrl } from "./markdown.js";
import { formatErrorWithCause, logInfo, logWarn } from "./log.js";
import { cleanExtractedArticleText, normalizeBrowserPageTitle, normalizeText, normalizeTitle, slugify, toDisplayTitle } from "./text.js";
import { type Article, type BrowserName, type CliOptions, type ContentFormat, type ExtractionResult } from "./types.js";
import { describeArticleSource } from "./urls.js";

export const SECURITY_VERIFICATION_PATTERNS = [
  "performing security verification",
  "verifies you are not a bot",
  "security service to protect against malicious bots",
  "checking if the site connection is secure",
  "please wait while we verify",
  "just a moment"
];

export const FREEDIUM_ARTICLE_SELECTOR = "article";

export const FREEDIUM_CONTENT_FALLBACK_SELECTOR = ".main-content, main, .content";

export const FREEDIUM_CONTENT_TIMEOUT_MS = 90000;

export const FREEDIUM_MIN_CONTENT_CHARS = 500;

// The article itself is gone (Freedium 404). Retrying or other mirrors won't help.
export class ArticleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleNotFoundError";
  }
}

export class FreediumBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreediumBlockedError";
  }
}

export type BrowserSession = {
  close: () => Promise<void>;
  getContext: () => Promise<BrowserContext>;
};

export function createBrowserSession(options: Pick<CliOptions, "browser" | "connectUrl" | "headless">): BrowserSession {
  // One browser for a whole run (a fresh page per article). Reopened lazily if
  // it crashes or the CDP connection drops, so one bad page can't stop the run.
  let current: Awaited<ReturnType<typeof openBrowserSession>> | null = null;

  return {
    async getContext() {
      if (current?.browser.isConnected()) {
        return current.context;
      }
      if (current) {
        logWarn("Browser disconnected; starting a new one.");
      }
      logInfo(`Opening browser: ${options.connectUrl ? `CDP ${options.connectUrl}` : options.browser}`);
      current = await openBrowserSession(options.browser, options.headless, options.connectUrl);
      return current.context;
    },
    async close() {
      if (current) {
        await current.browser.close().catch(() => undefined);
        current = null;
      }
    }
  };
}

export async function openBrowserSession(browserName: BrowserName, headless: boolean, connectUrl: string | null) {
  const browser = connectUrl
    ? await chromium.connectOverCDP(connectUrl)
    : await launchBrowser(browserName, headless);

  const existingContext = browser.contexts()[0];
  const context = existingContext ?? await browser.newContext();

  return { browser, context };
}

export async function launchBrowser(browserName: BrowserName, headless: boolean) {
  if (browserName === "chromium") {
    return chromium.launch({ headless });
  }

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

export async function extractArticleContent(
  context: BrowserContext,
  article: Article,
  freediumUrls: string[],
  debugDir: string
): Promise<ExtractionResult> {
  const failures: string[] = [];
  let page: Page | null = null;

  try {
    // Try each mirror: direct <mirror>/<article-url> first (one page load), then
    // the homepage form. An anti-bot page means the form won't help either, so
    // move straight to the next mirror. Each attempt gets a fresh tab so a
    // crashed or error page can't interfere with the next attempt.
    for (const mirror of freediumUrls) {
      for (const mode of ["direct", "form"] as const) {
        await page?.close().catch(() => undefined);
        page = await context.newPage();
        try {
          await loadFreediumArticle(page, mirror, article.sourceUrl, mode);
          return await readLoadedArticle(page, article);
        } catch (error) {
          // Playwright messages carry a multi-line call log; the first line is
          // what matters for logs and the queue's last_error.
          const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].trim();
          failures.push(`${new URL(mirror).host} ${mode}: ${message}`);
          logWarn(`Freedium ${mode} attempt failed on ${mirror}: ${message}`);
          if (error instanceof ArticleNotFoundError) {
            await saveDebugPage(page, debugDir, `${slugify(article.title)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
            throw error;
          }
          if (error instanceof FreediumBlockedError) {
            break;
          }
        }
      }
    }

    if (page) {
      await saveDebugPage(page, debugDir, `${slugify(article.title)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    }
    throw new Error(`All Freedium attempts failed for ${article.sourceUrl}: ${failures.join(" | ")}`);
  } finally {
    await page?.close().catch(() => undefined);
  }
}

export async function loadFreediumArticle(page: Page, mirror: string, sourceUrl: string, mode: "direct" | "form"): Promise<void> {
  if (mode === "direct") {
    const directUrl = `${mirror}${sourceUrl}`;
    logInfo(`Freedium open (direct): ${directUrl}`);
    await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  } else {
    logInfo(`Freedium open (form): ${mirror}`);
    await page.goto(mirror, { waitUntil: "domcontentloaded", timeout: 60000 });

    const urlInput = page.locator('input[type="text"], input[type="url"], textarea').first();
    await urlInput.waitFor({ state: "visible", timeout: 30000 });
    await urlInput.fill(sourceUrl);
    logInfo(`Freedium submitted: ${sourceUrl}`);
    await urlInput.press("Enter");
    await page.waitForURL((currentUrl) => currentUrl.pathname !== "/", { timeout: 30000 });
  }

  logInfo(`Freedium result URL: ${page.url()}`);
  await assertNoSecurityVerification(page, sourceUrl);
  logInfo(`Freedium waiting for content: ${sourceUrl}`);
  await waitForFreediumArticleContent(page, sourceUrl);
}

export async function readLoadedArticle(page: Page, article: Article): Promise<ExtractionResult> {
  // Preferred source: the article data Freedium embeds in the page (exact
  // dates, real author, Markdown body). The visible page is the fallback.
  const embedded = await readFreediumEmbeddedArticle(page);
  const extractedTitle = embedded?.title ? normalizeTitle(embedded.title) : await extractArticleTitle(page, article);
  const metadataFields = await extractDocumentMetadata(page, extractedTitle);

  let content: string;
  let contentFormat: ContentFormat;
  if (embedded?.markdown) {
    content = convertFreediumMarkdown(embedded.markdown, {
      pageUrl: page.url(),
      subtitle: embedded.subtitle,
      title: extractedTitle
    });
    contentFormat = "markdown";
  } else {
    logWarn(`Freedium embedded Markdown not found, rebuilding text from the page HTML: ${article.sourceUrl}`);
    content = cleanExtractedArticleText(normalizeText(await extractStructuredArticleContent(page)), extractedTitle);
    contentFormat = "text";
  }

  if (!content) {
    throw new Error(`Empty content extracted for ${article.sourceUrl}`);
  }
  validateExtractedContent(content, article.sourceUrl);
  logInfo(`Freedium content extracted: ${article.sourceUrl} chars=${content.length} format=${contentFormat}`);

  const source = describeArticleSource(article.sourceUrl);
  const subtitle = embedded?.subtitle ? normalizeTitle(embedded.subtitle) : null;
  return {
    article,
    author: embedded?.authors.length ? embedded.authors.join(", ") : metadataFields.author,
    content,
    contentFormat,
    coverImage: embedded?.postImage ? toPermanentImageUrl(embedded.postImage, page.url()) : null,
    // Freedium truncates long subtitles with "…"; the page meta description
    // keeps the full sentence, so prefer that when it extends the subtitle.
    excerpt: pickExcerpt(subtitle, metadataFields.excerpt),
    freedium: {
      free: embedded?.isFree ?? null,
      publication: source.publication,
      updatedAt: embedded?.updatedAt ?? null,
      url: page.url()
    },
    language: metadataFields.language,
    publishedAt: embedded?.publishedAt ?? metadataFields.publishedAt,
    readingTimeMinutes: parseReadingTime(embedded?.readingTime ?? metadataFields.readingTime),
    siteName: metadataFields.siteName ?? source.siteName,
    // The current Freedium layout shows no Medium tags; output.ts keeps any
    // tags an earlier sidecar had, and the RAG app auto-tags the rest.
    tags: [],
    title: extractedTitle
  };
}

export async function readFreediumEmbeddedArticle(page: Page): Promise<FreediumEmbeddedArticle | null> {
  try {
    const scriptText = await page.evaluate(() =>
      Array.from(document.scripts).map((script) => script.textContent ?? "").find((text) => text.includes("kit.start")) ?? null
    );
    return scriptText ? extractFreediumEmbeddedArticle(scriptText) : null;
  } catch (error) {
    logWarn(`Could not read Freedium embedded article data: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function pickExcerpt(subtitle: string | null, metaDescription: string | null): string | null {
  if (!subtitle) {
    return metaDescription;
  }
  const truncated = subtitle.replace(/…$/u, "").trim();
  if (metaDescription && truncated !== subtitle && metaDescription.startsWith(truncated)) {
    return metaDescription;
  }
  return subtitle;
}

export function parseReadingTime(value: string | null): number | null {
  const minutes = value?.match(/(\d+)\s*min/iu)?.[1];
  return minutes ? Number(minutes) : null;
}

export async function assertNoSecurityVerification(page: Page, sourceUrl: string): Promise<void> {
  const pageTitle = (await page.title().catch(() => "")).toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const combinedText = `${pageTitle}\n${bodyText}`;

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (combinedText.includes(pattern)) {
      logWarn(`Anti-bot verification detected for ${sourceUrl} with pattern "${pattern}" at ${page.url()}`);
      throw new FreediumBlockedError(
        `Blocked by an anti-bot verification page while loading ${sourceUrl}. ` +
        "The scraper did not extract article content."
      );
    }
  }
}

export async function waitForFreediumArticleContent(page: Page, sourceUrl: string): Promise<void> {
  const outcome = await page.waitForFunction(
    ({ articleSelector, fallbackSelector, minContentChars }) => {
      // Freedium renders a 404 page for deleted/unknown articles; report it
      // right away instead of waiting for content that will never appear.
      if (/\b404\b[\s\S]{0,40}article not found/iu.test(document.body?.innerText ?? "")) {
        return "not-found";
      }

      const root = document.querySelector<HTMLElement>(articleSelector) ??
        document.querySelector<HTMLElement>(fallbackSelector);
      if (!root) {
        return false;
      }

      const text = root.innerText.replace(/\s+/g, " ").trim();
      const lowerText = text.toLowerCase();
      if (
        lowerText.includes("paste any paywalled article link below") ||
        lowerText.includes("recently unlocked by the community")
      ) {
        return false;
      }

      return text.length >= minContentChars && Boolean(root.querySelector("h1, h2, p, pre, blockquote")) ? "content" : false;
    },
    {
      articleSelector: FREEDIUM_ARTICLE_SELECTOR,
      fallbackSelector: FREEDIUM_CONTENT_FALLBACK_SELECTOR,
      minContentChars: FREEDIUM_MIN_CONTENT_CHARS,
    },
    { timeout: FREEDIUM_CONTENT_TIMEOUT_MS }
  ).catch(async (error: unknown) => {
    const bodyPreview = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .then((value) => normalizeText(value).slice(0, 500))
      .catch(() => "");
    const previewSuffix = bodyPreview ? ` bodyPreview=${JSON.stringify(bodyPreview)}` : "";
    throw new Error(`Timed out waiting for Freedium article content for ${sourceUrl}.${previewSuffix}`, {
      cause: error
    });
  });

  if (await outcome.jsonValue() === "not-found") {
    throw new ArticleNotFoundError(`Freedium reports 404 article not found for ${sourceUrl}`);
  }
}

export async function saveDebugPage(page: Page, debugDir: string, baseName: string): Promise<void> {
  // Debug captures live outside data/output so the article contract folder only
  // holds .txt/.json pairs for the reader and RAG.
  await mkdir(debugDir, { recursive: true });
  const htmlPath = path.join(debugDir, `${baseName}.html`);
  const screenshotPath = path.join(debugDir, `${baseName}.png`);
  const savedArtifacts: string[] = [];

  if (page.isClosed()) {
    logWarn(`Skipped debug page artifacts because the page is already closed: ${baseName}`);
    return;
  }

  await page.screenshot({ path: screenshotPath, fullPage: true })
    .then(() => savedArtifacts.push(screenshotPath))
    .catch((error: unknown) => logWarn(`Failed to save debug screenshot: ${formatErrorWithCause(error)}`));

  const html = await page.content()
    .catch((error: unknown) => {
      logWarn(`Failed to read debug page HTML: ${formatErrorWithCause(error)}`);
      return null;
    });
  if (html !== null) {
    await writeFile(htmlPath, html, "utf8")
      .then(() => savedArtifacts.push(htmlPath))
      .catch((error: unknown) => logWarn(`Failed to save debug HTML: ${formatErrorWithCause(error)}`));
  }

  if (savedArtifacts.length > 0) {
    logWarn(`Saved debug page artifacts: ${savedArtifacts.join(" and ")}`);
  }
}

export function validateExtractedContent(content: string, sourceUrl: string): void {
  const normalized = content.toLowerCase();

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (normalized.includes(pattern)) {
      throw new FreediumBlockedError(
        `Invalid article content extracted for ${sourceUrl}. ` +
        "The page content matches an anti-bot verification screen."
      );
    }
  }
}

export async function extractArticleTitle(page: Page, article: Article): Promise<string> {
  const headingTitle = await page
    .locator("h1")
    .first()
    .innerText()
    .then((value) => normalizeTitle(value))
    .catch(() => "");

  if (headingTitle) {
    return headingTitle;
  }

  const pageTitle = normalizeBrowserPageTitle(await page.title().catch(() => ""));
  if (pageTitle) {
    return pageTitle;
  }

  return toDisplayTitle(article.title);
}

// Fallback metadata from the visible page, used when Freedium's embedded
// article data is missing. Current layout (since 2026-06): <article><header>
// holds "<date>", <h1>, subtitle, "By <author>", "<n> min read".
export async function extractDocumentMetadata(
  page: Page,
  title: string
): Promise<{
  author: string | null;
  excerpt: string | null;
  language: string | null;
  publishedAt: string | null;
  readingTime: string | null;
  siteName: string | null;
}> {
  return page.evaluate((resolvedTitle) => {
    const readMeta = (...selectors: string[]) => {
      for (const selector of selectors) {
        const value = document.querySelector<HTMLMetaElement>(selector)?.content?.trim();
        if (value) {
          return value;
        }
      }
      return null;
    };

    const headerLines = Array.from(document.querySelectorAll<HTMLElement>("article header p"))
      .map((paragraph) => paragraph.textContent?.trim() ?? "")
      .filter(Boolean);
    const headerAuthor = headerLines.find((line) => /^by\s+\S/iu.test(line))?.replace(/^by\s+/iu, "") ?? null;
    const headerDate = headerLines.map((line) => line.match(/[A-Z][a-z]+ \d{1,2}, \d{4}/u)?.[0]).find(Boolean) ?? null;
    const excerpt = readMeta('meta[name="description"]', 'meta[property="og:description"]');

    return {
      author: readMeta('meta[name="author"]', 'meta[property="article:author"]') ?? headerAuthor,
      excerpt: excerpt && excerpt !== resolvedTitle ? excerpt : null,
      language: document.documentElement.lang?.trim() || null,
      publishedAt: readMeta('meta[property="article:published_time"]', 'meta[name="parsely-pub-date"]') ?? headerDate,
      readingTime: headerLines.find((line) => /^\d+\s+min read$/iu.test(line)) ?? null,
      siteName: readMeta('meta[property="og:site_name"]', 'meta[name="application-name"]')
    };
  }, title);
}

export async function extractStructuredArticleContent(page: Page): Promise<string> {
  return page.evaluate(({ articleSelector, fallbackSelector }) => {
    const root = document.querySelector<HTMLElement>(articleSelector) ??
      document.querySelector<HTMLElement>(fallbackSelector);
    if (!root) {
      return "";
    }
    const articleBody = root.tagName.toLowerCase() === "article"
      ? Array.from(root.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .filter((child) => child.tagName.toLowerCase() === "div" && child.classList.contains("p-6"))
        .sort((left, right) => right.innerText.length - left.innerText.length)[0] ?? root
      : root;

    const normalizeInline = (value: string) => value.replace(/\s+/g, " ").trim();
    const getImageSource = (image: HTMLImageElement) =>
      image.currentSrc ||
      image.getAttribute("src") ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-original") ||
      "";

    const blocks: string[] = [];

    const pushBlock = (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        blocks.push(trimmed);
      }
    };

    const serializeList = (element: HTMLElement, ordered: boolean) => {
      const items = Array.from(element.querySelectorAll(":scope > li"));
      const lines = items
        .map((item, index) => {
          const text = normalizeInline(item.textContent ?? "");
          if (!text) {
            return "";
          }
          return ordered ? `${index + 1}. ${text}` : `- ${text}`;
        })
        .filter(Boolean);
      if (lines.length > 0) {
        pushBlock(lines.join("\n"));
      }
    };

    const walk = (element: Element) => {
      const tag = element.tagName.toLowerCase();

      // Serialize into a small Markdown-like text format so code blocks,
      // images, lists, and quotes survive the scraper-to-reader/RAG handoff.
      if (tag === "pre") {
        const code = element.textContent?.replace(/\r\n/g, "\n").replace(/\n+$/u, "").trimEnd();
        if (code) {
          pushBlock(`\`\`\`\n${code}\n\`\`\``);
        }
        return;
      }

      if (tag === "figure") {
        const image = element.querySelector("img");
        if (image) {
          const src = getImageSource(image);
          const alt = normalizeInline(image.getAttribute("alt") || "");
          const caption = normalizeInline(element.querySelector("figcaption")?.textContent || "");
          if (src) {
            pushBlock(`![${alt}](${src})`);
          }
          if (caption) {
            pushBlock(caption);
          }
          return;
        }
      }

      if (tag === "img") {
        const image = element as HTMLImageElement;
        const src = getImageSource(image);
        const alt = normalizeInline(image.getAttribute("alt") || "");
        if (src) {
          pushBlock(`![${alt}](${src})`);
        }
        return;
      }

      if (/^h[1-6]$/u.test(tag)) {
        const text = normalizeInline(element.textContent ?? "");
        if (text) {
          pushBlock(`${"#".repeat(Number(tag[1]))} ${text}`);
        }
        return;
      }

      if (tag === "p") {
        const text = normalizeInline(element.textContent ?? "");
        if (text) {
          pushBlock(text);
        }
        return;
      }

      if (tag === "blockquote") {
        const lines = (element.textContent ?? "")
          .split("\n")
          .map((line) => normalizeInline(line))
          .filter(Boolean)
          .map((line) => `> ${line}`);
        if (lines.length > 0) {
          pushBlock(lines.join("\n"));
        }
        return;
      }

      if (tag === "ul") {
        serializeList(element as HTMLElement, false);
        return;
      }

      if (tag === "ol") {
        serializeList(element as HTMLElement, true);
        return;
      }

      const children = Array.from(element.children);
      if (children.length === 0) {
        const text = normalizeInline(element.textContent ?? "");
        if (text) {
          pushBlock(text);
        }
        return;
      }

      for (const child of children) {
        walk(child);
      }
    };

    for (const child of Array.from(articleBody.children)) {
      walk(child);
    }

    return blocks.join("\n\n");
  }, {
    articleSelector: FREEDIUM_ARTICLE_SELECTOR,
    fallbackSelector: FREEDIUM_CONTENT_FALLBACK_SELECTOR
  });
}
