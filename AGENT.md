# AGENT

Instructions for AI coding agents working in this repo. User-facing docs are in
`README.md`.

## Purpose

Medium links saved in a Google Drive inbox (`MEDIUM`) are staged in a queue,
scraped through Freedium, and stored as `.txt` (Markdown body) + `.json`
(metadata) pairs in `data/output/`. A reader app serves them; a RAG app tags
and indexes them for local questions and an MCP server.

## Apps and the shared contract

- `apps/scraper` (TypeScript): Drive ingest, Freedium scraping, `data/library.db`, backups
- `apps/reader` (Node, no deps): read-only website over `data/output` (+ auto tags from `data/state`)
- `apps/rag` (Python): manifest, auto tags, sqlite-vec index, `rag-ask`, MCP server

`data/` is the only contract between them. The scraper owns `data/output`,
`data/library.db`, `data/backups`, `data/debug`; the RAG app owns `data/state`.

## Flow

`make run` = scraper `--run` (ingest -> scrape queue -> URL list export ->
Drive backup), then `rag-sync` -> `rag-tag` -> `rag-ingest`. It is guarded by
`data/.run.lock`. Inside the recipe the scraper exit code decides: `0` ok, `2`
some URLs failed (RAG still runs), other = crash (RAG skipped). make itself
exits 0/2.

Ingest, per Drive file in MEDIUM (oldest first): extract exactly one article
URL; already in history or queue -> move file to `MEDIUM_ARCHIVED`; new ->
insert into the queue, then archive; no valid URL -> `MEDIUM_FAILED`.
Archive/failed/backup folders are resolved inside the inbox first, then next to
it (older layout), else created inside the inbox. Backups never go into the
inbox itself.

Scrape queue, per due row (oldest first): open `<mirror>/<url>` (form and
fallback mirrors as fallbacks), write `.txt` then `.json`, then
`promoteQueuedUrl` (history upsert + queue delete in one transaction). On
failure: `last_error`, `attempts`, `next_retry_at` (15 min doubling, max 12 h);
after `MAX_SCRAPE_ATTEMPTS` or a Freedium 404 the row stays as "gave up" until
`make retry-failed`. A debug HTML + screenshot goes to `data/debug/`.

## Database (`data/library.db`)

- `url_from_drive(source_url, drive_file_id, drive_file_name, queued_at, last_error, attempts, next_retry_at)`: retryable queue
- `scraped_urls(source_url, output_path, scraped_at, doc_id, title, author, site_name, excerpt, freedium_url, metadata_path, content_hash, published_at, language, tags_json)`: success history

RAG state (`data/state/`): `manifest.json` (per-document sync/index/tag
bookkeeping) and `vectors.db` (`chunks` table + `vec_<collection>` tables).

## Design rules

1. Manual-first: `make run` is the entry point. The nightly timer in
   `deploy/systemd/` is only installed by `make schedule-install`; never install
   or enable it automatically.
2. Never scrape directly from Drive ingest; always go through the queue.
3. Never promote a queue row before both output files are written.
4. `scraped_urls` is success history only; `url_from_drive` is the retry queue.
5. One normalized URL maps to one stable `<slug>-<hash>.txt`/`.json` pair; never
   create variants like `slug-2.txt`.
6. Drive parse failures go to the failure folder; scrape failures stay queued
   with `last_error`.
7. Article metadata is written by the scraper only. The RAG app never edits
   `data/output` (auto tags live in the manifest).
8. `data/output/` holds only `.txt`/`.json` pairs; write them atomically,
   `.txt` before `.json`.
9. Sidecar `outputPath`/`metadataPath` are file names relative to the sidecar
   (v4); `library.db` keeps absolute paths. Readers must accept v2/v3 sidecars
   (absolute paths) until every article is rescanned.
10. Prefer Freedium's embedded article data (`freedium-data.ts`, parsed as a
    literal, never evaluated) over DOM scraping. Bump `SCRAPER_METADATA_VERSION`
    and the RAG supported set together.
11. Never lose the URL list: `make run` refreshes `data/backups/scraped-urls.txt`;
    destructive commands snapshot first.
12. Memory is tight on the user's machine: keep Ollama `num_ctx` capped, unload
    a model before loading the next (`unload_ollama_model`), never run tagging
    and indexing in parallel.
13. Keep `make test` green; tests use temp folders only.

## Files

- `apps/scraper/src/scraper/index.ts`: CLI entry point (dispatch only)
- `cli-options.ts`: flags + environment -> options
- `pipeline.ts`: ingest, scrape queue, rescan, run, status, backup, URL list export/requeue, snapshots
- `freedium.ts`: browser session, Freedium loading and extraction
- `freedium-data.ts`, `markdown.ts`: embedded-data parser, Markdown cleanup
- `output.ts`: `.txt`/`.json` writing; `db.ts`: `library.db`
- `drive.ts`, `oauth.ts`: Google Drive/Docs API and OAuth
- `urls.ts`, `text.ts`, `log.ts`, `types.ts`: shared helpers
- `apps/scraper/src/tests/`, `apps/reader/test/`, `apps/rag/tests/`: unit tests (`make test`)
- `apps/reader/src/server.js`: reader (cache, FTS5 search, Markdown rendering, API)
- `apps/rag/src/`: `sync.py`, `tag.py`, `ingest.py`, `query.py`, `vectorstore.py`, `mcp_server.py`, `index_inspect.py`, `common.py`
- `Makefile`: all user-facing commands; `.env.example`: settings
- `deploy/systemd/`: optional nightly timer units
- `docs/PLAN.md`: history of the improvement phases
