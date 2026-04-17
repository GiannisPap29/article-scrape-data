.PHONY: help install browsers build typecheck scan scan-drive watch watch-drive reset-db show-db clean-output

ifneq (,$(wildcard .env))
include .env
export
endif

OUTPUT_DIR ?= ./data/output
DB_FILE ?= ./data/scraped-urls.db
BROWSER ?= chrome
CONNECT_URL ?=
HEADLESS ?= true
URL ?=
DRIVE_FOLDER_ID ?=
DRIVE_FAILED_FOLDER_ID ?=
GOOGLE_OAUTH_CLIENT_FILE ?= ./data/oauth/google-client.json
GOOGLE_OAUTH_TOKEN_FILE ?= ./data/oauth/google-token.json
POLL_INTERVAL_MINUTES ?= 30

help:
	@printf '%s\n' \
	'Targets:' \
	'  make install                     Install npm dependencies' \
	'  make browsers                    Install Playwright browsers' \
	'  make build                       Build all workspaces' \
	'  make typecheck                   Run TypeScript checks' \
	'  make scan                        Process the default Drive folder once' \
	'  make scan-drive                  Process the Drive folder in DRIVE_FOLDER_ID once' \
	'  make watch                       Poll the default Drive folder every POLL_INTERVAL_MINUTES' \
	'  make watch-drive                 Poll Google Drive every POLL_INTERVAL_MINUTES' \
	'  make show-db                     Print scraped source URL database rows' \
	'  make reset-db                    Reset scraped source URL database' \
	'  make clean-output                Remove generated output files' \
	'' \
	'Variables:' \
	'  .env file supported at repo root' \
	'  OUTPUT_DIR=./data/output' \
	'  DB_FILE=./data/scraped-urls.db' \
	'  BROWSER=chrome|msedge|firefox|webkit' \
	'  CONNECT_URL=http://127.0.0.1:9222' \
	'  HEADLESS=true|false' \
	'  DRIVE_FOLDER_ID=<google-drive-folder-id>' \
	'  DRIVE_FAILED_FOLDER_ID=<google-drive-failure-folder-id>' \
	'  GOOGLE_OAUTH_CLIENT_FILE=./data/oauth/google-client.json' \
	'  GOOGLE_OAUTH_TOKEN_FILE=./data/oauth/google-token.json' \
	'  POLL_INTERVAL_MINUTES=30'

install:
	npm install

browsers:
	npm run install:browsers

build:
	npm run build

typecheck:
	npm run typecheck

scan: scan-drive

scan-drive:
	@if [ -z "$(DRIVE_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_FOLDER_ID. Usage: make scan-drive DRIVE_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm run scrape -- --scan-drive --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)" --pollIntervalMinutes="$(POLL_INTERVAL_MINUTES)" $(if $(filter false,$(HEADLESS)),--headless=false,)

watch: watch-drive

watch-drive:
	@if [ -z "$(DRIVE_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_FOLDER_ID. Usage: make watch-drive DRIVE_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm run scrape -- --watch-drive --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)" --pollIntervalMinutes="$(POLL_INTERVAL_MINUTES)" $(if $(filter false,$(HEADLESS)),--headless=false,)

show-db:
	@if [ -f "$(DB_FILE)" ]; then \
		sqlite3 -header -column "$(DB_FILE)" 'SELECT source_url, output_path, scraped_at FROM scraped_urls ORDER BY scraped_at DESC;'; \
	else \
		echo 'No database found: $(DB_FILE)'; \
	fi

reset-db:
	npm run scrape -- --reset --dbFile="$(DB_FILE)"

clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.html "$(OUTPUT_DIR)"/*.png
