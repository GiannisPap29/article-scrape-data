// Medium article URL rules: normalization, validation, ids, and source description.

import { createHash } from "node:crypto";
import { TARGET_URL } from "../config/index.js";
import { type Article } from "./types.js";

export const BLOCKED_MEDIUM_PATH_PREFIXES = new Set([
  "about",
  "jobs",
  "jobs-at-medium",
  "list",
  "lists",
  "m",
  "me",
  "policy",
  "search",
  "tag",
  "topics"
]);

export function extractSingleArticleUrlFromText(text: string): string {
  const candidates = [...text.matchAll(/https?:\/\/[^\s<>"'()]+/g)]
    .map((match) => trimTrailingUrlPunctuation(match[0]));

  const articleUrls = [...new Set(candidates.flatMap((candidate) => {
    try {
      const article = createSingleArticle(candidate);
      assertArticleUrl(article.sourceUrl);
      return [article.sourceUrl];
    } catch {
      return [];
    }
  }))];

  if (articleUrls.length === 0) {
    throw new Error("No valid Medium article URL found in Drive file.");
  }

  if (articleUrls.length > 1) {
    throw new Error(`Drive file contains multiple Medium article URLs: ${articleUrls.join(", ")}`);
  }

  // A Drive inbox file is intentionally one article. That keeps queue rows,
  // archive moves, and failure handling easy to reason about.
  return articleUrls[0];
}

export function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

export function createSingleArticle(inputUrl: string): Article {
  const sourceUrl = normalizeArticleUrl(inputUrl);
  const docId = createDocId(sourceUrl);
  const title = deriveTitleFromUrl(sourceUrl);
  return { docId, title, sourceUrl };
}

export function assertArticleUrl(sourceUrl: string): void {
  if (isArticleUrl(sourceUrl)) {
    return;
  }

  throw new Error(`Not an article URL: ${sourceUrl}`);
}

export function isArticleUrl(sourceUrl: string): boolean {
  const parsed = new URL(sourceUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "";
  const lastSegment = segments.at(-1) ?? "";

  // Reading lists live under /@user/list/<name>-<id>, which otherwise looks
  // exactly like an article slug.
  if (
    BLOCKED_MEDIUM_PATH_PREFIXES.has(firstSegment) ||
    segments.some((segment) => segment === "following-feed" || segment === "list" || segment === "lists")
  ) {
    return false;
  }

  if (segments[0] === "p" && /^[a-f0-9]{8,}$/i.test(lastSegment)) {
    return true;
  }

  if (/^[a-z0-9-]+-[a-f0-9]{8,}$/i.test(lastSegment)) {
    return true;
  }

  return false;
}

export function describeArticleSource(sourceUrl: string): { publication: string | null; siteName: string; } {
  const parsed = new URL(sourceUrl);
  const host = parsed.hostname.replace(/^www\./u, "");
  const isMedium = host === "medium.com" || host.endsWith(".medium.com");
  // medium.com/<publication>/<slug> names the publication in the first path
  // segment; medium.com/@user/<slug> and <user>.medium.com are personal posts.
  const firstSegment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  const publication = host === "medium.com" && firstSegment && !firstSegment.startsWith("@") && firstSegment !== "p"
    ? firstSegment
    : isMedium ? null : host;
  return { publication, siteName: isMedium ? "Medium" : host };
}

export function normalizeArticleUrl(inputUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid article URL: ${inputUrl}`);
  }

  // Links pasted from any Freedium mirror wrap the real article URL in the path.
  if (parsed.hostname.includes("freedium") || parsed.origin === new URL(TARGET_URL).origin) {
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

export function deriveTitleFromUrl(articleUrl: string): string {
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

export function createDocId(sourceUrl: string): string {
  return `doc_${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}`;
}
