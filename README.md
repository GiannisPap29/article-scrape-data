# web-scrapper

Save Medium links in a Google Drive folder; this project downloads the full
articles through [Freedium](https://freedium-mirror.cfd/), keeps them as local
Markdown files, gives you a reader website with full-text search, and builds a
local AI index so you (or Claude) can ask questions across everything you saved.
Everything runs on your machine: Ollama for the AI, SQLite for storage.

## How it works

```
You save a Medium link in Drive → MEDIUM folder
        │
 make run
        ├─ 1. ingest        read MEDIUM; new links → queue; file → MEDIUM_ARCHIVED
        │                   (already scraped/queued → archived; no valid link → MEDIUM_FAILED)
        ├─ 2. scrape-queue  open freedium-mirror.cfd/<link>, save .txt (Markdown) + .json (metadata)
        │                   success → link moves from queue to history; failure → retried later
        ├─ 3. backup-db     upload data/library.db to Drive MEDIUM/MEDIUM_BACKUPS
        ├─ 4. rag-sync      tell the AI index about new/changed articles
        ├─ 5. rag-tag       local AI (gemma3) tags articles that have no tags
        └─ 6. rag-ingest    split articles into passages, embed them (embeddinggemma)
        │
Use it: reader website · make rag-ask · Claude via MCP
```

Three apps share one `data/` folder and nothing else:

| App | Language | Job |
|---|---|---|
| `apps/scraper` | TypeScript (Node 22, Playwright) | Drive, Freedium, article files, `library.db`, backups |
| `apps/reader` | Node.js, no dependencies | Local reading website with ranked full-text search |
| `apps/rag` | Python (sqlite-vec, Ollama, MCP) | Tags, AI index, questions, MCP server for Claude |

## Setup

Requirements: Node.js 22.13+, Python 3, Google Chrome, [Ollama](https://ollama.com/download), Docker (only for `make reader-up`).

```bash
cp .env.example .env      # then set DRIVE_FOLDER_ID (the MEDIUM folder id)
make setup                # npm packages, Python venv, Ollama models
```

Google access (one time):

1. In Google Cloud, enable the **Google Drive API** and the **Google Docs API**.
2. Create an OAuth client of type **Desktop app** and save its JSON as `data/oauth/google-client.json`.
3. The first Drive command opens a browser to log in; the token is saved to `data/oauth/google-token.json` (only your user can read it).

Drive layout: `MEDIUM/` is the inbox. `MEDIUM_ARCHIVED`, `MEDIUM_FAILED`, and
`MEDIUM_BACKUPS` are used (and created if missing) inside it, unless you set
their ids in `.env`. Each file in MEDIUM holds one article link; Google Docs
and plain text files both work.

## Daily use

```bash
make run          # everything
make status       # what happened, what failed, what is left to index
make reader-up    # reader at http://127.0.0.1:3010 (stays on)
make rag-ask QUESTION="how do I handle errors in Go"
```

`make run` only does new work: already-scraped links are skipped, and only new
or changed articles are tagged and indexed. A lock (`data/.run.lock`) stops a
second `make run` from starting while one is running. Interrupted? Just run it
again; every step resumes where it stopped.

## Commands

`make` prints this list.

| Group | Command | What it does |
|---|---|---|
| Every day | `make run` | Everything, steps 1–6 above |
| | `make status` | Counts, queue errors, how many articles are indexed |
| Read and ask | `make reader` | Reader website in this terminal |
| | `make reader-up` / `reader-down` / `reader-logs` | Same, always on in Docker |
| | `make rag-ask QUESTION=".."` | Answer from your articles, with sources |
| | `make rag-sources QUESTION=".."` | Only the matching passages, no AI answer (fast) |
| The steps | `make ingest` | 1. Drive → queue |
| | `make scrape-queue` | 2. Queue → Freedium → files + history |
| | `make backup-db` | 3. `library.db` → Drive |
| | `make rag-sync` | 4. New/changed articles → AI index list |
| | `make rag-tag` | 5. Auto-tag untagged articles |
| | `make rag-ingest` | 6. Build the AI index (`FORCE=1` rebuilds all) |
| Failures | `make retry-failed` | Give failed / gave-up links another try |
| Safety net | `make export-urls` | All scraped links → `data/backups/scraped-urls.txt` |
| | `make requeue-urls FILE=..` | Queue links from a text file, then `make run` |
| | `make rescan` | Re-download every article in the history |
| Dangerous | `make reset-db` | Delete the scraped history (snapshot saved first) |
| | `make clean-output` | Delete all article files |
| | `make clean-debug` | Delete failed-scrape screenshots |
| Schedule | `make schedule-install` / `schedule-status` / `schedule-remove` | Optional nightly `make run` at 03:30 |
| Setup | `make setup` | Install / repair everything |
| | `make test` | Unit tests for all three apps (no network, no real data) |
| | `make rag-index` / `rag-index-doc DOC_ID=..` | Look inside the AI index |

## Where things are stored

| Path | Contents |
|---|---|
| `data/output/` | The articles: `<slug>-<hash>.txt` (body) + `.json` (metadata) |
| `data/library.db` | SQLite: `scraped_urls` (history) + `url_from_drive` (queue) |
| `data/backups/` | `scraped-urls.txt` (all links), snapshots before `reset-db` |
| `data/state/` | AI index: `vectors.db` (sqlite-vec) + `manifest.json` (bookkeeping, auto tags) |
| `data/debug/` | HTML + screenshot of each failed scrape |
| `data/oauth/` | Google client + token |

`data/` is git-ignored as a whole.

## Your URL list (safety net)

Your scraped links exist in several places: `data/library.db`,
`data/backups/scraped-urls.txt` (rewritten by every `make run`), the Drive copy
`MEDIUM/MEDIUM_BACKUPS/library.db`, and the `sourceUrl` in every `.json`. The
original link files also stay in `MEDIUM_ARCHIVED`.

- Article files deleted, database fine → `make rescan`.
- `library.db` lost → `make requeue-urls FILE=data/backups/scraped-urls.txt`, then `make run`.
- `make reset-db` first saves `data/backups/library-before-reset-<time>.db` and the link list.

## Scraping details

- One browser per run, a fresh tab per article, opened as `<FREEDIUM_URL>/<article-url>`.
  The Freedium homepage form is the fallback, then each mirror in
  `FREEDIUM_FALLBACK_URLS`. An anti-bot page skips to the next mirror.
- A random 3–8 s pause (`SCRAPE_DELAY_MS`) separates articles.
- Failed links are retried on later runs after 15 min, 30 min, 1 h, … up to
  12 h, at most `MAX_SCRAPE_ATTEMPTS` (5) times; then they show as "gave up" in
  `make status` until `make retry-failed`. A Freedium "article not found" page
  gives up immediately.
- Files are written atomically (temp file + rename), `.txt` before `.json`.
- Links are normalized (tracking parameters removed, links pasted from any
  Freedium mirror unwrapped). Medium profile, tag, and reading-list links are
  rejected.

## Article format

`.txt`: the article body. Since `scraperMetadataVersion` 4 it is the Markdown
Freedium embeds in its page: real headings, lists, links, and code blocks with
their language. Images point to permanent `miro.medium.com` URLs.

`.json` (v4) fields: `docId`, `title`, `author`, `excerpt`, `publishedAt`,
`readingTimeMinutes`, `coverImage`, `siteName` (`Medium` or the custom domain),
`sourceUrl`, `freediumUrl`, `freedium` (`free`, `publication`, `updatedAt`,
`url`), `tags`, `language`, `contentFormat` (`markdown`, or `text` when rebuilt
from the page HTML), `contentHash`, `scrapedAt`, `batchId`, `outputPath` and
`metadataPath` (file names next to the `.json`), `scraperMetadataVersion`.

Older v2/v3 files (plain text, absolute paths, sometimes wrong authors) are
still read by the reader and the AI index; `make rescan` upgrades them.

Tags: Freedium stopped showing Medium tags in 2026-06. A re-scrape keeps tags an
older `.json` already had; other articles get tags from `make rag-tag`, stored in
`data/state/manifest.json` (the article files are never changed by the AI app).

## Reader

- Ranked full-text search (SQLite FTS5 in memory): stemming ("error" finds
  "errors"), word starts ("kube" finds Kubernetes), highlighted snippets.
- Filters for tag, author, language, and site; clickable tag chips (auto tags
  are dashed).
- Articles render as Markdown with cover image and reading time.
- New scrapes appear within 2 s, no restart needed.
- JSON API: `GET /api/articles` (catalogue) and `GET /api/articles/<docId>` (with body).

The Docker container mounts `data/output` and `data/state` read-only.

## AI search (RAG)

- Models run in Ollama: `RAG_EMBED_MODEL` (default `embeddinggemma`) turns
  passages and questions into vectors; `RAG_MODEL` (default `gemma3:1b`; try
  `gemma4:e4b` for better answers) writes answers and tags.
- Articles are split into ~1400-character passages; each embedding model gets
  its own collection in `data/state/vectors.db` (sqlite-vec, exact cosine search).
- An article is re-indexed when its text, the embedding model, or the chunking
  changes; progress is saved after every article. Deleted articles are removed
  from the index on the next sync + ingest.
- Answers use at most 2 passages per article so one long article can't fill
  every source slot.
- Memory: only one model is loaded at a time, with a capped context. On CPU,
  indexing takes ~25 s and tagging ~7–20 s per article.

### Claude (MCP)

`.mcp.json` registers the read-only MCP server `medium-library`
(`apps/rag/src/mcp_server.py`). Start Claude Code in this folder and approve it.
Tools: `search_articles`, `get_article`, `list_articles`, `library_stats`.
It needs Ollama running and an indexed library.

## Nightly schedule (optional)

`make schedule-install` adds a systemd user timer: `make run` at 03:30, headless,
low CPU/disk priority, with a desktop notification. If the machine was off, it
runs at the next boot. If the Google login expires, the Drive step fails but
queued links are still scraped; run `make ingest` once by hand to log in again.

## Troubleshooting

| Problem | Fix |
|---|---|
| `rag-*` fails with `ModuleNotFoundError` after an OS upgrade | `make setup` (rebuilds the venv) |
| Google asks to log in again | Run `make ingest` in a terminal and approve in the browser |
| Every scrape fails | Freedium mirror changed: set `FREEDIUM_URL` / `FREEDIUM_FALLBACK_URLS`; see `data/debug/` |
| Machine freezes during AI steps | Close heavy apps; run `make rag-tag` and `make rag-ingest` separately |
| A link "gave up" | `make status` shows why; `make retry-failed` to try again |

## References

- Google OAuth for desktop apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google Drive `files.list`: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- Ollama: https://docs.ollama.com/
- sqlite-vec: https://github.com/asg017/sqlite-vec
- MCP Python SDK: https://py.sdk.modelcontextprotocol.io/
