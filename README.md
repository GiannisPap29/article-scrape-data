# web-scrapper

Single or pasted-list Medium extraction through Freedium.

Flow:

1. Provide one Medium/Freedium article URL, or paste a list of article URLs in the UI.
2. The scraper submits the source URL to `https://freedium-mirror.cfd/`.
3. Extracted content is saved as a `.txt` file in `data/output/`.
4. The normalized source URL is tracked in `data/scraped-urls.db`.
5. Already-scraped source URLs are skipped.

## Workspace layout

- `apps/scraper`: Playwright scraper and local UI
- `packages/config`: Shared scraper configuration
- `data/output`: Generated text/debug output
- `data/scraped-urls.db`: SQLite source URL registry

## Setup

```bash
make install
make browsers
```

## CLI

Scrape one article:

```bash
make scrape URL="https://medium.com/@kanishks772/postgresql-vs-duckdb-vs-exasol-the-benchmark-that-changed-my-stack-a4341ab6517e"
```

Run with a visible browser:

```bash
make scrape-headed URL="https://medium.com/@kanishks772/postgresql-vs-duckdb-vs-exasol-the-benchmark-that-changed-my-stack-a4341ab6517e"
```

Reset the source URL registry:

```bash
make reset-db
```

Inspect the registry:

```bash
make show-db
```

## UI

Start the local UI:

```bash
make ui
```

Open:

```text
http://127.0.0.1:3000
```

The UI lets you:

- submit one article URL
- paste a list of article URLs separated by new lines or commas
- see already-scraped source URLs
- skip duplicates automatically
- reset the tracking database for fresh testing

Use a visible browser for UI-triggered scrapes:

```bash
make ui-headed
```

Attach to an existing Chrome/Edge DevTools session:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/medium-debug
make ui-headed CONNECT_URL="http://127.0.0.1:9222"
```

## Options

- `BROWSER=chrome|msedge|firefox|webkit`
- `CONNECT_URL=http://127.0.0.1:9222`
- `OUTPUT_DIR=./data/output`
- `DB_FILE=./data/scraped-urls.db`
- `PORT=3000`

## Notes

- Freedium is used only for content extraction.
- Medium list/page scanning has been removed from the main workflow.
- Pasted URL lists are processed as static input; no pagination or Medium page scanning is performed.
- Duplicate checks happen before browser extraction, using the normalized source URL.
- SQLite table: `scraped_urls(source_url, output_path, scraped_at)`.
- `make reset-db` clears only the SQLite tracking database, not existing output files.
