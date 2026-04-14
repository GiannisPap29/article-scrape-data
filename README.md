# web-scrapper

Monorepo for automating a content extraction flow:

1. Open `https://freedium-mirror.cfd/`
2. Submit a single article URL
3. Extract the main content
4. Save the result as a text file in `data/output/`
5. Track scraped URLs in `data/scraped-urls.json` so duplicates are skipped

## Workspace layout

- `apps/scraper`: Playwright scraper application
- `packages/config`: Shared scraper configuration
- `data/output`: Generated text output

## Setup

```bash
npm install
npx playwright install chromium
```

Or with `make`:

```bash
make install
make browsers
```

## Run

```bash
make scrape URL="https://freedium-mirror.cfd/https://medium.com/@kanishks772/postgresql-vs-duckdb-vs-exasol-the-benchmark-that-changed-my-stack-a4341ab6517e"
```

Optional flags:

- `--headless=false`
- `--outputDir=./data/output`
- `--trackingFile=./data/scraped-urls.json`
- `--url=https://freedium-mirror.cfd/https://medium.com/...`

Useful `make` targets:

- `make help`
- `make build`
- `make typecheck`
- `make scrape URL="https://freedium-mirror.cfd/https://medium.com/..."`
- `make scrape-headed URL="https://freedium-mirror.cfd/https://medium.com/..."`
- `make show-tracking`
- `make reset-tracking`
- `make clean-output`

## Notes

- The scraper uses browser automation because both sites are interaction-driven.
- `--url` is required and accepts either a direct Freedium mirror URL or the original article URL.
- Successfully scraped URLs are stored in `data/scraped-urls.json` and skipped on future runs.
- If Medium or Freedium change their markup, selectors may need to be updated.
