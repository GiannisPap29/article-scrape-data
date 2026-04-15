.PHONY: help install browsers build typecheck scrape scrape-headed ui ui-headed reset-db show-db clean-output

URL ?=
OUTPUT_DIR ?= ./data/output
DB_FILE ?= ./data/scraped-urls.db
BROWSER ?= chrome
CONNECT_URL ?=
HEADLESS ?= true
PORT ?= 3000

help:
	@printf '%s\n' \
	'Targets:' \
	'  make install                     Install npm dependencies' \
	'  make browsers                    Install Playwright browsers' \
	'  make build                       Build all workspaces' \
	'  make typecheck                   Run TypeScript checks' \
	'  make scrape URL=...              Scrape one article URL through Freedium' \
	'  make scrape-headed URL=...       Scrape one article URL with visible browser' \
	'  make ui                          Start local web UI' \
	'  make ui-headed                   Start local web UI with visible browser for scrapes' \
	'  make show-db                     Print scraped source URL database rows' \
	'  make reset-db                    Reset scraped source URL database' \
	'  make clean-output                Remove generated output files' \
	'' \
	'Variables:' \
	'  URL=https://medium.com/...' \
	'  OUTPUT_DIR=./data/output' \
	'  DB_FILE=./data/scraped-urls.db' \
	'  BROWSER=chrome|msedge|firefox|webkit' \
	'  CONNECT_URL=http://127.0.0.1:9222' \
	'  PORT=3000'

install:
	npm install

browsers:
	npm run install:browsers

build:
	npm run build

typecheck:
	npm run typecheck

scrape:
	@if [ -z "$(URL)" ]; then \
		echo 'Missing URL. Use: make scrape URL=https://medium.com/...'; \
		exit 1; \
	fi
	npm run scrape -- --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --url="$(URL)" --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

scrape-headed:
	@$(MAKE) scrape URL="$(URL)" OUTPUT_DIR="$(OUTPUT_DIR)" DB_FILE="$(DB_FILE)" BROWSER="$(BROWSER)" CONNECT_URL="$(CONNECT_URL)" HEADLESS=false

ui:
	npm run scrape -- --serve --browser="$(BROWSER)" $(if $(CONNECT_URL),--connectUrl="$(CONNECT_URL)",) --outputDir="$(OUTPUT_DIR)" --dbFile="$(DB_FILE)" --port="$(PORT)" $(if $(filter false,$(HEADLESS)),--headless=false,)

ui-headed:
	@$(MAKE) ui OUTPUT_DIR="$(OUTPUT_DIR)" DB_FILE="$(DB_FILE)" BROWSER="$(BROWSER)" CONNECT_URL="$(CONNECT_URL)" PORT="$(PORT)" HEADLESS=false

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
