import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const OUTPUT_DIR = path.resolve(process.env.READER_OUTPUT_DIR ?? path.join(PROJECT_ROOT, "data/output"));
const DEFAULT_PORT = 3010;
const DEFAULT_HOST = process.env.READER_HOST ?? "127.0.0.1";
// Optional: RAG manifest with locally generated tags for articles that have no
// Medium tags. Missing or unreadable is fine; the reader just shows no auto tags.
const MANIFEST_PATH = path.resolve(process.env.READER_MANIFEST_PATH ?? path.join(PROJECT_ROOT, "data/state/manifest.json"));
// How often a request may trigger a check for changed files on disk.
const REFRESH_INTERVAL_MS = 2000;

function parsePort(argv) {
  const arg = argv.find((entry) => entry.startsWith("--port="));
  if (arg) {
    const parsed = Number.parseInt(arg.slice("--port=".length), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
  }
  if (process.env.PORT) {
    const parsed = Number.parseInt(process.env.PORT, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function toDomain(urlValue) {
  if (!urlValue) {
    return "";
  }
  try {
    return new URL(urlValue).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function buildTextPath(sidecarPath, outputPath) {
  // v4 sidecars store a bare file name next to the sidecar; v2/v3 stored host
  // paths that may not exist in the container. Either way the .txt lives next
  // to its .json, and basename() keeps the lookup inside OUTPUT_DIR.
  const fileName = outputPath ? path.basename(outputPath) : path.basename(sidecarPath).replace(/\.json$/i, ".txt");
  return path.join(path.dirname(sidecarPath), fileName);
}

function tokenize(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)))];
}

function parseArticle(sidecarName, sidecarPath, metadata, textPath, body) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag)) : [];
  const author = metadata.author ? String(metadata.author) : "";
  const freediumUrl = metadata.freediumUrl || metadata.freedium?.url || "";
  const article = {
    author,
    autoTags: [],
    batchId: metadata.batchId ? String(metadata.batchId) : "",
    body,
    contentFormat: metadata.contentFormat === "markdown" ? "markdown" : "text",
    contentHash: metadata.contentHash ? String(metadata.contentHash) : "",
    coverImage: typeof metadata.coverImage === "string" && /^https?:\/\//u.test(metadata.coverImage) ? metadata.coverImage : "",
    docId: String(metadata.docId ?? path.basename(sidecarName, ".json")),
    domain: toDomain(metadata.sourceUrl),
    excerpt: metadata.excerpt ? String(metadata.excerpt) : "",
    freedium: metadata.freedium ?? {},
    freediumUrl: String(freediumUrl),
    language: metadata.language ? String(metadata.language) : "",
    metadataPath: String(metadata.metadataPath ?? sidecarPath),
    path: textPath,
    publishedAt: metadata.publishedAt ? String(metadata.publishedAt) : "",
    readingTimeMinutes: Number.isInteger(metadata.readingTimeMinutes) ? metadata.readingTimeMinutes : null,
    scrapedAt: metadata.scrapedAt ? String(metadata.scrapedAt) : "",
    sourceUrl: metadata.sourceUrl ? String(metadata.sourceUrl) : "",
    outputPath: String(metadata.outputPath ?? textPath),
    siteName: metadata.siteName ? String(metadata.siteName) : "",
    scraperMetadataVersion: metadata.scraperMetadataVersion ?? null,
    tags,
    title: metadata.title ? String(metadata.title) : path.basename(sidecarName, ".json"),
    wordCount: body.trim() ? body.trim().split(/\s+/).length : 0
  };
  // Lowercased once per file change instead of on every search request.
  article.searchText = [
    article.title,
    article.author,
    article.siteName,
    article.excerpt,
    article.sourceUrl,
    article.freediumUrl,
    article.tags.join(" "),
    article.body
  ].join(" ").toLowerCase();
  return article;
}

// Tags shown and filtered on: real Medium tags first, local auto tags otherwise.
export function articleTags(article) {
  return article.tags.length > 0 ? article.tags : article.autoTags;
}

const articleCache = new Map();
const manifestCache = { mtimeMs: null, tagsByDocId: new Map() };
let sortedArticles = [];
let lastRefreshAt = 0;
let refreshInFlight = null;

async function fileMtime(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function refreshAutoTags() {
  const mtimeMs = await fileMtime(MANIFEST_PATH);
  if (mtimeMs === manifestCache.mtimeMs) {
    return false;
  }
  manifestCache.mtimeMs = mtimeMs;
  manifestCache.tagsByDocId = new Map();
  if (mtimeMs !== null) {
    try {
      const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
      for (const [docId, record] of Object.entries(manifest.documents ?? {})) {
        if (Array.isArray(record.auto_tags) && record.auto_tags.length > 0) {
          manifestCache.tagsByDocId.set(docId, record.auto_tags.map((tag) => String(tag)));
        }
      }
    } catch {
      // A manifest being rewritten mid-read is retried on the next refresh.
      manifestCache.mtimeMs = null;
    }
  }
  return true;
}

async function refreshArticles() {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
  const sidecarNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
  let changed = false;

  // JSON sidecars are the catalogue. Only re-read a pair when the .json or
  // .txt modification time changed. Invalid sidecars are skipped so one bad
  // scrape artifact does not break the reader.
  for (const sidecarName of sidecarNames) {
    const sidecarPath = path.join(OUTPUT_DIR, sidecarName);
    const cached = articleCache.get(sidecarName);
    const jsonMtime = await fileMtime(sidecarPath);
    const cachedTextPath = cached?.article?.path ?? sidecarPath.replace(/\.json$/i, ".txt");
    const textMtime = await fileMtime(cachedTextPath);
    if (cached && cached.jsonMtime === jsonMtime && cached.textMtime === textMtime) {
      continue;
    }

    changed = true;
    let metadata;
    try {
      metadata = JSON.parse(await readFile(sidecarPath, "utf8"));
    } catch {
      articleCache.set(sidecarName, { article: null, jsonMtime, textMtime });
      continue;
    }

    const textPath = buildTextPath(sidecarPath, metadata.outputPath);
    const body = await readFile(textPath, "utf8").catch(() => "");
    articleCache.set(sidecarName, {
      article: parseArticle(sidecarName, sidecarPath, metadata, textPath, body),
      jsonMtime,
      textMtime: await fileMtime(textPath)
    });
  }

  const present = new Set(sidecarNames);
  for (const sidecarName of articleCache.keys()) {
    if (!present.has(sidecarName)) {
      articleCache.delete(sidecarName);
      changed = true;
    }
  }

  const tagsChanged = await refreshAutoTags();
  if (changed || tagsChanged) {
    sortedArticles = [...articleCache.values()]
      .map((entry) => entry.article)
      .filter(Boolean)
      .sort((left, right) =>
        String(right.publishedAt || right.scrapedAt).localeCompare(String(left.publishedAt || left.scrapedAt))
      );
    for (const article of sortedArticles) {
      article.autoTags = manifestCache.tagsByDocId.get(article.docId) ?? [];
    }
    rebuildSearchIndex(sortedArticles);
  }
}

// Full-text search: an in-memory SQLite FTS5 index rebuilt from the cache
// whenever files change (the reader never writes to disk). Porter stemming
// matches "errors" with "error"; bm25 weights rank title and tags above body.
const searchDb = new DatabaseSync(":memory:");
searchDb.exec(`
  CREATE VIRTUAL TABLE articles_fts USING fts5(
    doc_id UNINDEXED, title, tags, author, excerpt, body,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
`);
const SEARCH_WEIGHTS = "0, 10, 6, 4, 3, 1";
const SNIPPET_OPEN = "\u0001";
const SNIPPET_CLOSE = "\u0002";

function rebuildSearchIndex(articles) {
  const insert = searchDb.prepare("INSERT INTO articles_fts (doc_id, title, tags, author, excerpt, body) VALUES (?, ?, ?, ?, ?, ?)");
  searchDb.exec("BEGIN");
  try {
    searchDb.exec("DELETE FROM articles_fts");
    for (const article of articles) {
      insert.run(article.docId, article.title, articleTags(article).join(" "), article.author, article.excerpt, article.body);
    }
    searchDb.exec("COMMIT");
  } catch (error) {
    searchDb.exec("ROLLBACK");
    throw error;
  }
}

export function toFtsQuery(text) {
  // Every word must match (AND), as a quoted prefix so "kube" finds
  // "kubernetes" and user punctuation can never break the FTS syntax.
  const terms = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.slice(0, 12).map((term) => `"${term}"*`).join(" ");
}

// Returns Map(docId -> { rank, snippet }) or null when there is nothing to search.
export function searchArticles(text) {
  const query = toFtsQuery(text);
  if (!query) {
    return null;
  }
  const rows = searchDb
    .prepare(`
      SELECT doc_id AS docId,
             bm25(articles_fts, ${SEARCH_WEIGHTS}) AS score,
             snippet(articles_fts, 5, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', ' … ', 18) AS snippet
      FROM articles_fts
      WHERE articles_fts MATCH ?
      ORDER BY score
      LIMIT 500
    `)
    .all(query);
  return new Map(rows.map((row, rank) => [row.docId, { rank, snippet: row.snippet }]));
}

function renderSnippet(snippet) {
  // Escape first, then turn the FTS markers into <mark>; Markdown symbols in
  // the raw body are stripped so the snippet reads like plain text.
  const plain = String(snippet).replace(/[#*_`>]+/gu, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\s+/gu, " ");
  return escapeHtml(plain).replaceAll(SNIPPET_OPEN, "<mark>").replaceAll(SNIPPET_CLOSE, "</mark>");
}

export async function loadArticles() {
  // Serve from memory; check the disk at most every REFRESH_INTERVAL_MS, and
  // let concurrent requests share one refresh.
  if (Date.now() - lastRefreshAt >= REFRESH_INTERVAL_MS) {
    refreshInFlight ??= refreshArticles().finally(() => {
      lastRefreshAt = Date.now();
      refreshInFlight = null;
    });
  }
  if (refreshInFlight) {
    await refreshInFlight;
  }
  return sortedArticles;
}

export function filterArticles(articles, query, searchResults = undefined) {
  const searchQuery = (query.q ?? "").trim().toLowerCase();
  const titleQuery = (query.title ?? "").trim().toLowerCase();
  const tag = (query.tag ?? "").trim();
  const author = (query.author ?? "").trim();
  const language = (query.language ?? "").trim();
  const domain = (query.domain ?? "").trim();
  // A search defaults to best match first; browsing defaults to newest first.
  const sort = (query.sort || (searchQuery && searchResults ? "relevance" : "published")).trim();

  // Sorting below must not reorder the shared cached array.
  let filtered = articles.filter((article) => {
    if (searchQuery) {
      if (searchResults) {
        if (!searchResults.has(article.docId)) {
          return false;
        }
      } else if (!article.searchText.includes(searchQuery) && !article.autoTags.join(" ").includes(searchQuery)) {
        return false;
      }
    }
    if (titleQuery && !article.title.toLowerCase().includes(titleQuery)) {
      return false;
    }
    if (tag && !articleTags(article).includes(tag)) {
      return false;
    }
    if (author && article.author !== author) {
      return false;
    }
    if (language && article.language !== language) {
      return false;
    }
    if (domain && article.domain !== domain) {
      return false;
    }
    return true;
  });

  if (sort === "relevance" && searchResults) {
    filtered = filtered.sort((left, right) => searchResults.get(left.docId).rank - searchResults.get(right.docId).rank);
  } else if (sort === "oldest") {
    filtered = filtered.sort((left, right) =>
      String(left.publishedAt || left.scrapedAt).localeCompare(String(right.publishedAt || right.scrapedAt))
    );
  } else if (sort === "title") {
    filtered = filtered.sort((left, right) => left.title.localeCompare(right.title));
  } else if (sort === "published") {
    filtered = filtered.sort((left, right) =>
      String(right.publishedAt || right.scrapedAt).localeCompare(String(left.publishedAt || left.scrapedAt))
    );
  } else {
    filtered = filtered.sort((left, right) =>
      String(right.publishedAt || right.scrapedAt).localeCompare(String(left.publishedAt || left.scrapedAt))
    );
  }

  return filtered;
}

function renderTagChips(article, limit = Infinity) {
  const auto = article.tags.length === 0 && article.autoTags.length > 0;
  // Auto tags are dashed and titled so they are never mistaken for Medium tags.
  const attributes = auto ? ' class="chip chip-auto" title="Generated locally by make rag-tag"' : ' class="chip"';
  return articleTags(article)
    .slice(0, limit)
    .map((tag) => `<a${attributes} href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`)
    .join("");
}

function renderOptions(values, selectedValue, placeholder) {
  const defaultOption = placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : "";
  const items = values.map((value) => {
    const selected = value === selectedValue ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
  });
  return [defaultOption, ...items].join("");
}

const SAFE_URL = /^(https?:\/\/|mailto:|#)/iu;

function renderEmphasis(html) {
  return html
    .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
    .replace(/__(.+?)__/gu, "<strong>$1</strong>")
    .replace(/~~(.+?)~~/gu, "<del>$1</del>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/gu, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/gu, "$1<em>$2</em>");
}

function renderInline(text) {
  // Escape first, then add a small, safe subset of inline Markdown. Code spans,
  // images, and link targets are swapped out for placeholders so emphasis rules
  // never touch them (Medium image ids contain "*", URLs contain "_").
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  let html = escapeHtml(text).replace(/`([^`]+)`/gu, (_match, code) => stash(`<code>${code}</code>`));
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/gu, (match, alt, url) =>
    SAFE_URL.test(url) ? stash(`<img src="${url}" alt="${alt}" loading="lazy">`) : match
  );
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_match, label, url) =>
    SAFE_URL.test(url)
      ? stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${renderEmphasis(label)}</a>`)
      : label
  );

  return renderEmphasis(html).replace(/\u0000(\d+)\u0000/gu, (_match, index) => tokens[Number(index)]);
}

export function renderRichBody(content) {
  if (!content.trim()) {
    return "<p>Article body is missing.</p>";
  }

  // Renders the scraper's Markdown (v4 "markdown" bodies and the simpler
  // Markdown-like v2/v3 "text" bodies) without a third-party parser.
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  const isBlank = (line) => !line.trim();
  const listItem = (line) => line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/u);
  const startsBlock = (line) =>
    /^\s*(```|~~~)/u.test(line) || /^#{1,6}\s/u.test(line) || /^\s*>/u.test(line) || Boolean(listItem(line)) ||
    /^\s*!\[[^\]]*\]\([^)]+\)\s*$/u.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/u.test(line);

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(```|~~~)\s*([\w+#.-]*)/u);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== fence[1]) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}" data-lang="${escapeHtml(fence[2])}"` : "";
      blocks.push(`<pre${language}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/u);
    if (heading) {
      const level = Math.min(6, Math.max(2, heading[1].length));
      blocks.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+$/u, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^([-*_])(\s*\1){2,}$/u.test(trimmed)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/u);
    if (image && SAFE_URL.test(image[2])) {
      const [, alt, src] = image;
      blocks.push(
        `<figure class="article-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ""}</figure>`
      );
      index += 1;
      continue;
    }

    if (/^>/u.test(trimmed)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      const paragraphs = quoted.join("\n").split(/\n\s*\n/u).map((part) => `<p>${part.split("\n").map(renderInline).join("<br>")}</p>`);
      blocks.push(`<blockquote>${paragraphs.join("")}</blockquote>`);
      continue;
    }

    const firstItem = listItem(line);
    if (firstItem) {
      const ordered = Boolean(firstItem[2]);
      const items = [];
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (item && Boolean(item[2]) === ordered) {
          items.push(item[3]);
        } else if (!isBlank(lines[index]) && /^\s{2,}\S/u.test(lines[index]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      const start = ordered && firstItem[2] !== "1" ? ` start="${Number(firstItem[2])}"` : "";
      blocks.push(`<${tag}${start}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block. Medium
    // uses single line breaks deliberately, so keep them as <br>.
    const paragraph = [];
    while (index < lines.length && !isBlank(lines[index]) && (paragraph.length === 0 || !startsBlock(lines[index]))) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
  }

  return blocks.join("\n");
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --panel: #fffaf2;
      --text: #1f1b16;
      --muted: #6f6558;
      --line: #d8c9b2;
      --accent: #1d6b57;
      --accent-soft: #d8efe8;
      --shadow: rgba(46, 35, 18, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(202, 163, 92, 0.15), transparent 24rem),
        linear-gradient(180deg, #f8f3ea 0%, var(--bg) 60%, #efe6d8 100%);
      min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: "SFMono-Regular", Consolas, monospace; }
    .layout {
      width: min(1320px, calc(100vw - 2rem));
      margin: 0 auto;
      padding: 1.25rem 0 2rem;
    }
    .hero {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.5rem 0 1rem;
      border-bottom: 1px solid rgba(31, 27, 22, 0.08);
      margin-bottom: 1rem;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.03em;
    }
    .hero p {
      margin: 0.5rem 0 0;
      color: var(--muted);
      max-width: 44rem;
      font-size: 1rem;
    }
    .eyebrow {
      margin: 0 0 0.65rem !important;
      color: var(--accent) !important;
      font: 700 0.78rem/1 system-ui, sans-serif !important;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .hero-stat {
      min-width: 9rem;
      padding: 1rem 1.1rem;
      border: 1px solid rgba(29, 107, 87, 0.18);
      border-radius: 18px;
      background: var(--accent-soft);
      color: #16463b;
      font-family: system-ui, sans-serif;
    }
    .hero-stat strong, .hero-stat span { display: block; }
    .hero-stat strong { font: 700 2rem/1 system-ui, sans-serif; }
    .hero-stat span { margin-top: 0.35rem; font-size: 0.82rem; }
    .grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 1rem;
      align-items: start;
    }
    .panel {
      background: rgba(255, 250, 242, 0.9);
      border: 1px solid rgba(31, 27, 22, 0.1);
      border-radius: 20px;
      box-shadow: 0 18px 45px var(--shadow);
      backdrop-filter: blur(12px);
    }
    .filters {
      position: sticky;
      top: 1rem;
      padding: 1rem;
    }
    .filters h2, .content h2 {
      margin: 0 0 0.75rem;
      font-size: 0.95rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: system-ui, sans-serif;
    }
    label {
      display: block;
      margin: 0 0 0.35rem;
      font-size: 0.85rem;
      color: var(--muted);
      font-family: system-ui, sans-serif;
    }
    input, select {
      width: 100%;
      padding: 0.8rem 0.9rem;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: white;
      color: var(--text);
      font: inherit;
      margin-bottom: 0.8rem;
    }
    input:focus, select:focus {
      outline: 3px solid rgba(29, 107, 87, 0.18);
      border-color: var(--accent);
    }
    .filter-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .filter-count, .hint {
      color: var(--muted);
      font: 0.78rem system-ui, sans-serif;
    }
    .hint { margin: -0.35rem 0 1rem; line-height: 1.4; }
    details { margin: 0.6rem 0; }
    summary {
      margin-bottom: 0.8rem;
      cursor: pointer;
      color: var(--accent);
      font: 700 0.8rem system-ui, sans-serif;
    }
    .filter-actions {
      display: flex;
      gap: 0.6rem;
      margin-top: 0.4rem;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      padding: 0 1rem;
      border-radius: 999px;
      border: 1px solid rgba(29, 107, 87, 0.15);
      background: var(--accent);
      color: white;
      font-weight: 600;
      font-family: system-ui, sans-serif;
      text-decoration: none;
      cursor: pointer;
    }
    .button.secondary {
      background: transparent;
      color: var(--accent);
    }
    .content {
      padding: 1rem;
    }
    .summary {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1rem;
      font-family: system-ui, sans-serif;
      color: var(--muted);
    }
    .cards {
      display: grid;
      gap: 0.9rem;
    }
    .card {
      padding: 1rem 1.1rem;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.85), rgba(250,242,228,0.9));
      border: 1px solid rgba(31, 27, 22, 0.08);
    }
    .card h3, .article h1 {
      margin: 0 0 0.4rem;
      line-height: 1.05;
    }
    .card h3 {
      font-size: clamp(1.35rem, 2vw, 1.75rem);
      letter-spacing: -0.02em;
    }
    .article h1 {
      font-size: clamp(2rem, 5vw, 3.5rem);
      letter-spacing: -0.035em;
    }
    .card h3 a { color: var(--text); }
    .card h3 a:hover { color: var(--accent); }
    .meta, .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin: 0.55rem 0;
      font-family: system-ui, sans-serif;
      color: var(--muted);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 0.22rem 0.6rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #16463b;
      font-size: 0.82rem;
    }
    a.chip { text-decoration: none; }
    a.chip:hover { text-decoration: none; filter: brightness(0.95); }
    .chip-auto {
      background: transparent;
      border: 1px dashed rgba(29, 107, 87, 0.45);
    }
    .snippet {
      margin: 0 0 0.6rem;
      color: var(--muted);
      font: 0.9rem/1.5 system-ui, sans-serif;
    }
    .snippet mark {
      background: rgba(202, 163, 92, 0.35);
      color: inherit;
      border-radius: 3px;
      padding: 0 0.1rem;
    }
    .excerpt {
      margin: 0.4rem 0 0.8rem;
      color: #423a31;
      line-height: 1.55;
    }
    .card-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.8rem;
      margin-top: 0.9rem;
    }
    .small-button {
      min-height: 2.2rem;
      padding: 0 0.8rem;
      font-size: 0.82rem;
    }
    .text-link {
      color: var(--accent);
      font: 700 0.82rem system-ui, sans-serif;
    }
    .muted-link { color: var(--muted); }
    .article {
      width: min(860px, calc(100vw - 2rem));
      margin: 0 auto;
      padding: 1rem 1rem 2rem;
    }
    .article-body {
      line-height: 1.8;
      font-size: 1.06rem;
      padding: 1.2rem;
      border-radius: 18px;
      background: rgba(255, 250, 242, 0.92);
      border: 1px solid rgba(31, 27, 22, 0.08);
      box-shadow: 0 18px 45px var(--shadow);
    }
    .article-body > *:first-child {
      margin-top: 0;
    }
    .article-body p, .article-body blockquote, .article-body pre, .article-body figure {
      margin: 0 0 1rem;
    }
    .article-body pre {
      overflow-x: auto;
      padding: 1rem;
      border-radius: 14px;
      background: #1b1f24;
      color: #f7f7f7;
      line-height: 1.6;
      font-size: 0.95rem;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
    }
    .article-body code {
      font-family: "SFMono-Regular", Consolas, monospace;
    }
    .article-body h2, .article-body h3, .article-body h4, .article-body h5, .article-body h6 {
      margin: 1.8rem 0 0.7rem;
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .article-body h2 { font-size: 1.6rem; }
    .article-body h3 { font-size: 1.35rem; }
    .article-body h4, .article-body h5, .article-body h6 { font-size: 1.12rem; }
    .article-body ul, .article-body ol { margin: 0 0 1rem; padding-left: 1.6rem; }
    .article-body li { margin: 0.25rem 0; }
    .article-body hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
    .article-body :not(pre) > code {
      padding: 0.1rem 0.35rem;
      border-radius: 6px;
      background: rgba(31, 27, 22, 0.07);
      font-size: 0.92em;
    }
    .article-body pre[data-lang]::before {
      content: attr(data-lang);
      display: block;
      margin-bottom: 0.5rem;
      color: #9aa4af;
      font: 600 0.72rem system-ui, sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .article-body blockquote p:last-child { margin-bottom: 0; }
    .article-cover {
      width: 100%;
      max-height: 420px;
      object-fit: cover;
      display: block;
      border-radius: 18px;
      margin-bottom: 1rem;
      border: 1px solid rgba(31, 27, 22, 0.08);
    }
    .article-body blockquote {
      padding: 0.8rem 1rem;
      border-left: 4px solid var(--accent);
      background: rgba(29, 107, 87, 0.08);
      color: #3f423c;
    }
    .article-figure img {
      width: 100%;
      height: auto;
      display: block;
      border-radius: 14px;
      border: 1px solid rgba(31, 27, 22, 0.08);
    }
    .article-figure figcaption {
      margin-top: 0.55rem;
      font-size: 0.92rem;
      color: var(--muted);
      font-family: system-ui, sans-serif;
    }
    .article-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      font-family: system-ui, sans-serif;
    }
    .empty {
      padding: 2rem;
      text-align: center;
      color: var(--muted);
    }
    .data-note { font-size: 0.82rem; }
    .live-dot {
      display: inline-block;
      width: 0.55rem;
      height: 0.55rem;
      margin-right: 0.3rem;
      border-radius: 50%;
      background: #2f9d72;
      box-shadow: 0 0 0 4px rgba(47, 157, 114, 0.12);
    }
    @media (max-width: 920px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .filters {
        position: static;
      }
      .summary, .hero, .article-top {
        flex-direction: column;
        align-items: start;
      }
      .hero-stat { width: 100%; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function safeSearch(text) {
  try {
    return searchArticles(text) ?? undefined;
  } catch (error) {
    // Never fail the page over search: fall back to plain substring matching.
    console.error(`search failed, using substring match: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function renderIndex(articles, query) {
  const searchResults = (query.q ?? "").trim() ? safeSearch(query.q) : undefined;
  const filtered = filterArticles(articles, query, searchResults);
  const tags = tokenize(articles.flatMap((article) => articleTags(article)));
  const authors = tokenize(articles.map((article) => article.author));
  const languages = tokenize(articles.map((article) => article.language));
  const domains = tokenize(articles.map((article) => article.domain));

  const cards = filtered.length
    ? filtered
        .map((article) => {
          const chips = [
            article.author ? `<span class="chip">${escapeHtml(article.author)}</span>` : "",
            article.language ? `<span class="chip">${escapeHtml(article.language)}</span>` : "",
            article.domain ? `<span class="chip">${escapeHtml(article.domain)}</span>` : "",
            article.wordCount ? `<span class="chip">${article.wordCount} words</span>` : ""
          ]
            .filter(Boolean)
            .join("");
          const tagChips = renderTagChips(article, 6);
          const sourceLinks = [
            article.freediumUrl ? `<a class="button small-button" href="${escapeHtml(article.freediumUrl)}" target="_blank" rel="noopener noreferrer">Open in Freedium ↗</a>` : "",
            article.sourceUrl ? `<a class="text-link muted-link" href="${escapeHtml(article.sourceUrl)}" target="_blank" rel="noreferrer">Original ↗</a>` : ""
          ].filter(Boolean).join("");

          return `<article class="card">
  <h3><a href="/article/${encodeURIComponent(article.docId)}">${escapeHtml(article.title)}</a></h3>
  <div class="meta">
    <span>${article.author ? `By ${escapeHtml(article.author)} · ` : ""}${escapeHtml(formatDate(article.publishedAt || article.scrapedAt))}</span>
  </div>
  <div class="chips">${chips}${tagChips}</div>
  ${article.excerpt ? `<p class="excerpt">${escapeHtml(article.excerpt)}</p>` : ""}
  ${searchResults?.get(article.docId)?.snippet ? `<p class="snippet">${renderSnippet(searchResults.get(article.docId).snippet)}</p>` : ""}
  <div class="card-actions"><a class="button" href="/article/${encodeURIComponent(article.docId)}">Read article</a>${sourceLinks}</div>
</article>`;
        })
        .join("")
    : '<div class="empty panel"><p>No articles matched the current filters.</p></div>';

  return pageShell(
    "Article Reader",
    `<main class="layout">
  <section class="hero">
    <div>
      <p class="eyebrow">Your local reading library</p>
      <h1>Find something worth keeping.</h1>
      <p>Search across ${articles.length} saved articles, then read the clean local copy with the original and Freedium links beside it.</p>
    </div>
    <div class="hero-stat"><strong>${articles.length}</strong><span>articles saved</span></div>
  </section>
  <section class="grid">
    <form class="filters panel" method="get" action="/">
      <div class="filter-heading"><h2>Find an article</h2><span class="filter-count">${filtered.length} results</span></div>
      <label for="q">Search everything</label>
      <input id="q" name="q" value="${escapeHtml(query.q ?? "")}" placeholder="Try: Go concurrency, Kubernetes, AI" autofocus>
      <p class="hint">Ranked full-text search over titles, tags, authors, and article text. Word starts match: "kube" finds Kubernetes.</p>
      <details ${query.title || query.tag || query.author || query.language || query.domain ? "open" : ""}>
        <summary>More filters</summary>
      <label for="title">Title search</label>
      <input id="title" name="title" value="${escapeHtml(query.title ?? "")}" placeholder="Search article title">
      <label for="tag">Tag</label>
      <select id="tag" name="tag">${renderOptions(tags, query.tag ?? "", "All tags")}</select>
      <label for="author">Author</label>
      <select id="author" name="author">${renderOptions(authors, query.author ?? "", "All authors")}</select>
      <label for="language">Language</label>
      <select id="language" name="language">${renderOptions(languages, query.language ?? "", "All languages")}</select>
      <label for="domain">Source domain</label>
      <select id="domain" name="domain">${renderOptions(domains, query.domain ?? "", "All domains")}</select>
      <label for="sort">Sort</label>
      <select id="sort" name="sort">${renderOptions(["relevance", "published", "oldest", "title"], query.sort ?? "", "Auto (best match when searching)")}</select>
      </details>
      <div class="filter-actions">
        <button class="button" type="submit">Search library</button>
        <a class="button secondary" href="/">Reset</a>
      </div>
    </form>
    <section class="content panel">
      <div class="summary">
        <div><strong>${filtered.length}</strong> ${filtered.length === 1 ? "article" : "articles"} shown${query.q || query.title || query.tag || query.author || query.language || query.domain ? " · filters active" : ""}</div>
        <div class="data-note"><span class="live-dot"></span> Reading from <code>data/output/</code></div>
      </div>
      <div class="cards">${cards}</div>
    </section>
  </section>
</main>`
  );
}

export function renderArticle(article) {
  const chips = [
    article.author ? `<span class="chip">${escapeHtml(article.author)}</span>` : "",
    article.language ? `<span class="chip">${escapeHtml(article.language)}</span>` : "",
    article.domain ? `<span class="chip">${escapeHtml(article.domain)}</span>` : "",
    article.wordCount ? `<span class="chip">${article.wordCount} words</span>` : ""
  ]
    .filter(Boolean)
    .join("");
  const tags = renderTagChips(article);
  const author = article.author ? escapeHtml(article.author) : "";
  const sourceDetails = [
    author ? `By ${author}` : "",
    article.siteName ? escapeHtml(article.siteName) : "",
    article.wordCount ? `${article.wordCount.toLocaleString()} words` : "",
    article.readingTimeMinutes ? `${article.readingTimeMinutes} min read` : "",
    article.scraperMetadataVersion ? `metadata v${escapeHtml(article.scraperMetadataVersion)}` : ""
  ].filter(Boolean).join(' <span aria-hidden="true">·</span> ');

  return pageShell(
    article.title,
    `<main class="article">
  <div class="article-top">
    <a class="button secondary" href="/">Back to library</a>
    <div class="filter-actions">
      ${article.sourceUrl ? `<a class="button secondary" href="${escapeHtml(article.sourceUrl)}" target="_blank" rel="noreferrer">Original article</a>` : ""}
      ${article.freediumUrl ? `<a class="button" href="${escapeHtml(article.freediumUrl)}" target="_blank" rel="noreferrer">Open Freedium</a>` : ""}
    </div>
  </div>
  <section class="panel" style="padding: 1.25rem; margin-bottom: 1rem;">
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">
      <span>Published ${escapeHtml(formatDate(article.publishedAt || article.scrapedAt))}</span>
      <span>Stored at ${escapeHtml(path.basename(article.path))}</span>
    </div>
    ${sourceDetails ? `<div class="meta">${sourceDetails}</div>` : ""}
    <div class="chips">${chips}${tags}</div>
    ${article.excerpt ? `<p class="excerpt">${escapeHtml(article.excerpt)}</p>` : ""}
  </section>
  ${article.coverImage ? `<img class="article-cover" src="${escapeHtml(article.coverImage)}" alt="" loading="lazy">` : ""}
  <article class="article-body">${renderRichBody(article.body || "")}</article>
</main>`
  );
}

function toApiArticle(article, includeBody) {
  const { body, searchText, ...rest } = article;
  return { ...rest, effectiveTags: articleTags(article), ...(includeBody ? { body } : {}) };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

export async function handler(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const articles = await loadArticles();

  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderIndex(articles, Object.fromEntries(url.searchParams.entries())));
    return;
  }

  if (url.pathname === "/api/articles") {
    // Catalogue only: bodies are fetched per article, which keeps this
    // response small (it used to ship every article body, ~8 MB).
    sendJson(response, 200, articles.map((article) => toApiArticle(article, false)));
    return;
  }

  if (url.pathname.startsWith("/api/articles/")) {
    const docId = decodeURIComponent(url.pathname.slice("/api/articles/".length));
    const article = articles.find((entry) => entry.docId === docId);
    if (!article) {
      sendJson(response, 404, { error: "Article not found" });
      return;
    }
    sendJson(response, 200, toApiArticle(article, true));
    return;
  }

  if (url.pathname.startsWith("/article/")) {
    const docId = decodeURIComponent(url.pathname.slice("/article/".length));
    const article = articles.find((entry) => entry.docId === docId);
    if (!article) {
      response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      response.end(pageShell("Not Found", '<main class="article"><div class="empty panel">Article not found.</div></main>'));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderArticle(article));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

export function startServer(port = DEFAULT_PORT, host = DEFAULT_HOST) {
  return createServer((request, response) => {
    handler(request, response).catch((error) => {
      console.error(error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal server error");
    });
  }).listen(port, host, () => {
    console.log(`reader running at http://${host}:${port}`);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (invokedPath === import.meta.url) {
  const port = parsePort(process.argv.slice(2));
  startServer(port);
}
