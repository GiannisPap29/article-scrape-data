# web-scrapper

Monorepo for automating a content extraction flow:

1. Open `https://freedium-mirror.cfd/`
2. Submit a single article URL
3. Extract the main content
4. Save the result as a text file in `data/output/`

## Workspace layout

- `apps/scraper`: Playwright scraper application
- `packages/config`: Shared scraper configuration
- `data/output`: Generated text output

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run scrape -- --url="https://freedium-mirror.cfd/https://medium.com/@kanishks772/postgresql-vs-duckdb-vs-exasol-the-benchmark-that-changed-my-stack-a4341ab6517e"
```

Optional flags:

- `--headless=false`
- `--outputDir=./data/output`
- `--url=https://freedium-mirror.cfd/https://medium.com/...`

## Notes

- The scraper uses browser automation because both sites are interaction-driven.
- `--url` is required and accepts either a direct Freedium mirror URL or the original article URL.
- If Medium or Freedium change their markup, selectors may need to be updated.
