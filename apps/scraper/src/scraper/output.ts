// Writing the .txt/.json document pair (the cross-app contract).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { type BrowserSession, extractArticleContent } from "./freedium.js";
import { logInfo } from "./log.js";
import { slugify } from "./text.js";
import { type ExtractionResult, type PersistedDocumentMetadata, type ScrapeOptions } from "./types.js";
import { assertArticleUrl, createSingleArticle, deriveTitleFromUrl } from "./urls.js";

// Keep this version aligned with apps/rag/src/common.py so new sidecars remain
// accepted by the RAG sync step.
export const SCRAPER_METADATA_VERSION = 4;

export async function scrapeAndWriteUrl(
  inputUrl: string,
  options: ScrapeOptions,
  session: BrowserSession,
  existingOutputPath: string | null = null
): Promise<PersistedDocumentMetadata> {
  const outputDir = path.resolve(process.cwd(), options.outputDir);
  const debugDir = path.resolve(process.cwd(), options.debugDir);

  await mkdir(outputDir, { recursive: true });

  const article = createSingleArticle(inputUrl);
  assertArticleUrl(article.sourceUrl);
  logInfo(`Normalized article URL: ${inputUrl} -> ${article.sourceUrl}`);

  const context = await session.getContext();
  const result = await extractArticleContent(context, article, options.freediumUrls, debugDir);
  return writeExtraction(outputDir, result, existingOutputPath);
}

export async function writeExtraction(
  outputDir: string,
  result: ExtractionResult,
  existingOutputPath: string | null
): Promise<PersistedDocumentMetadata> {
  const outputPath = buildStableOutputPath(outputDir, result.article.sourceUrl);
  const metadataPath = buildMetadataPath(outputPath);
  const body = `${result.content}\n`;
  const scrapedAt = new Date().toISOString();
  const tags = result.tags.length > 0 ? result.tags : await readExistingSidecarTags(metadataPath);
  const batchId = scrapedAt.slice(0, 10);
  const contentHash = createHash("sha256").update(body).digest("hex");
  // The .txt body and .json sidecar share one stable basename derived from the
  // normalized URL. Downstream apps treat this pair as the document contract.
  const metadata: PersistedDocumentMetadata = {
    author: result.author,
    batchId,
    contentFormat: result.contentFormat,
    contentHash,
    coverImage: result.coverImage,
    docId: result.article.docId,
    excerpt: result.excerpt,
    freediumUrl: result.freedium.url,
    freedium: result.freedium,
    language: result.language,
    // v4: file names only, relative to the sidecar's own folder, so data/output
    // can be moved or mounted elsewhere (Docker reader) without breaking links.
    metadataPath: path.basename(metadataPath),
    outputPath: path.basename(outputPath),
    publishedAt: result.publishedAt,
    readingTimeMinutes: result.readingTimeMinutes,
    scraperMetadataVersion: SCRAPER_METADATA_VERSION,
    scrapedAt,
    siteName: result.siteName,
    sourceUrl: result.article.sourceUrl,
    tags,
    title: result.title
  };

  // Body first, sidecar second: the .json is what marks a document as present
  // for the reader and RAG, so it must never point at a missing/partial .txt.
  await writeFileAtomic(outputPath, body);
  await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2));

  // If an older version wrote a different path for this URL, remove that stale
  // pair after the new stable pair exists.
  const previousOutputPath = existingOutputPath ? path.resolve(existingOutputPath) : null;
  if (previousOutputPath && previousOutputPath !== outputPath && existsSync(previousOutputPath)) {
    await unlink(previousOutputPath).catch(() => undefined);
    await unlink(buildMetadataPath(previousOutputPath)).catch(() => undefined);
  }

  // Callers record the absolute paths in the local scraped-urls.db.
  return { ...metadata, metadataPath, outputPath };
}

export async function readExistingSidecarTags(metadataPath: string): Promise<string[]> {
  // Freedium stopped showing Medium tags (2026-06). When re-scraping an article
  // whose earlier sidecar has real tags, keep them instead of wiping them.
  try {
    const previous = JSON.parse(await readFile(metadataPath, "utf8")) as { tags?: unknown; };
    return Array.isArray(previous.tags) ? previous.tags.map((tag) => String(tag)) : [];
  } catch {
    return [];
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  // Write to a temp name (no .txt/.json suffix, so readers never pick it up)
  // and rename over the target, so a crash can't leave a half-written file.
  const tempPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function buildStableOutputPath(outputDir: string, sourceUrl: string): string {
  const slug = slugify(deriveTitleFromUrl(sourceUrl));
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12);
  return path.join(outputDir, `${slug}-${hash}.txt`);
}

export function buildMetadataPath(outputPath: string): string {
  return outputPath.replace(/\.txt$/u, ".json");
}
