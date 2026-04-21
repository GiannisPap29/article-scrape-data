# web-scrapper

Medium article extraction through Freedium with a two-stage Google Drive queue.

## Configuration

Runtime settings are loaded from a root `.env` file.

- Copy `.env.example` to `.env`
- keep `.env` local and untracked
- commit `.env.example` to GitHub

## What it does

- Reads one exact Google Drive inbox folder for Google Docs or plain text files that contain one Medium article URL.
- Enqueues new URLs into `data/url_from_drive.db`.
- Skips URLs already present in `data/scraped-urls.db` or already present in the queue DB.
- Moves ingested Drive files into an archive folder.
- Moves failed Drive files into a failure folder.
- Scrapes queued URLs through Freedium and stores extracted text in `data/output/`.
- Promotes successful queue entries into `data/scraped-urls.db`.
- Indexes saved article txt files into a local knowledge database for agent retrieval.
- Supports local retrieval queries over the indexed corpus.

## Workspace layout

- `apps/scraper`: manual Drive ingest and scraping CLI
- `apps/knowledge`: corpus indexing and retrieval CLI
- `packages/config`: shared defaults
- `data/output`: extracted text files and debug artifacts
- `data/url_from_drive.db`: staged URL queue from Drive
- `data/scraped-urls.db`: SQLite history of scraped source URLs
- `data/knowledge.db`: local SQLite vector index for agent retrieval
- `data/oauth/google-client.json`: Google OAuth desktop client credentials
- `data/oauth/google-token.json`: stored OAuth access/refresh tokens

## Setup

1. Install dependencies:

```bash
make install
make browsers
```

2. Copy the example config:

```bash
cp .env.example .env
```

3. In Google Cloud:

- Enable the Google Drive API
- Enable the Google Docs API
- Create an OAuth client of type `Desktop app`
- Download the client JSON

4. Put the OAuth client file at:

```text
data/oauth/google-client.json
```

Or pass a custom path through `GOOGLE_OAUTH_CLIENT_FILE`.

## Commands

### Project setup

```bash
make install
make browsers
make build
make typecheck
```

### First run / create databases

Stage 1: read Drive files and create or update `data/url_from_drive.db`:

```bash
make ingest
```

Stage 2: read `data/url_from_drive.db`, compare/promote into `data/scraped-urls.db`, and save local `.txt` files:

```bash
make scrape-queue
```

Stage 3: read `data/output/*.txt` and build or update `data/knowledge.db`:

```bash
make index-corpus
```

### Knowledge retrieval

Query the local knowledge index for prompt-ready chunks:

```bash
make query-corpus QUERY="How should I design authentication for a REST API?"
```

### Inspection

```bash
make show-db
```

### Dangerous commands

Re-scrape every URL already stored in `scraped-urls.db` and refresh the local `.txt` output files:

```bash
make rescan
```

Delete and rebuild only the knowledge index:

```bash
make reset-index
```

Delete the scraped URL history:

```bash
make reset-db
```

Delete generated output files:

```bash
make clean-output
```

### Optional browser modes

Run with a visible browser for Freedium extraction:

```bash
make ingest HEADLESS=false
make scrape-queue HEADLESS=false
make rescan HEADLESS=false
```

Attach to an existing Chrome/Edge DevTools session:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/medium-debug
make scrape-queue CONNECT_URL="http://127.0.0.1:9222" HEADLESS=false
```

## Google Drive workflow

The Drive workflow expects:

- one exact watched folder ID via `DRIVE_FOLDER_ID` in `.env`
- optional archive folder via `DRIVE_ARCHIVE_FOLDER_ID`
- native Google Docs or plain text files
- one Medium article URL per file body

Example file content:

```text
Read “One of These Numbers Doesn’t Fit in Reality“ by Abhinav on Medium: https://codingplainenglish.medium.com/one-of-these-numbers-doesnt-fit-in-reality-749194f3dbf3
```

### Ingest stage

For each supported file in the Drive inbox:

1. Read the body through the Google Docs API for native docs, or download the text content for plain text files.
2. Extract exactly one valid Medium/Freedium article URL.
3. Check `data/scraped-urls.db`.
4. Check `data/url_from_drive.db`.
5. If already scraped, archive the Drive file and do not queue it.
6. If already queued, archive the Drive file and do not queue it again.
7. If new, insert it into `data/url_from_drive.db`, then archive the Drive file.
8. If parsing fails, move the Drive file into the failure folder.

### Queue scrape stage

For each queued URL in `data/url_from_drive.db`:

1. Read queued rows oldest-first.
2. If the URL is already in `data/scraped-urls.db`, remove it from the queue DB.
3. If not, scrape it through Freedium.
4. Save or refresh the local `.txt` file in `data/output/`.
5. Upsert the success row into `data/scraped-urls.db`.
6. Delete the successful row from `data/url_from_drive.db`.
7. On scrape failure, keep the row in `data/url_from_drive.db` and update `last_error`.

If `DRIVE_ARCHIVE_FOLDER_ID` is not set, the app creates or reuses a sibling folder named `<WATCHED_FOLDER_NAME>_ARCHIVED`.

If `DRIVE_FAILED_FOLDER_ID` is not set, the app creates or reuses a sibling folder named `<WATCHED_FOLDER_NAME>_FAILED`.

If the watched folder is empty, `make ingest` does nothing and exits cleanly.

## First-time OAuth flow

On the first `make ingest` run:

1. The app starts a temporary local callback server on `127.0.0.1`.
2. It prints a Google authorization URL.
3. Open that URL in your browser and approve access.
4. Google redirects back to the local callback.
5. The app stores tokens in `data/oauth/google-token.json`.

After that, the app reuses the refresh token and should not require repeated login unless the token is revoked or expired.

## Options

- `BROWSER=chrome|msedge|firefox|webkit`
- `CONNECT_URL=http://127.0.0.1:9222`
- `HEADLESS=true|false`
- `OUTPUT_DIR=./data/output`
- `DB_FILE=./data/scraped-urls.db`
- `URL_QUEUE_DB_FILE=./data/url_from_drive.db`
- `DRIVE_FOLDER_ID=<google-drive-folder-id>`
- `DRIVE_ARCHIVE_FOLDER_ID=<google-drive-folder-id>`
- `DRIVE_FAILED_FOLDER_ID=<google-drive-folder-id>`
- `GOOGLE_OAUTH_CLIENT_FILE=./data/oauth/google-client.json`
- `GOOGLE_OAUTH_TOKEN_FILE=./data/oauth/google-token.json`
- `KNOWLEDGE_DB_FILE=./data/knowledge.db`
- `EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2`
- `CHUNK_TARGET_TOKENS=500`
- `CHUNK_OVERLAP_TOKENS=100`
- `QUERY_TOP_K=8`
## Notes

- Each Drive file must contain exactly one direct article URL, not a Medium profile/feed/list URL.
- The ingest stage processes Drive files sequentially in `modifiedTime` ascending order.
- The queue scrape stage processes queued URLs sequentially in `queued_at` ascending order.
- `data/url_from_drive.db` is the durable staging queue.
- `data/scraped-urls.db` is the final success history.
- `data/knowledge.db` is the local retrieval database for agent context.
- The knowledge app uses local embeddings. On first index/query run, the embedding model may be downloaded and cached locally.
- `make index-corpus` incrementally indexes only new or changed txt files based on `source_url + content_hash`.
- `make query-corpus` is the intended agent-facing retrieval entrypoint.
- `make rescan` ignores the duplicate skip and re-scrapes every tracked `source_url` already stored in `data/scraped-urls.db`.
- SQLite table: `scraped_urls(source_url, output_path, scraped_at)`.
- `make reset-db` clears only SQLite history, not existing output files.
- `make clean-output` removes local `.txt`, `.html`, and `.png` output artifacts.

## References

- Google OAuth installed apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google Docs `documents.get`: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
- Google Drive `files.list`: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- Google Drive move files between folders: https://developers.google.com/workspace/drive/api/guides/folder
