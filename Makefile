.PHONY: help install browsers build typecheck ingest drive-to-database scrape-queue scrape-url-database backup-db rescan reset-db show-db clean-output

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
DRIVE_BACKUP_FOLDER_ID ?=
DRIVE_BACKUP_FILE_NAME ?= scraped-urls.db

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
	'  make scrape-queue                Stage 2: read url_from_drive.db, compare/promote into scraped-urls.db, save txt files' \
	'' \
	'Backup:' \
	'  make backup-db                   Upload scraped-urls.db to one Google Drive backup file' \
	'' \
	'Inspection:' \
	'  make show-db                     Print scraped source URL database rows' \
	'' \
	'Dangerous Commands:' \
	'  make rescan                      Re-scrape all tracked DB URLs and refresh output files' \
	'  make reset-db                    Delete scraped source URL history' \
	'  make clean-output                Delete generated output files' \
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
	'  GOOGLE_OAUTH_TOKEN_FILE=./data/oauth/google-token.json' \
	'  DRIVE_BACKUP_FOLDER_ID=<google-drive-folder-id>' \
	'  DRIVE_BACKUP_FILE_NAME=scraped-urls.db'

install:
	npm install

browsers:
	npm run install:browsers

build:
	npm run build

typecheck:
	npm run typecheck

## Stage 1: read Google Drive files and stage URLs into url_from_drive.db
ingest: drive-to-database

drive-to-database:
	@if [ -z "$(DRIVE_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_FOLDER_ID. Usage: make ingest DRIVE_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm run scrape -- --ingest-drive --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" --driveFolderId="$(DRIVE_FOLDER_ID)" $(if $(DRIVE_ARCHIVE_FOLDER_ID),--driveArchiveFolderId="$(DRIVE_ARCHIVE_FOLDER_ID)",) $(if $(DRIVE_FAILED_FOLDER_ID),--driveFailedFolderId="$(DRIVE_FAILED_FOLDER_ID)",) --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

## Stage 2: read url_from_drive.db, scrape new URLs, save txt files, and promote into scraped-urls.db
scrape-queue: scrape-url-database

scrape-url-database:
	npm run scrape -- --scrape-queue --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

backup-db:
	@if [ -z "$(DRIVE_BACKUP_FOLDER_ID)" ]; then \
		echo 'Missing DRIVE_BACKUP_FOLDER_ID. Usage: make backup-db DRIVE_BACKUP_FOLDER_ID="<google-drive-folder-id>"'; \
		exit 1; \
	fi
	npm run scrape -- --backup-db --dbFile="$(DB_FILE)" --driveBackupFolderId="$(DRIVE_BACKUP_FOLDER_ID)" --driveBackupFileName="$(DRIVE_BACKUP_FILE_NAME)" --oauthClientFile="$(GOOGLE_OAUTH_CLIENT_FILE)" --oauthTokenFile="$(GOOGLE_OAUTH_TOKEN_FILE)"

show-db:
	npm run scrape -- --show-db --dbFile="$(DB_FILE)" --queueDbFile="$(URL_QUEUE_DB_FILE)"

## !!! DANGEROUS: re-scrape every URL already stored in scraped-urls.db and refresh output files
rescan:
	npm run scrape -- --rescan-db --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

## !!! DANGEROUS: permanently delete all data in scraped-urls.db
reset-db:
	npm run scrape -- --reset --dbFile="$(DB_FILE)"

## !!! DANGEROUS: permanently delete generated output files
clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.html "$(OUTPUT_DIR)"/*.png
