# web-scrapper

Medium article extraction plus local RAG over the scraped corpus with Chroma and Gemma 4 through Ollama.

## Structure

This repo is split into app folders plus one shared data contract:

- `apps/scraper/`: standalone TypeScript scraper app
- `apps/reader/`: standalone local Node reader app
- `apps/rag/`: standalone Python RAG app
- `data/output/`: scraped `.txt` files and `.json` sidecars; source of truth for documents
- `data/state/`: RAG manifest state
- `data/chroma/`: persisted Chroma database

The scraper writes `data/output/`. The reader app browses `data/output/` for human reading. The RAG app reads `data/output/` and builds the local vector store. That shared `data/` folder is the only contract between the apps.

## Setup

### Scraper

```bash
make install
make browsers
cp .env.example .env
```

Google requirements:

- Enable the Google Drive API
- Enable the Google Docs API
- Create an OAuth client of type `Desktop app`
- Put the client JSON at `data/oauth/google-client.json`

### RAG

Install Ollama locally on Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama -v
```

Start the local Ollama server:

```bash
ollama serve
```

In another terminal, pull the Gemma 4 E4B model used by this repo:

```bash
ollama pull gemma4:e4b
```

Create a Python environment and install the local RAG dependencies:

```bash
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r apps/rag/requirements.txt
```

If you want the core Python packages explicitly, they are:

```bash
./venv/bin/pip install chromadb ollama sentence-transformers
```

You also need:

- Ollama running locally
- a local Gemma model available in Ollama, defaulting to `gemma4:e4b`

### Reader

Run the local article reader UI:

```bash
make reader
```

Default address:

```text
http://127.0.0.1:3010
```

Run it as an always-on local container:

```bash
make reader-up
```

Container address:

```text
http://127.0.0.1:3010
```

Useful container commands:

```bash
make reader-logs
make reader-down
```

## Main Flows

### Scraper flow

Stage Drive URLs into the queue DB:

```bash
make ingest
```

Scrape the queued URLs and write `.txt` + `.json` output into `data/output/`:

```bash
make scrape-queue
```

### RAG flow

Sync scraper sidecars into the RAG manifest:

```bash
make rag-sync
```

Chunk, embed, and store documents in Chroma:

```bash
make rag-ingest
```

Ask Gemma against the local corpus:

```bash
make rag-ask QUESTION="best practices for go error handling"
```

Show retrieved source chunks without calling Gemma:

```bash
make rag-sources QUESTION="best practices for go error handling"
```

### Reader flow

Run the local browser UI over the shared article corpus:

```bash
make reader
```

Or keep it running all the time through Docker:

```bash
make reader-up
```

The reader app provides:

- search over title, excerpt, and tags
- filters for tag, author, language, and source domain
- sortable article library
- full article reading pages sourced from local `.txt` files

## Commands

### Scraper

- `make ingest`
- `make scrape-queue`
- `make show-db`
- `make backup-db`
- `make rescan`
- `make reset-db`
- `make clean-output`

### RAG

- `make rag-sync`
- `make rag-ingest`
- `make rag-reingest`
- `make rag-sources QUESTION="..."`
- `make rag-ask QUESTION="..."`
- `make rag-chroma-count`
- `make rag-chroma-peek PEEK=3`
- `make rag-chroma-doc DOC_ID="doc_..."`

### Reader

- `make reader`
- `make reader-up`
- `make reader-logs`
- `make reader-down`

## RAG Contract

The importer reads scraper `*.json` sidecars from `data/output/` and currently accepts `scraperMetadataVersion == 2` or `3`.

Required fields:

- `docId`
- `contentHash`
- `sourceUrl`
- `scrapedAt`
- `title`
- `tags`
- `outputPath`
- `metadataPath`
- `batchId`
- `scraperMetadataVersion`

Optional enrichment:

- `author`
- `siteName`
- `excerpt`
- `publishedAt`
- `language`

## Notes

- `data/output/` should remain intact; it is the handoff point between scraper and RAG.
- The reader container mounts `data/output/` read-only and does not modify article files.
- `data/state/` and `data/chroma/` are generated local artifacts and are ignored by Git.
- The default embedding model is `sentence-transformers/all-MiniLM-L6-v2`.
- The first `rag-ingest` may download model assets if they are not cached yet.
- The default Ollama model is `gemma4:e4b`, configurable in `apps/rag/src/query.py`.

Official references:

- Ollama Linux install: https://docs.ollama.com/linux
- Gemma 4 model library: https://ollama.com/library/gemma4
- Chroma Python package: https://pypi.org/project/chromadb/

## Output contract

Each successful scrape now produces two files with the same basename in `data/output/`:

- `<slug>-<hash>.txt`: clean article body only
- `<slug>-<hash>.json`: structured metadata for downstream ingestion

The metadata sidecar includes:

- `docId`
- `title`
- `author`
- `siteName`
- `excerpt`
- `sourceUrl`
- `outputPath`
- `metadataPath`
- `scrapedAt`
- `batchId`
- `contentHash`
- `tags`
- `publishedAt`
- `language`
- `scraperMetadataVersion`

If Freedium exposes trailing hashtag lines like `#golang`, `#programming`, or `#software`, the scraper stores them in `tags` and does not append them to the `.txt` body.

The sidecar schema is versioned. `scraperMetadataVersion=2` means:

- `title` is the extracted article title when available, with URL-derived fallback only if extraction fails
- `contentHash` is computed from the final normalized `.txt` body
- obvious UI artifacts such as standalone `Copy`, `Share`, or duplicate title lines are removed conservatively before writing the `.txt`

## Notes

- Each Drive file must contain exactly one direct article URL, not a Medium profile/feed/list URL.
- The ingest stage processes Drive files sequentially in `modifiedTime` ascending order.
- The queue scrape stage processes queued URLs sequentially in `queued_at` ascending order.
- `data/url_from_drive.db` is the durable staging queue.
- `data/scraped-urls.db` is the final success history.
- `make rescan` ignores the duplicate skip and re-scrapes every tracked `source_url` already stored in `data/scraped-urls.db`.
- SQLite table: `scraped_urls(source_url, output_path, scraped_at, doc_id, title, author, site_name, excerpt, metadata_path, content_hash, published_at, language, tags_json)`.
- `make reset-db` clears only SQLite history, not existing output files.
- `make clean-output` removes local `.txt`, `.json`, `.html`, and `.png` output artifacts.

## References

- Google OAuth installed apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google Docs `documents.get`: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
- Google Drive `files.list`: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- Google Drive move files between folders: https://developers.google.com/workspace/drive/api/guides/folder
