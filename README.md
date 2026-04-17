# web-scrapper

Medium article extraction through Freedium with SQLite URL history, using a Google Drive folder as the input queue.

## Configuration

Runtime settings are loaded from a root `.env` file.

- Copy `.env.example` to `.env`
- keep `.env` local and untracked
- commit `.env.example` to GitHub

## What it does

- Watches one exact Google Drive folder for Google Docs or plain text files that contain one Medium article URL.
- Skips URLs already present in `data/scraped-urls.db`.
- Deletes processed Drive files on DB hit or scrape success.
- Moves failed Drive files into a failure folder.
- Stores extracted article text in `data/output/`.

## Workspace layout

- `apps/scraper`: CLI scraper and Drive watcher
- `packages/config`: shared defaults
- `data/output`: extracted text files and debug artifacts
- `data/scraped-urls.db`: SQLite history of scraped source URLs
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

Process the watched Google Drive folder once:

```bash
make scan
```

Watch Google Drive forever, polling every 30 minutes:

```bash
make watch
```

Run with a visible browser for Freedium extraction:

```bash
make scan HEADLESS=false
make watch HEADLESS=false
```

Attach to an existing Chrome/Edge DevTools session:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/medium-debug
make scan CONNECT_URL="http://127.0.0.1:9222" HEADLESS=false
```

Inspect the SQLite history:

```bash
make show-db
```

Reset the SQLite history:

```bash
make reset-db
```

## Google Drive workflow

The Drive watcher expects:

- one exact watched folder ID via `DRIVE_FOLDER_ID` in `.env`
- native Google Docs or plain text files
- one Medium article URL per file body

Example file content:

```text
Read “One of These Numbers Doesn’t Fit in Reality“ by Abhinav on Medium: https://codingplainenglish.medium.com/one-of-these-numbers-doesnt-fit-in-reality-749194f3dbf3
```

For each supported file in the watched folder:

1. Read the body through the Google Docs API for native docs, or download the text content for plain text files.
2. Extract exactly one valid Medium/Freedium article URL.
3. Check SQLite history.
4. If already scraped, delete the Drive file.
5. If new, scrape through Freedium, save output locally, update SQLite, then delete the Drive file.
6. If parsing or scraping fails, move the Drive file into the failure folder.

If `DRIVE_FAILED_FOLDER_ID` is not set, the app creates or reuses a sibling folder named `<WATCHED_FOLDER_NAME>_FAILED`.

If the watched folder is empty, the scan does nothing and exits cleanly.

## First-time OAuth flow

On the first `scan-drive` or `watch-drive` run:

1. The app starts a temporary local callback server on `127.0.0.1`.
2. It prints a Google authorization URL.
3. Open that URL in your browser and approve access.
4. Google redirects back to the local callback.
5. The app stores tokens in `data/oauth/google-token.json`.

After that, the watcher reuses the refresh token and should not require repeated login unless the token is revoked or expired.

## Options

- `BROWSER=chrome|msedge|firefox|webkit`
- `CONNECT_URL=http://127.0.0.1:9222`
- `HEADLESS=true|false`
- `OUTPUT_DIR=./data/output`
- `DB_FILE=./data/scraped-urls.db`
- `DRIVE_FOLDER_ID=<google-drive-folder-id>`
- `DRIVE_FAILED_FOLDER_ID=<google-drive-folder-id>`
- `GOOGLE_OAUTH_CLIENT_FILE=./data/oauth/google-client.json`
- `GOOGLE_OAUTH_TOKEN_FILE=./data/oauth/google-token.json`
- `POLL_INTERVAL_MINUTES=30`

## Notes

- Each Drive file must contain exactly one direct article URL, not a Medium profile/feed/list URL.
- The Drive watcher processes files sequentially in `modifiedTime` ascending order.
- Duplicate checks happen before browser extraction using the normalized `source_url`.
- SQLite table: `scraped_urls(source_url, output_path, scraped_at)`.
- `make reset-db` clears only SQLite history, not existing output files.
- `make clean-output` removes local `.txt`, `.html`, and `.png` output artifacts.

## References

- Google OAuth installed apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google Docs `documents.get`: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
- Google Drive `files.list`: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- Google Drive move files between folders: https://developers.google.com/workspace/drive/api/guides/folder
