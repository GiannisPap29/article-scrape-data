# web-scrapper: Drive MEDIUM inbox -> Freedium -> local library -> reader + RAG.
# Run `make` (or `make help`) for the command list.

.DEFAULT_GOAL := help

ROOT_DIR := $(CURDIR)

# Root .env values override the ?= defaults below.
ifneq (,$(wildcard .env))
include .env
export
endif

# --- Paths -------------------------------------------------------------------
OUTPUT_DIR ?= $(ROOT_DIR)/data/output
DEBUG_DIR ?= $(ROOT_DIR)/data/debug
BACKUPS_DIR ?= $(ROOT_DIR)/data/backups
LIBRARY_DB_FILE ?= $(ROOT_DIR)/data/library.db
RAG_MANIFEST_FILE ?= $(ROOT_DIR)/data/state/manifest.json
GOOGLE_OAUTH_CLIENT_FILE ?= $(ROOT_DIR)/data/oauth/google-client.json
GOOGLE_OAUTH_TOKEN_FILE ?= $(ROOT_DIR)/data/oauth/google-token.json
SCRAPER_APP_DIR := $(ROOT_DIR)/apps/scraper
READER_APP_DIR := $(ROOT_DIR)/apps/reader
RAG_APP_DIR := $(ROOT_DIR)/apps/rag
READER_COMPOSE_FILE := $(ROOT_DIR)/docker-compose.reader.yml
SYSTEMD_USER_DIR ?= $(HOME)/.config/systemd/user

# Values from .env may be relative; the scraper runs from apps/scraper, so
# hand it absolute paths.
OUTPUT_DIR := $(abspath $(OUTPUT_DIR))
DEBUG_DIR := $(abspath $(DEBUG_DIR))
BACKUPS_DIR := $(abspath $(BACKUPS_DIR))
LIBRARY_DB_FILE := $(abspath $(LIBRARY_DB_FILE))
RAG_MANIFEST_FILE := $(abspath $(RAG_MANIFEST_FILE))
GOOGLE_OAUTH_CLIENT_FILE := $(abspath $(GOOGLE_OAUTH_CLIENT_FILE))
GOOGLE_OAUTH_TOKEN_FILE := $(abspath $(GOOGLE_OAUTH_TOKEN_FILE))

# --- Settings (normally set in .env) -------------------------------------------
BROWSER ?= chrome
CONNECT_URL ?=
HEADLESS ?= true
DRIVE_FOLDER_ID ?=
DRIVE_ARCHIVE_FOLDER_ID ?=
DRIVE_FAILED_FOLDER_ID ?=
DRIVE_BACKUP_FOLDER_ID ?=
DRIVE_BACKUP_FILE_NAME ?= library.db
READER_PORT ?= 3010
RAG_MODEL ?= gemma3:1b
RAG_EMBED_MODEL ?= embeddinggemma
QUESTION ?=
DOC_ID ?=
FILE ?=
FORCE ?=

ifneq (,$(wildcard $(ROOT_DIR)/venv/bin/python))
PYTHON ?= $(ROOT_DIR)/venv/bin/python
else
PYTHON ?= python3
endif

# `make rag-ask how do goroutines leak` works without QUESTION="...".
ifneq (,$(filter rag-ask rag-sources,$(MAKECMDGOALS)))
EXTRA_QUESTION_WORDS := $(filter-out rag-ask rag-sources,$(MAKECMDGOALS))
ifneq (,$(strip $(EXTRA_QUESTION_WORDS)))
override QUESTION := $(EXTRA_QUESTION_WORDS)
endif
%:
	@:
endif

# --- Shared command pieces -----------------------------------------------------
# Every scraper command rebuilds the TypeScript first (fast, incremental).
SCRAPE = npm --prefix "$(SCRAPER_APP_DIR)" run --silent scrape --
LIBRARY_FLAGS = --libraryDbFile="$(LIBRARY_DB_FILE)"
BROWSER_FLAGS = --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) $(if $(filter false,$(HEADLESS)),--headless=false,) --outputDir="$(OUTPUT_DIR)" --debugDir="$(DEBUG_DIR)"
OAUTH_FLAGS = --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)"
DRIVE_FLAGS = --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_ARCHIVE_FOLDER_ID),--driveArchiveFolderId="$(DRIVE_ARCHIVE_FOLDER_ID)",) $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) $(OAUTH_FLAGS)
BACKUP_FLAGS = $(if $(DRIVE_BACKUP_FOLDER_ID),--driveBackupFolderId="$(DRIVE_BACKUP_FOLDER_ID)",) --driveBackupFileName="$(DRIVE_BACKUP_FILE_NAME)"
REQUIRE_DRIVE = @if [ -z "$(DRIVE_FOLDER_ID)" ]; then echo 'Missing DRIVE_FOLDER_ID (set it in .env).'; exit 1; fi

.PHONY: help setup test run run-unlocked status retry-failed \
	ingest scrape-queue backup-db rag-sync rag-tag rag-ingest \
	reader reader-up reader-down reader-logs rag-ask rag-sources rag-index rag-index-doc \
	export-urls requeue-urls rescan reset-db clean-output clean-debug \
	schedule-install schedule-status schedule-remove

help:
	@printf '%s\n' \
	'Every day:' \
	'  make run                  Everything: Drive MEDIUM -> scrape -> library -> Drive backup -> tags -> AI index' \
	'  make status               Counts, queue errors, and what is still to index' \
	'' \
	'Read and ask:' \
	'  make reader               Reader website at http://127.0.0.1:$(READER_PORT) (this terminal)' \
	'  make reader-up            Same, always on in Docker   (reader-down, reader-logs)' \
	'  make rag-ask QUESTION=".." Answer from your articles with sources (local Ollama)' \
	'  make rag-sources QUESTION=".." Only the matching article passages, no AI answer' \
	'  (Claude Code in this folder can search the library itself: see .mcp.json)' \
	'' \
	'The steps of make run, one by one:' \
	'  make ingest               1. Drive MEDIUM -> queue (files move to MEDIUM_ARCHIVED / MEDIUM_FAILED)' \
	'  make scrape-queue         2. Queue -> Freedium -> data/output + scraped history' \
	'  make backup-db            3. Upload library.db to Drive MEDIUM/MEDIUM_BACKUPS' \
	'  make rag-sync             4. Tell the AI index about new/changed articles' \
	'  make rag-tag              5. Auto-tag articles that have no tags' \
	'  make rag-ingest           6. Build the AI index (FORCE=1 rebuilds everything)' \
	'' \
	'When something failed:' \
	'  make retry-failed         Give failed / gave-up URLs another try on the next run' \
	'' \
	'Safety net for your URL list:' \
	'  make export-urls          Write all scraped URLs to data/backups/scraped-urls.txt (make run does it too)' \
	'  make requeue-urls FILE=.. Queue URLs from a text file (e.g. after losing library.db), then make run' \
	'  make rescan               Re-scrape every article in the history (after deleting files, or to refresh)' \
	'' \
	'Dangerous:' \
	'  make reset-db             Delete the scraped history (snapshot + URL list saved to data/backups first)' \
	'  make clean-output         Delete all article files in data/output' \
	'  make clean-debug          Delete failed-scrape screenshots in data/debug' \
	'' \
	'Nightly schedule (optional, off by default):' \
	'  make schedule-install     make run every night at 03:30, headless   (schedule-status, schedule-remove)' \
	'' \
	'Setup and checks:' \
	'  make setup                Install everything (npm, Python venv, Ollama models)' \
	'  make test                 Unit tests for all three apps (no network, no real data)' \
	'  make rag-index            What is in the AI index   (rag-index-doc DOC_ID=.. for one article)'

# --- Setup and checks ----------------------------------------------------------

## Idempotent: safe to re-run. Rebuilds the venv if a system Python upgrade
## broke it, pinned to the exact interpreter version (e.g. python3.14).
setup:
	npm --prefix "$(SCRAPER_APP_DIR)" install
	$(if $(filter chromium,$(BROWSER)),npm --prefix "$(SCRAPER_APP_DIR)" run install:browsers,@echo 'Using the installed $(BROWSER) browser (set BROWSER=chromium to download Playwright Chromium).')
	@if ! "$(ROOT_DIR)/venv/bin/python" -c 'import sys' 2>/dev/null; then \
		py="$$(python3 -c 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")')"; \
		echo "Creating venv with $$py"; rm -rf "$(ROOT_DIR)/venv"; "$$py" -m venv "$(ROOT_DIR)/venv"; \
	fi
	"$(ROOT_DIR)/venv/bin/python" -m pip install --quiet --upgrade pip
	"$(ROOT_DIR)/venv/bin/python" -m pip install --quiet -r "$(RAG_APP_DIR)/requirements.txt"
	@if command -v ollama >/dev/null; then ollama pull "$(RAG_MODEL)" && ollama pull "$(RAG_EMBED_MODEL)"; \
	else echo 'Ollama not found: install it from https://ollama.com/download and re-run make setup.'; fi
	@[ -f .env ] || echo 'Next: cp .env.example .env and set DRIVE_FOLDER_ID.'
	@[ -f "$(GOOGLE_OAUTH_CLIENT_FILE)" ] || echo 'Next: put your Google OAuth client JSON at $(GOOGLE_OAUTH_CLIENT_FILE).'

test:
	npm --prefix "$(SCRAPER_APP_DIR)" test
	npm --prefix "$(READER_APP_DIR)" test
	$(PYTHON) -m unittest discover -s "$(RAG_APP_DIR)/tests"

# --- Every day -------------------------------------------------------------------

## A lock stops a scheduled and a manual run from overlapping. make itself
## exits 0 on success and 2 on any problem; the last line says which.
run:
	@flock -n -E 75 "$(ROOT_DIR)/data/.run.lock" $(MAKE) --no-print-directory run-unlocked; \
	status=$$?; \
	if [ $$status -eq 75 ]; then echo 'run: another make run is already in progress (data/.run.lock).'; fi; \
	exit $$status

## Scraper exit code: 0 = all good, 2 = finished but some URLs failed (kept
## for retry; the AI steps still run), anything else = crash (AI steps skipped).
run-unlocked:
	$(REQUIRE_DRIVE)
	@status=0; \
	$(SCRAPE) --run $(LIBRARY_FLAGS) $(BROWSER_FLAGS) $(DRIVE_FLAGS) $(BACKUP_FLAGS) --backupsDir="$(BACKUPS_DIR)" || status=$$?; \
	if [ $$status -ne 0 ] && [ $$status -ne 2 ]; then echo "run: scraper stopped with exit code $$status; skipping the AI steps."; exit $$status; fi; \
	$(PYTHON) "$(RAG_APP_DIR)/src/sync.py" --source-dir "$(OUTPUT_DIR)" || exit 1; \
	$(PYTHON) "$(RAG_APP_DIR)/src/tag.py" --model "$(RAG_MODEL)" || echo 'run: tagging failed; continuing without new tags.'; \
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py" --embed-model "$(RAG_EMBED_MODEL)" || exit 1; \
	if [ $$status -eq 2 ]; then echo 'run: finished, but some items need a look. See: make status'; fi; \
	exit $$status

status:
	@$(SCRAPE) --status $(LIBRARY_FLAGS) --outputDir="$(OUTPUT_DIR)" --debugDir="$(DEBUG_DIR)" --manifestFile="$(RAG_MANIFEST_FILE)" | grep -v '\[info\] Starting command='

# --- The steps of make run ---------------------------------------------------------

ingest:
	$(REQUIRE_DRIVE)
	$(SCRAPE) --ingest-drive $(LIBRARY_FLAGS) $(DRIVE_FLAGS)

scrape-queue:
	$(SCRAPE) --scrape-queue $(LIBRARY_FLAGS) $(BROWSER_FLAGS)

## Without a separate DRIVE_BACKUP_FOLDER_ID the copy goes to MEDIUM/MEDIUM_BACKUPS.
backup-db:
	$(REQUIRE_DRIVE)
	$(SCRAPE) --backup-db $(LIBRARY_FLAGS) --driveFolderId="$(DRIVE_FOLDER_ID)" $(BACKUP_FLAGS) $(OAUTH_FLAGS)

rag-sync:
	$(PYTHON) "$(RAG_APP_DIR)/src/sync.py" --source-dir "$(OUTPUT_DIR)"

rag-tag:
	$(PYTHON) "$(RAG_APP_DIR)/src/tag.py" --model "$(RAG_MODEL)"

rag-ingest:
	$(PYTHON) "$(RAG_APP_DIR)/src/ingest.py" --embed-model "$(RAG_EMBED_MODEL)" $(if $(filter 1 true yes,$(FORCE)),--force,)

# --- Read and ask ------------------------------------------------------------------

reader:
	npm --prefix "$(READER_APP_DIR)" run --silent dev -- --port="$(READER_PORT)"

reader-up:
	docker compose -f "$(READER_COMPOSE_FILE)" up -d --build

reader-down:
	docker compose -f "$(READER_COMPOSE_FILE)" down

reader-logs:
	docker compose -f "$(READER_COMPOSE_FILE)" logs -f reader

rag-ask:
	@[ -n "$(QUESTION)" ] || { echo 'Usage: make rag-ask QUESTION="how do I handle errors in Go"'; exit 1; }
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)" --embed-model "$(RAG_EMBED_MODEL)" --model "$(RAG_MODEL)"

rag-sources:
	@[ -n "$(QUESTION)" ] || { echo 'Usage: make rag-sources QUESTION="how do I handle errors in Go"'; exit 1; }
	$(PYTHON) "$(RAG_APP_DIR)/src/query.py" "$(QUESTION)" --embed-model "$(RAG_EMBED_MODEL)" --sources-only

rag-index:
	$(PYTHON) "$(RAG_APP_DIR)/src/index_inspect.py" collections

rag-index-doc:
	@[ -n "$(DOC_ID)" ] || { echo 'Usage: make rag-index-doc DOC_ID="doc_..."'; exit 1; }
	$(PYTHON) "$(RAG_APP_DIR)/src/index_inspect.py" doc "$(DOC_ID)"

# --- Failures and safety net ---------------------------------------------------------

retry-failed:
	$(SCRAPE) --retry-failed $(LIBRARY_FLAGS)

export-urls:
	$(SCRAPE) --export-urls $(LIBRARY_FLAGS) --backupsDir="$(BACKUPS_DIR)"

## URLs still in the scraped history are reported, not queued (use make rescan).
requeue-urls:
	@[ -n "$(FILE)" ] || { echo 'Usage: make requeue-urls FILE=data/backups/scraped-urls.txt'; exit 1; }
	$(SCRAPE) --requeue-urls="$(abspath $(FILE))" $(LIBRARY_FLAGS)

rescan:
	$(SCRAPE) --rescan-db $(LIBRARY_FLAGS) $(BROWSER_FLAGS)

# --- Dangerous -----------------------------------------------------------------------

reset-db:
	$(SCRAPE) --reset $(LIBRARY_FLAGS) --backupsDir="$(BACKUPS_DIR)"

clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.json

clean-debug:
	rm -f "$(DEBUG_DIR)"/*.html "$(DEBUG_DIR)"/*.png

# --- Optional nightly schedule (systemd user timer) ------------------------------------
# Never installed automatically. Units are rendered from deploy/systemd with this
# checkout's path. If the Google token needs a new browser login, the scheduled
# Drive step fails but queued URLs are still scraped.

schedule-install:
	@mkdir -p "$(SYSTEMD_USER_DIR)"
	@sed "s#@ROOT_DIR@#$(ROOT_DIR)#g" "$(ROOT_DIR)/deploy/systemd/web-scrapper-run.service" > "$(SYSTEMD_USER_DIR)/web-scrapper-run.service"
	@cp "$(ROOT_DIR)/deploy/systemd/web-scrapper-run.timer" "$(SYSTEMD_USER_DIR)/web-scrapper-run.timer"
	systemctl --user daemon-reload
	systemctl --user enable --now web-scrapper-run.timer
	@systemctl --user list-timers web-scrapper-run.timer --no-pager

schedule-status:
	-@systemctl --user list-timers web-scrapper-run.timer --no-pager
	-@journalctl --user -u web-scrapper-run.service -n 20 --no-pager

schedule-remove:
	-systemctl --user disable --now web-scrapper-run.timer
	rm -f "$(SYSTEMD_USER_DIR)/web-scrapper-run.service" "$(SYSTEMD_USER_DIR)/web-scrapper-run.timer"
	systemctl --user daemon-reload
