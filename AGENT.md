# AGENT

## Project Purpose

This project ingests Medium article URLs from a Google Drive inbox, stages them in a queue database, scrapes article content through Freedium, and stores the extracted text as `.txt` files in `data/output`.

The project is intentionally manual-only.

There is no always-running daemon or watcher loop.

## Current Workflow

The system has two explicit stages:

1. `make ingest`
2. `make scrape-queue`

### Stage 1: Ingest

`make ingest` does this:

1. Connects to the configured Google Drive inbox folder.
2. Reads supported files:
   - native Google Docs
   - plain text-like Drive files
3. Extracts exactly one Medium article URL from each file.
4. Checks `data/scraped-urls.db`.
5. Checks `data/url_from_drive.db`.
6. If the URL is already scraped, the Drive file is moved to the archive folder.
7. If the URL is already queued, the Drive file is moved to the archive folder.
8. If the URL is new, it is inserted into `data/url_from_drive.db`, then the Drive file is moved to the archive folder.
9. If parsing fails, the Drive file is moved to the failure folder.

### Stage 2: Scrape Queue

`make scrape-queue` does this:

1. Reads queued URLs from `data/url_from_drive.db` oldest-first.
2. For each URL, scrapes content through Freedium.
3. Saves the article text into `data/output`.
4. Only after the `.txt` file is written successfully:
   - upserts the URL into `data/scraped-urls.db`
   - removes the row from `data/url_from_drive.db`
5. If scraping fails:
   - the row remains in `data/url_from_drive.db`
   - `last_error` is updated

## Databases

### `data/url_from_drive.db`

This is the staging queue.

It stores URLs that were accepted from Google Drive but not yet successfully promoted to final history.

Table:

- `url_from_drive(source_url, drive_file_id, drive_file_name, queued_at, last_error)`

### `data/scraped-urls.db`

This is the final success history.

A URL should appear here only after its text file has been saved successfully.

Table:

- `scraped_urls(source_url, output_path, scraped_at)`

## Output File Rule

One normalized URL must map to one stable `.txt` filename.

Important invariant:

- the same normalized URL must always reuse the same output path
- no duplicate variant files like `slug-2.txt` or `slug-3.txt` should be created for the same URL

## Commands

Primary commands:

- `make ingest`
- `make scrape-queue`
- `make rescan`
- `make show-db`
- `make reset-db`
- `make clean-output`

## Environment

Runtime settings are loaded from the root `.env` file.

Important values:

- `DRIVE_FOLDER_ID`
- `DRIVE_ARCHIVE_FOLDER_ID`
- `DRIVE_FAILED_FOLDER_ID`
- `URL_QUEUE_DB_FILE`
- `DB_FILE`
- `OUTPUT_DIR`
- `GOOGLE_OAUTH_CLIENT_FILE`
- `GOOGLE_OAUTH_TOKEN_FILE`
- `HEADLESS`
- `CONNECT_URL`

## Design Constraints

When changing this project, preserve these rules:

1. Keep the flow manual-only unless explicitly requested otherwise.
2. Do not bypass the queue DB by scraping directly from Drive ingest.
3. Do not move a queue row into `scraped-urls.db` before the output file is written successfully.
4. Keep `scraped-urls.db` as final success history only.
5. Keep `url_from_drive.db` as the retryable staging queue.
6. Preserve the one-URL-to-one-stable-txt-file rule.
7. Keep Drive parse failures separate from scrape failures:
   - parse failure => Drive failure folder
   - scrape failure => keep row in queue DB with `last_error`

## Files To Know

- `apps/scraper/src/index.ts`: main CLI, Drive ingest, queue scrape, OAuth, DB helpers, Freedium scraping
- `packages/config/src/index.ts`: shared default config values
- `Makefile`: user-facing commands
- `.env.example`: environment template
- `README.md`: user documentation
