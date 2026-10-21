# Implementation Plan

Goal: one command (`make run`) that takes every link saved in the Drive `MEDIUM`
folder, skips what is already scraped, scrapes the rest through Freedium, saves
`.txt` + `.json` to `data/output/`, records them in the database, and makes them
searchable by the AI (RAG). Plus every fix found in the 2026-10-18 scan.

## Target flow

```
make run
  │
  ├─ 1. Google OAuth (reuse/refresh token, once per run)
  ├─ 2. Resolve folders:  MEDIUM/                (inbox)
  │                       MEDIUM/MEDIUM_ARCHIVED (done)
  │                       MEDIUM/MEDIUM_FAILED   (no valid URL in file)
  ├─ 3. Ingest: for each file in MEDIUM (oldest first)
  │        extract one Medium URL
  │        ├─ already in scraped DB  → move to ARCHIVED
  │        ├─ already in queue       → move to ARCHIVED
  │        ├─ new                    → insert into queue → move to ARCHIVED
  │        └─ parse error            → move to FAILED
  ├─ 4. Scrape queue (ONE browser for the whole run)
  │        for each queued URL (oldest first, attempts < max)
  │        ├─ open freedium-mirror/<url> directly
  │        ├─ extract text + metadata → write .txt + .json
  │        ├─ success → upsert scraped DB, delete from queue
  │        └─ failure → keep in queue, attempts+1, last_error
  ├─ 5. RAG sync + ingest (only new/changed docs)
  ├─ 6. Backup scraped DB to Drive
  └─ 7. Print one summary: files seen / queued / scraped / failed / indexed
```

The queue DB stays as the retry layer: a scrape failure never loses a link, and
the next `make run` retries it. Existing invariants in `AGENT.md` stay valid.

---

## Phase 0: Quick fixes (small, no behavior change) ✅ done 2026-10-18

Decision for 0.2: kept `gemma3:1b` as the default (what the code already ran);
`gemma4:e4b` is documented as the opt-in via `RAG_MODEL`.

| # | Fix | Where |
|---|-----|-------|
| 0.1 | Fix broken README line (`-\n Gemma 4 model library`) | `README.md` |
| 0.2 | Align default model: Makefile + `query.py` say `gemma3:1b`, README says `gemma4:e4b`; pick one, set it in `.env` | `Makefile`, `apps/rag/src/query.py`, `README.md` |
| 0.3 | Save OAuth token with `mode: 0o600` | `writeGoogleOAuthToken` in `apps/scraper/src/scraper/index.ts` |
| 0.4 | Remove dead code: `parsePositiveInteger`, always-zero `skipped` in rescan | `index.ts` |
| 0.5 | Review the uncommitted `freediumUrl` work (user commits) | git |

Done when: `make typecheck` passes and README renders correctly.

## Phase 1: One-command flow (main goal) ✅ done 2026-10-18 (not yet run against Drive)

Notes: backup runs inside `--run` (reuses the Google session) instead of as a
separate Makefile step, and is skipped when nothing changed. 1.2 needed no code
change: the Drive query's MIME filter already excludes folders and the `.db` backup.

| # | Task | Notes |
|---|------|-------|
| 1.1 | **Find ARCHIVED/FAILED inside MEDIUM first**, then fall back to the parent, then create inside MEDIUM | Today the code looks only in the parent, so with the new layout it would create duplicate folders. Change `resolveArchiveFolderId` / `resolveFailureFolderId`. Optionally set both IDs in `.env` to make it explicit. |
| 1.2 | Make sure the ingest listing never picks up the subfolders or the DB backup file | The MIME filter already excludes folders and `.db`; add a test/log line to confirm. |
| 1.3 | **Move the DB backup out of MEDIUM**: use `MEDIUM/BACKUPS` or a separate folder | `DRIVE_BACKUP_FOLDER_ID` is currently the same as `DRIVE_FOLDER_ID`. |
| 1.4 | New CLI command `--run`: OAuth once → ingest → scrape queue → summary | Reuses `ingestDriveQueue` + `scrapeQueuedUrls`; one Google session, one browser. |
| 1.5 | New Makefile target `run`: `--run` → `rag-sync` → `rag-ingest` → `backup-db` | RAG and backup only run if the scrape step did not crash. Keep `ingest` / `scrape-queue` as separate targets for debugging. |
| 1.6 | Run summary + exit code: `0` all good, `2` some URLs failed (still in queue), `1` crash | One final summary line, easy to read or to send as a notification later. |
| 1.7 | `make status`: counts for inbox / queue (with errors) / scraped / indexed | Replaces `commands.txt`. |

Done when: dropping a new link file in MEDIUM and running `make run` once
moves it to MEDIUM_ARCHIVED, creates the `.txt`/`.json`, adds a DB row, and the
article shows up in `make rag-sources`.

## Phase 2: Scraper reliability and speed ✅ done 2026-10-18

Notes: tested live against Freedium with isolated temp files (2 real articles
saved in ~5 s each; dead primary mirror fell back correctly; unknown article
detected as Freedium 404 in ~5 s and marked gave-up). Extra beyond the plan:
fresh tab per attempt, Freedium 404 = permanent failure, `make retry-failed`,
`make clean-debug`. 2.8: chose `"incremental": true` over `tsx` (rebuild
1.8 s -> 1.3 s; keeps type-checking on every run, no new dependency).

| # | Task | Notes |
|---|------|-------|
| 2.1 | One browser per run, new page per article | Now: a new browser for every URL (`scrapeAndWriteUrl`). |
| 2.2 | Open `freedium-mirror/<url>` directly; use the homepage form only as fallback | Skips one page load and the form step. |
| 2.3 | `FREEDIUM_URL` in `.env` (+ optional fallback mirror list) | Mirror domains change often; now hard-coded in `config/index.ts`. |
| 2.4 | Queue retries: add `attempts`, `next_retry_at`; backoff; `MAX_ATTEMPTS` (e.g. 5); give-up state | Columns added with the same migration style as `ensureScrapedUrlsColumns`. |
| 2.5 | Polite pause between articles (e.g. 3–8 s random) | Lowers the chance of anti-bot pages. |
| 2.6 | Atomic writes: write `.tmp` then rename, `.txt` before `.json` | A crash can't leave half-written files. |
| 2.7 | Debug `.html`/`.png` → `data/debug/` instead of `data/output/` | 22 debug files are currently mixed with articles. Move existing ones too. |
| 2.8 | Run with `tsx` (or keep `dist/` and rebuild only on `make build`) | `npm run scrape` currently recompiles on every run. |

## Phase 3: Data quality ✅ 3.1–3.3 done 2026-10-18 · 3.4 backfill waiting for the user to run it

Findings: Freedium changed layout in 2026-06. Since then every stored `author`
was wrong (Unsplash credits, TOC entries, link text), `publishedAt` and `tags`
were empty. Freedium embeds the full article data plus a Markdown export in
its page script; v4 reads that (safe literal parser, no eval) and falls back to
the visible header/HTML. Tags are no longer exposed by Freedium: auto-tagging
moves to Phase 4 (4.6). Reader Markdown rendering (5.3) was pulled forward so
v4 bodies display correctly. Kept the `.txt` extension (contract stability);
`contentFormat` says whether the body is Markdown.

| # | Task | Notes |
|---|------|-------|
| 3.1 | Fix metadata selectors against the current Freedium markup | Missing today: `siteName` 315/315, `publishedAt` 248/315, `tags` 85/315, `freedium.free/publication` mostly null. Save one Freedium page as a test fixture. |
| 3.2 | Keep structure: headings as `## `, lists stay one item per line | Headings are flattened to plain text now. |
| 3.3 | Store `outputPath` / `metadataPath` relative to `data/output/` | All 315 sidecars use absolute host paths; breaks if the repo moves or in Docker. Bump `scraperMetadataVersion` to 4 and update RAG + reader to accept it. |
| 3.4 | Backfill: `make rescan` (or a lighter `--refresh-metadata`) to bring all 315 docs to v4 | After 3.1–3.3. |

## Phase 4: RAG (AI search) fix ✅ code done 2026-10-18 · full re-index (4.4) waiting for the user

Findings: the venv was broken (system Python upgraded 3.12 -> 3.14; the venv
pointed at `python3`), so ingest/ask could not run at all. Rebuilt it pinned to
`python3.14` with only `chromadb` + `ollama` (5.2 GB -> 490 MB). Embeddings now
via Ollama `embeddinggemma`; tested on 5 docs + 3 auto-tagged docs + a full
grounded answer. Memory: loading `gemma3:1b` with its default context during
tagging triggered the kernel OOM killer (it killed VS Code); fixed with capped
`num_ctx`, `num_predict`, and explicit unloads between steps.

| # | Task | Notes |
|---|------|-------|
| 4.1 | **Fix embedding truncation**: switch to an Ollama embedding model (`embeddinggemma` or `nomic-embed-text`) | `all-MiniLM-L6-v2` cuts at 256 tokens, but chunks are ~500 tokens, so half of each chunk is never searchable. This also removes `sentence-transformers` + PyTorch (several GB). Everything AI then runs through Ollama. |
| 4.2 | Chunk size matched to the model (~1000–1500 chars, ~150 overlap); prefix each chunk with the title | Better retrieval. |
| 4.3 | `rag-sync`: skip + report bad sidecars instead of aborting; prune deleted docs from manifest + Chroma | One bad file stops sync today. |
| 4.4 | Full re-index of all 315 docs | Only 18 of 315 are indexed today (231 stuck at `synced`, 66 never synced). |
| 4.5 | Pin Python dependencies | `requirements.txt` has no versions. |
| 4.6 | Auto-tag articles with the local Ollama model (3–6 topic tags) | Freedium no longer exposes Medium tags (all docs since 2026-06 have none). |

Done when: `make status` shows indexed = scraped.

## Phase 5: Reader ✅ done 2026-10-18

Notes: mtime-based cache instead of `fs.watch` (bind mounts in Docker don't
deliver reliable watch events); index 0.41 s cold -> ~0.035 s warm, search
~8 ms; `/api/articles` 569 KB (was ~9 MB with bodies). Extra: auto tags from
the RAG manifest (dashed chips, clickable tag filter); container mounts
`data/state` read-only for that. Rebuild the container with `make reader-up`.

| # | Task | Notes |
|---|------|-------|
| 5.1 | Cache articles in memory, reload when `data/output/` changes (`fs.watch` / mtime) | Re-reads 630 files per request now. |
| 5.2 | `/api/articles` returns metadata only; body only on `/api/articles/:id` | Sends ~8 MB per call now. |
| 5.3 | ~~Render lists and headings~~ ✅ done in Phase 3 | Markdown renderer in the reader (no dependency). |

## Phase 6: Stack upgrades ✅ done 2026-10-18

| # | Result |
|---|--------|
| 6.5 | `index.ts` (3,154 lines) split into 13 modules (`cli-options`, `pipeline`, `freedium`, `output`, `db`, `drive`, `oauth`, `urls`, `text`, `log`, `types`, + `freedium-data`, `markdown`); `index.ts` is a 97-line entry point. Split by script, verified with `tsc --noUnusedLocals` and live runs. |
| 6.6 | `make test`: 25 scraper + 5 reader + 12 RAG tests, temp folders only. Tests found and fixed 2 real bugs: Medium reading-list URLs accepted as articles; HTML fallback added a blank line at the end of every code block. |
| 6.1 | One `data/library.db`; queue -> history promotion in one transaction. Old two-file DBs copied in once per table, read-only (flag per table so a wrong path can't skip the import). Backup uploads `library.db`. |
| 6.2 | Reader search = in-memory SQLite FTS5 (porter stemming, prefix terms, bm25 weights, `<mark>` snippets, injection-safe query building, substring fallback). 9-87 ms per search over 315 articles. |
| 6.4 | Read-only MCP server `medium-library` (MCP Python SDK 2.3.0): `search_articles`, `get_article`, `list_articles`, `library_stats`; registered in `.mcp.json`; tested over stdio. |
| 6.3 | Evaluated, then **switched** Chroma -> sqlite-vec: identical top-5 on real vectors, ~7 ms KNN at ~5k chunks, 172 KB vs ~350 MB of deps. venv 513 MB -> 61 MB. Vectors in `data/state/vectors.db` (RAG-owned, separate from the scraper's `library.db`). |
| 6.7 | Optional systemd user timer (03:30, headless, nice/idle IO, notification) via `make schedule-install`; not installed. Added a `make run` lock (`data/.run.lock`). Corrected docs: make itself exits 0/2, not the scraper's 0/2/1. |

Original item list (for reference):


| # | Task | Why |
|---|------|-----|
| 6.1 | Merge `scraped-urls.db` + `url_from_drive.db` into one `data/library.db` | Queue → history promotion becomes one transaction; one file to back up. |
| 6.2 | SQLite FTS5 full-text index for the reader search | Fast, ranked search instead of substring scan. |
| 6.3 | Evaluate `sqlite-vec` to replace Chroma | Text, metadata, search and vectors in one file. |
| 6.4 | MCP server (`search_articles`, `get_article`) over the library | Lets Claude / other AI tools use the corpus directly. |
| 6.5 | Split `index.ts` (2,642 lines) into `cli/`, `oauth/`, `drive/`, `db/`, `freedium/`, `extract/` | Easier to change and test. |
| 6.6 | Unit tests (URL normalization, text cleanup, tag parsing, chunking) + Freedium fixture test | Catch Freedium markup changes early. |
| 6.7 | Optional: systemd user timer for `make run` + desktop notification | `AGENT.md` says manual-only; only if you decide to change that. |

---

## Order and size

| Phase | Size | Depends on |
|-------|------|-----------|
| 0 | ~1 h | none |
| 1 | ~half day | 0 |
| 2 | ~half day | 1 |
| 3 | ~1 day (Freedium markup work) | 2 |
| 4 | ~half day + re-index time | 3.3 (relative paths) |
| 5 | ~2–3 h | 3.2 |
| 6 | pick per item | 1–4 |

Phases 0 + 1 give you the single `make run` command. Phase 4 makes the AI side
actually cover the whole library.

## Phase 7: Polish and cleanup ✅ done 2026-10-19

- Makefile rewritten: 40 -> 30 targets. Merged `install`/`browsers`/`rag-venv`/
  `rag-install` into `setup`; `rag-reingest` -> `rag-ingest FORCE=1`;
  `rag-index-count`/`-peek`/`-collections` -> `rag-index`. Removed `build`,
  `typecheck` (covered by `test` and every scraper command), `show-db`
  (covered by `status` + `export-urls`), `rag-mcp` (Claude starts it from
  `.mcp.json`). Shared flags live in variables; npm noise silenced.
- Removed code: old-Freedium-layout extraction (author-link guessing that
  produced wrong authors, info-row parser, footer tags; fields `authorBio`,
  `authorUrl`, `freedium.publicationUrl`, `freedium.rawPublishedText`), the
  one-time legacy two-file DB import and `--dbFile`/`--queueDbFile`, old schema
  migrations, `showDatabases`, the scraper's dead `.env` loader, `CHROMA_DIR`.
- `@playwright/test` -> `playwright` (library only); tsconfig without
  `declaration`/`ignoreDeprecations`; `engines.node` >= 22.13 (node:sqlite).
- Removed files: `.codex` (empty), `commands.txt` (pointed at deleted DBs),
  `apps/rag/src/chroma_inspect.py`. `.gitignore` simplified to ignore `data/`.
- README rewritten (486 -> ~230 lines, no duplicate sections); AGENT.md rewritten.

