.PHONY: help install browsers build typecheck ingest scrape-queue backup-db rescan reset-db show-db clean-output rag-venv rag-install rag-sync rag-ingest rag-reingest rag-sources rag-ask rag-chroma-count rag-chroma-peek rag-chroma-doc

ROOT_DIR := $(CURDIR)

ifneq (,$(wildcard .env))
include .env
export
endif

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
SCRAPER_APP_DIR ?= $(ROOT_DIR)/apps/scraper
RAG_APP_DIR ?= $(ROOT_DIR)/apps/rag
RAG_SOURCE_DIR ?= $(ROOT_DIR)/data/output
QUESTION ?= best practices for go error handling
PEEK ?= 3
DOC_ID ?=

ifneq (,$(wildcard $(ROOT_DIR)/venv/bin/python))
PYTHON ?= $(ROOT_DIR)/venv/bin/python
else
PYTHON ?= python3
endif

OUTPUT_DIR := $(abspath $(OUTPUT_DIR))
DB_FILE := $(abspath $(DB_FILE))
URL_QUEUE_DB_FILE := $(abspath $(URL_QUEUE_DB_FILE))
GOOGLE_OAUTH_CLIENT_FILE := $(abspath $(GOOGLE_OAUTH_CLIENT_FILE))
GOOGLE_OAUTH_TOKEN_FILE := $(abspath $(GOOGLE_OAUTH_TOKEN_FILE))
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
	'RAG Flow:' \
	'  make rag-venv                    Create a local Python virtualenv for the RAG app' \
	'  make rag-install                 Install Python dependencies for the RAG app' \
	'  make rag-sync                    Sync data/output metadata into data/state/manifest.json' \
	'  make rag-ingest                  Chunk and embed synced docs into Chroma' \
	'  make rag-ask QUESTION="..."      Query Chroma and ask local Gemma through Ollama' \
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
	'  SCRAPER_APP_DIR=$(CURDIR)/apps/scraper' \
	'  PYTHON=$(CURDIR)/venv/bin/python' \
	'  RAG_APP_DIR=$(CURDIR)/apps/rag' \
	'  RAG_SOURCE_DIR=$(CURDIR)/data/output' \
	'  QUESTION=best practices for go error handling'

install:
	npm --prefix "$(SCRAPER_APP_DIR)" install

browsers:
	npm --prefix "$(SCRAPER_APP_DIR)" run install:browsers

build:
	npm --prefix "$(SCRAPER_APP_DIR)" run build

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





rag-venv:
	python3 -m venv "$(ROOT_DIR)/venv"

rag-install:
	@if [ -x "$(ROOT_DIR)/venv/bin/python" ]; then \
		"$(ROOT_DIR)/venv/bin/python" -m pip install --upgrade pip; \
		"$(ROOT_DIR)/venv/bin/python" -m pip install -r "$(RAG_APP_DIR)/requirements.txt"; \
	else \
		python3 -m pip install --user --upgrade pip; \
		python3 -m pip install --user -r "$(RAG_APP_DIR)/requirements.txt"; \
	fi





rag-sync:
	$(PYTHON) "$(RAG_APP_DIR)/src/sync.py" --source-dir "$(RAG_SOURCE_DIR)"

rag-ingest:
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py"

rag-reingest:
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py" --force

rag-sources:
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)" --sources-only

rag-ask:
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)"

rag-chroma-count:
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" count

rag-chroma-peek:
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" peek --limit "$(PEEK)"

rag-chroma-doc:
	$(PYTHON) "$(RAG_APP_DIR)/src/chroma_inspect.py" doc "$(DOC_ID)"
