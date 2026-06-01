.PHONY: help install browsers build typecheck ingest scrape-queue backup-db rescan reset-db show-db clean-output reader reader-up reader-down reader-logs rag-venv rag-install rag-sync rag-ingest rag-reingest rag-sources rag-ask rag-chroma-count rag-chroma-peek rag-chroma-doc

# Default to the documented command index when make is run without a target.
.DEFAULT_GOAL := help

ROOT_DIR := $(CURDIR)

# Root .env values can override any ?= defaults below.
ifneq (,$(wildcard .env))
include .env
export
endif

# Shared scraper/reader/RAG paths. Keep these pointed at data/output unless
# every app that consumes the scraper contract is updated together.
OUTPUT_DIR ?= $(ROOT_DIR)/data/output
DB_FILE ?= $(ROOT_DIR)/data/scraped-urls.db
BROWSER ?= chrome
CONNECT_URL ?=
HEADLESS ?= true
DRIVE_FOLDER_ID ?=
DRIVE_ARCHIVE_FOLDER_ID ?=
DRIVE_FAILED_FOLDER_ID ?=
URL_QUEUE_DB_FILE ?= $(ROOT_DIR)/data/url_from_drive.db
GOOGLE_OAUTH_CLIENT_FILE ?= $(ROOT_DIR)/data/oauth/google-client.json
GOOGLE_OAUTH_TOKEN_FILE ?= $(ROOT_DIR)/data/oauth/google-token.json
DRIVE_BACKUP_FOLDER_ID ?=
DRIVE_BACKUP_FILE_NAME ?= scraped-urls.db
READER_APP_DIR ?= $(ROOT_DIR)/apps/reader
READER_PORT ?= 3010
READER_COMPOSE_FILE ?= $(ROOT_DIR)/docker-compose.reader.yml
SCRAPER_APP_DIR ?= $(ROOT_DIR)/apps/scraper
RAG_APP_DIR ?= $(ROOT_DIR)/apps/rag
RAG_SOURCE_DIR ?= $(ROOT_DIR)/data/output
QUESTION ?= best practices for go error handling
RAG_MODEL ?= gemma3:1b
PEEK ?= 3
DOC_ID ?=

ifneq (,$(filter rag-ask rag-sources,$(MAKECMDGOALS)))
EXTRA_QUESTION_WORDS := $(filter-out rag-ask rag-sources,$(MAKECMDGOALS))
ifneq (,$(strip $(EXTRA_QUESTION_WORDS)))
override QUESTION := $(EXTRA_QUESTION_WORDS)
endif
endif

# Prefer the project venv for Python RAG commands when it exists.
ifneq (,$(wildcard $(ROOT_DIR)/venv/bin/python))
PYTHON ?= $(ROOT_DIR)/venv/bin/python
else
PYTHON ?= python3
endif

# Normalize paths early so scripts receive stable absolute locations even when
# variables are supplied from .env or the make command line.
OUTPUT_DIR := $(abspath $(OUTPUT_DIR))
DB_FILE := $(abspath $(DB_FILE))
URL_QUEUE_DB_FILE := $(abspath $(URL_QUEUE_DB_FILE))
GOOGLE_OAUTH_CLIENT_FILE := $(abspath $(GOOGLE_OAUTH_CLIENT_FILE))
GOOGLE_OAUTH_TOKEN_FILE := $(abspath $(GOOGLE_OAUTH_TOKEN_FILE))
READER_APP_DIR := $(abspath $(READER_APP_DIR))
READER_COMPOSE_FILE := $(abspath $(READER_COMPOSE_FILE))
SCRAPER_APP_DIR := $(abspath $(SCRAPER_APP_DIR))
RAG_APP_DIR := $(abspath $(RAG_APP_DIR))
RAG_SOURCE_DIR := $(abspath $(RAG_SOURCE_DIR))

help:
	@printf '%s\n' \
	'Project Setup:' \
	'  make install                     Install npm dependencies' \
	'  make browsers                    Install Playwright browsers' \
	'  make build                       Build the TypeScript CLI' \
	'  make typecheck                   Run TypeScript checks' \
	'' \
	'Main Flow:' \
	'  make ingest                      Stage 1: read Drive files and create/update url_from_drive.db' \
	'  make scrape-queue                Stage 2: read url_from_drive.db, compare/promote into scraped-urls.db, save txt/json files' \
	'' \
	'Backup:' \
	'  make backup-db                   Upload scraped-urls.db to one Google Drive backup file' \
	'' \
	'Reader:' \
	'  make reader                      Run the local article reader UI server' \
	'  make reader-up                   Start the reader container in the background' \
	'  make reader-down                 Stop the reader container' \
	'  make reader-logs                 Tail reader container logs' \
	'' \
	'RAG Flow:' \
	'  make rag-venv                    Create a local Python virtualenv for the RAG app' \
	'  make rag-install                 Install Python dependencies for the RAG app' \
	'  make rag-sync                    Sync data/output metadata into data/state/manifest.json' \
	'  make rag-ingest                  Chunk and embed synced docs into Chroma' \
	'  make rag-ask QUESTION="..."      Query Chroma and ask local Ollama through RAG_MODEL' \
	'  make rag-ask "..."               Same as above, shorthand question form' \
	'' \
	'Inspection:' \
	'  make show-db                     Print scraped source URL database rows' \
	'  make rag-chroma-count            Print total stored Chroma chunks' \
	'  make rag-chroma-peek PEEK=3      Print a sample of Chroma records' \
	'  make rag-chroma-doc DOC_ID="..." Print all Chroma chunks for one doc id' \
	'' \
	'Dangerous Commands:' \
	'  make rescan                      Re-scrape all tracked DB URLs and refresh txt/json output files' \
	'  make reset-db                    Delete scraped source URL history' \
	'  make clean-output                Delete generated output files' \
	'' \
	'Variables:' \
	'  .env file supported at repo root' \
	'  OUTPUT_DIR=$(CURDIR)/data/output' \
	'  DB_FILE=$(CURDIR)/data/scraped-urls.db' \
	'  BROWSER=chrome|msedge|firefox|webkit' \
	'  CONNECT_URL=http://127.0.0.1:9222' \
	'  HEADLESS=true|false' \
	'  DRIVE_FOLDER_ID=<google-drive-folder-id>' \
	'  DRIVE_ARCHIVE_FOLDER_ID=<google-drive-archive-folder-id>' \
	'  DRIVE_FAILED_FOLDER_ID=<google-drive-failure-folder-id>' \
	'  URL_QUEUE_DB_FILE=$(CURDIR)/data/url_from_drive.db' \
	'  GOOGLE_OAUTH_CLIENT_FILE=$(CURDIR)/data/oauth/google-client.json' \
	'  GOOGLE_OAUTH_TOKEN_FILE=$(CURDIR)/data/oauth/google-token.json' \
	'  DRIVE_BACKUP_FOLDER_ID=<google-drive-folder-id>' \
	'  DRIVE_BACKUP_FILE_NAME=scraped-urls.db' \
	'  READER_APP_DIR=$(CURDIR)/apps/reader' \
	'  READER_COMPOSE_FILE=$(CURDIR)/docker-compose.reader.yml' \
	'  READER_PORT=3010' \
	'  SCRAPER_APP_DIR=$(CURDIR)/apps/scraper' \
	'  PYTHON=$(CURDIR)/venv/bin/python' \
	'  RAG_APP_DIR=$(CURDIR)/apps/rag' \
	'  RAG_SOURCE_DIR=$(CURDIR)/data/output' \
	'  QUESTION=best practices for go error handling' \
	'  RAG_MODEL=gemma3:1b'

## Install scraper dependencies from apps/scraper/package-lock.json.
install:
	npm --prefix "$(SCRAPER_APP_DIR)" install

## Install the Playwright browser used by the scraper.
browsers:
	npm --prefix "$(SCRAPER_APP_DIR)" run install:browsers

## Compile the TypeScript scraper CLI into apps/scraper/dist.
build:
	npm --prefix "$(SCRAPER_APP_DIR)" run build

## Run TypeScript checks without emitting compiled files.
typecheck:
	npm --prefix "$(SCRAPER_APP_DIR)" run typecheck

## Stage 1: read Google Drive files and stage URLs into url_from_drive.db
ingest:
	@if [ -z "$(DRIVE_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_FOLDER_ID. Usage: make ingest DRIVE_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --ingest-drive --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_ARCHIVE_FOLDER_ID),--driveArchiveFolderId="$(DRIVE_ARCHIVE_FOLDER_ID)",) $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

## Stage 2: read url_from_drive.db, scrape new URLs, save txt/json files, and promote into scraped-urls.db
scrape-queue:
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --scrape-queue --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

backup-db:
	@if [ -z "$(DRIVE_BACKUP_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_BACKUP_FOLDER_ID. Usage: make backup-db DRIVE_BACKUP_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --backup-db --dbFile="$(DB_FILE)" --driveBackupFolderId="$(DRIVE_BACKUP_FOLDER_ID)" --driveBackupFileName="$(DRIVE_BACKUP_FILE_NAME)" --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)"

## Start the reader UI directly with Node on READER_PORT.
reader:
	npm --prefix "$(READER_APP_DIR)" run dev -- --port="$(READER_PORT)"

## Build and start the reader UI container in the background.
reader-up:
	docker compose -f "$(READER_COMPOSE_FILE)" up -d --build

## Stop and remove the reader UI container.
reader-down:
	docker compose -f "$(READER_COMPOSE_FILE)" down

## Tail logs from the reader UI container.
reader-logs:
	docker compose -f "$(READER_COMPOSE_FILE)" logs -f reader

## Print scraped history and the retryable Drive URL queue.
show-db:
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --show-db --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)"

## !!! DANGEROUS: re-scrape every URL already stored in scraped-urls.db and refresh output files
rescan:
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --rescan-db --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

## !!! DANGEROUS: permanently delete all data in scraped-urls.db
reset-db:
	npm --prefix "$(SCRAPER_APP_DIR)" run scrape -- --reset --dbFile="$(DB_FILE)"

## !!! DANGEROUS: permanently delete generated output files
clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.json "$(OUTPUT_DIR)"/*.html "$(OUTPUT_DIR)"/*.png


## Create the Python virtualenv used by the RAG commands.
rag-venv:
	python3 -m venv "$(ROOT_DIR)/venv"

## Install or update Python dependencies for local Chroma/Gemma RAG.
rag-install:
	@if [ -x "$(ROOT_DIR)/venv/bin/python" ]; then \
		"$(ROOT_DIR)/venv/bin/python" -m pip install --upgrade pip; \
		"$(ROOT_DIR)/venv/bin/python" -m pip install -r "$(RAG_APP_DIR)/requirements.txt"; \
	else \
		python3 -m pip install --user --upgrade pip; \
		python3 -m pip install --user -r "$(RAG_APP_DIR)/requirements.txt"; \
	fi

## Sync scraper JSON sidecars into data/state/manifest.json.
rag-sync:
	$(PYTHON) "$(RAG_APP_DIR)/src/sync.py" --source-dir "$(RAG_SOURCE_DIR)"

## Chunk synced documents, embed them, and upsert chunks into Chroma.
rag-ingest:
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py"

## Force Chroma re-indexing even when content hashes are unchanged.
rag-reingest:
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py" --force

## Retrieve source chunks only; skips the Ollama/Gemma generation call.
rag-sources:
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)" --sources-only

## Ask a local Ollama model using Chroma retrieval context.
rag-ask:
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)" --model "$(RAG_MODEL)"

ifneq (,$(filter rag-ask rag-sources,$(MAKECMDGOALS)))
%:
	@:
endif

## Count all stored chunks in the default Chroma collection.
rag-chroma-count:
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" count

## Print a small sample of records from the Chroma collection.
rag-chroma-peek:
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" peek --limit "$(PEEK)"

## Print all chunks associated with one manifest doc id.
rag-chroma-doc:
	@if [ -z "$(DOC_ID)" ]; then \
		echo 'Missing DOC_ID. Usage: make rag-chroma-doc DOC_ID="doc_..."'; \
		exit 1; \
	fi
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" doc "$(DOC_ID)"
