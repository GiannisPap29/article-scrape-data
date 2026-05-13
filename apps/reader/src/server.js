import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const OUTPUT_DIR = path.resolve(process.env.READER_OUTPUT_DIR ?? path.join(PROJECT_ROOT, "data/output"));
const DEFAULT_PORT = 3010;
const DEFAULT_HOST = process.env.READER_HOST ?? "127.0.0.1";

function parsePort(argv) {
  const arg = argv.find((entry) => entry.startsWith("--port="));
  if (arg) {
    return Number.parseInt(arg.slice("--port=".length), 10);
  }
  if (process.env.PORT) {
    return Number.parseInt(process.env.PORT, 10);
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

function buildTextPath(sidecarPath, outputPath) {
  const fallbackPath = sidecarPath.replace(/\.json$/i, ".txt");
  if (!outputPath) {
    return fallbackPath;
  }

  const outputBasename = path.basename(outputPath);
  const mountedOutputPath = path.join(OUTPUT_DIR, outputBasename);

  if (path.isAbsolute(outputPath)) {
    if (outputPath.startsWith(`${OUTPUT_DIR}${path.sep}`) || outputPath === mountedOutputPath) {
      return outputPath;
    }
    return mountedOutputPath;
  }

  const resolved = path.resolve(PROJECT_ROOT, outputPath);
  if (resolved.startsWith(`${OUTPUT_DIR}${path.sep}`) || path.basename(resolved) === outputBasename) {
    return mountedOutputPath;
  }

  return fallbackPath;
}

function tokenize(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)))];
}

export async function loadArticles() {
  const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
  const sidecars = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const articles = [];

  for (const entry of sidecars) {
    const sidecarPath = path.join(OUTPUT_DIR, entry.name);
    let metadata;
    try {
      metadata = JSON.parse(await readFile(sidecarPath, "utf8"));
    } catch {
      continue;
    }

    const textPath = buildTextPath(sidecarPath, metadata.outputPath);
    let body = "";
    try {
      body = await readFile(textPath, "utf8");
    } catch {
      body = "";
    }

    const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag)) : [];
    const author = metadata.author ? String(metadata.author) : "";
    const language = metadata.language ? String(metadata.language) : "";
    const domain = toDomain(metadata.sourceUrl);
    const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

    articles.push({
      author,
      body,
      docId: String(metadata.docId ?? path.basename(entry.name, ".json")),
      domain,
      excerpt: metadata.excerpt ? String(metadata.excerpt) : "",
      language,
      path: textPath,
      publishedAt: metadata.publishedAt ? String(metadata.publishedAt) : "",
      scrapedAt: metadata.scrapedAt ? String(metadata.scrapedAt) : "",
      sourceUrl: metadata.sourceUrl ? String(metadata.sourceUrl) : "",
      tags,
      title: metadata.title ? String(metadata.title) : path.basename(entry.name, ".json"),
      wordCount
    });
  }

  articles.sort((left, right) => String(right.scrapedAt).localeCompare(String(left.scrapedAt)));
  return articles;
}

export function filterArticles(articles, query) {
  const q = (query.q ?? "").trim().toLowerCase();
  const titleQuery = (query.title ?? "").trim().toLowerCase();
  const tag = (query.tag ?? "").trim();
  const author = (query.author ?? "").trim();
  const language = (query.language ?? "").trim();
  const domain = (query.domain ?? "").trim();
  const sort = (query.sort ?? "newest").trim();

  let filtered = articles.filter((article) => {
    if (titleQuery && !article.title.toLowerCase().includes(titleQuery)) {
      return false;
    }
    if (tag && !article.tags.includes(tag)) {
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
    if (!q) {
      return true;
    }

    const haystack = [
      article.title,
      article.excerpt,
      article.author,
      article.language,
      article.domain,
      article.tags.join(" ")
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(q);
  });

  if (sort === "oldest") {
    filtered = filtered.sort((left, right) => String(left.scrapedAt).localeCompare(String(right.scrapedAt)));
  } else if (sort === "title") {
    filtered = filtered.sort((left, right) => left.title.localeCompare(right.title));
  } else if (sort === "published") {
    filtered = filtered.sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)));
  } else {
    filtered = filtered.sort((left, right) => String(right.scrapedAt).localeCompare(String(left.scrapedAt)));
  }

  return filtered;
}

function renderOptions(values, selectedValue, placeholder) {
  const defaultLabel = selectedValue || placeholder;
  const defaultOption = `<option value="">${escapeHtml(defaultLabel)}</option>`;
  const items = values.map((value) => {
    const selected = value === selectedValue ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
  });
  return [defaultOption, ...items].join("");
}

function renderRichBody(content) {
  if (!content.trim()) {
    return '<p>Article body is missing.</p>';
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let inCodeBlock = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(`<p>${escapeHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed === "```") {
      flushParagraph();
      if (inCodeBlock) {
        blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const imageMatch = trimmed.match(/^!\[(.*)\]\((https?:\/\/.+)\)$/u);
    if (imageMatch) {
      flushParagraph();
      const [, alt, src] = imageMatch;
      blocks.push(
        `<figure class="article-figure"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ""}</figure>`
      );
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("> ")) {
      flushParagraph();
      blocks.push(`<blockquote>${escapeHtml(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  if (codeLines.length > 0) {
    blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
    .excerpt {
      margin: 0.4rem 0 0.8rem;
      color: #423a31;
      line-height: 1.55;
    }
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
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderIndex(articles, query) {
  const filtered = filterArticles(articles, query);
  const tags = tokenize(articles.flatMap((article) => article.tags));
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
          const tagChips = article.tags
            .slice(0, 6)
            .map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`)
            .join("");

          return `<article class="card">
  <h3><a href="/article/${encodeURIComponent(article.docId)}">${escapeHtml(article.title)}</a></h3>
  <div class="meta">
    <span>Scraped ${escapeHtml(formatDate(article.scrapedAt))}</span>
    ${article.publishedAt ? `<span>Published ${escapeHtml(formatDate(article.publishedAt))}</span>` : ""}
  </div>
  <div class="chips">${chips}${tagChips}</div>
  ${article.excerpt ? `<p class="excerpt">${escapeHtml(article.excerpt)}</p>` : ""}
  <a class="button secondary" href="/article/${encodeURIComponent(article.docId)}">Read article</a>
</article>`;
        })
        .join("")
    : '<div class="empty panel"><p>No articles matched the current filters.</p></div>';

  return pageShell(
    "Article Reader",
    `<main class="layout">
  <section class="hero">
    <div>
      <h1>Article Reader</h1>
      <p>Browse the local article corpus from <code>data/output/</code>. Search by metadata, filter by tags and source, and open full text for reading.</p>
    </div>
  </section>
  <section class="grid">
    <form class="filters panel" method="get" action="/">
      <h2>Filters</h2>
      <label for="title">Title search</label>
      <input id="title" name="title" value="${escapeHtml(query.title ?? "")}" placeholder="Search article title">
      <label for="q">Search title, excerpt, tags</label>
      <input id="q" name="q" value="${escapeHtml(query.q ?? "")}" placeholder="Go, Kafka, architecture, retries">
      <label for="tag">Tag</label>
      <select id="tag" name="tag">${renderOptions(tags, query.tag ?? "", "All tags")}</select>
      <label for="author">Author</label>
      <select id="author" name="author">${renderOptions(authors, query.author ?? "", "All authors")}</select>
      <label for="language">Language</label>
      <select id="language" name="language">${renderOptions(languages, query.language ?? "", "All languages")}</select>
      <label for="domain">Source domain</label>
      <select id="domain" name="domain">${renderOptions(domains, query.domain ?? "", "All domains")}</select>
      <label for="sort">Sort</label>
      <select id="sort" name="sort">${renderOptions(["newest", "oldest", "title", "published"], query.sort ?? "newest", "Newest")}</select>
      <div class="filter-actions">
        <button class="button" type="submit">Apply</button>
        <a class="button secondary" href="/">Reset</a>
      </div>
    </form>
    <section class="content panel">
      <div class="summary">
        <div>${filtered.length} articles shown of ${articles.length}</div>
        <div>Live from ${escapeHtml(OUTPUT_DIR)}</div>
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
  const tags = article.tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");

  return pageShell(
    article.title,
    `<main class="article">
  <div class="article-top">
    <a class="button secondary" href="/">Back to library</a>
    ${article.sourceUrl ? `<a class="button" href="${escapeHtml(article.sourceUrl)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
  </div>
  <section class="panel" style="padding: 1.25rem; margin-bottom: 1rem;">
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">
      <span>Scraped ${escapeHtml(formatDate(article.scrapedAt))}</span>
      ${article.publishedAt ? `<span>Published ${escapeHtml(formatDate(article.publishedAt))}</span>` : ""}
      <span>Stored at ${escapeHtml(path.basename(article.path))}</span>
    </div>
    <div class="chips">${chips}${tags}</div>
    ${article.excerpt ? `<p class="excerpt">${escapeHtml(article.excerpt)}</p>` : ""}
  </section>
  <article class="article-body">${renderRichBody(article.body || "")}</article>
</main>`
  );
}

export async function handler(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const articles = await loadArticles();

  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(renderIndex(articles, Object.fromEntries(url.searchParams.entries())));
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
