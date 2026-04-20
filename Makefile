.PHONY: help install browsers build typecheck ingest scrape-queue rescan reset-db show-db clean-output

ifneq (,$(wildcard .env))
include .env
export
endif

OUTPUT_DIR ?= ./data/output
DB_FILE ?= ./data/scraped-urls.db
BROWSER ?= chrome
CONNECT_URL ?=
HEADLESS ?= true
DRIVE_FOLDER_ID ?=
DRIVE_ARCHIVE_FOLDER_ID ?=
DRIVE_FAILED_FOLDER_ID ?=
URL_QUEUE_DB_FILE ?= ./data/url_from_drive.db
GOOGLE_OAUTH_CLIENT_FILE ?= ./data/oauth/google-client.json
GOOGLE_OAUTH_TOKEN_FILE ?= ./data/oauth/google-token.json

help:
	@printf '%s\n' \
	'Targets:' \
	'  make install                     Install npm dependencies' \
	'  make browsers                    Install Playwright browsers' \
	'  make build                       Build all workspaces' \
	'  make typecheck                   Run TypeScript checks' \
	'  make ingest                      Read Drive inbox and enqueue URLs into url_from_drive.db' \
	'  make scrape-queue                Scrape queued URLs from url_from_drive.db into scraped-urls.db' \
	'  make rescan                      Re-scrape all tracked DB URLs and refresh output files' \
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
	'  DRIVE_ARCHIVE_FOLDER_ID=<google-drive-archive-folder-id>' \
	'  DRIVE_FAILED_FOLDER_ID=<google-drive-failure-folder-id>' \
	'  URL_QUEUE_DB_FILE=./data/url_from_drive.db' \
	'  GOOGLE_OAUTH_CLIENT_FILE=./data/oauth/google-client.json' \
	'  GOOGLE_OAUTH_TOKEN_FILE=./data/oauth/google-token.json'

install:
	npm install

browsers:
	npm run install:browsers

build:
	npm run build

typecheck:
	npm run typecheck

## scan all files from google drive folder and ingest urls into url_from_drive.db for later processing
ingest:
	@if [ -z "$(DRIVE_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_FOLDER_ID. Usage: make ingest DRIVE_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm run scrape -- --ingest-drive --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_ARCHIVE_FOLDER_ID),--driveArchiveFolderId="$(DRIVE_ARCHIVE_FOLDER_ID)",) $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)



scrape-queue:
	npm run scrape -- --scrape-queue --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)





## ONLY FOR RESCAN from history database . This will re-scrape all URLs in the scraped-urls.db and update output files. Use with caution as it may cause a lot of traffic and potential blocks if the target sites have anti-scraping measures.
rescan:
	npm run scrape -- --rescan-db --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)



 ## !!! DANGEROUS: This will permanently delete all data in the scraped-urls.db and reset the database. 
reset-db:
	npm run scrape -- --reset --dbFile="$(DB_FILE)"
## !!! DANGEROUS: This will permanently delete all files from the output directory. Use with caution.
clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.html "$(OUTPUT_DIR)"/*.png
