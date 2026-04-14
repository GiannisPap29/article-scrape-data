.PHONY: help install browsers build typecheck scrape scrape-headed clean-output show-tracking reset-tracking

URL ?=
OUTPUT_DIR ?= ./data/output
TRACKING_FILE ?= ./data/scraped-urls.json
HEADLESS ?= true

help:
	@printf '%s\n' \
	'Targets:' \
	'  make install                     Install npm dependencies' \
	'  make browsers                    Install Playwright Chromium browser' \
	'  make build                       Build all workspaces' \
	'  make typecheck                   Run TypeScript checks' \
	'  make scrape URL=...              Scrape one URL and track it' \
	'  make scrape-headed URL=...       Scrape one URL with visible browser' \
	'  make show-tracking               Print tracked scraped URLs JSON' \
	'  make reset-tracking              Reset tracked scraped URLs' \
	'  make clean-output                Remove generated output files' \
	'' \
	'Variables:' \
	'  URL=https://freedium-mirror.cfd/https://medium.com/...' \
	'  OUTPUT_DIR=./data/output' \
	'  TRACKING_FILE=./data/scraped-urls.json'

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
		echo 'Missing URL. Use: make scrape URL=https://freedium-mirror.cfd/https://medium.com/...'; \
		exit 1; \
	fi
	npm run scrape -- --url="$(URL)" --outputDir="$(OUTPUT_DIR)" --trackingFile="$(TRACKING_FILE)" $(if $(filter false,$(HEADLESS)),--headless=false,)

scrape-headed:
	@$(MAKE) scrape URL="$(URL)" OUTPUT_DIR="$(OUTPUT_DIR)" TRACKING_FILE="$(TRACKING_FILE)" HEADLESS=false

show-tracking:
	@if [ -f "$(TRACKING_FILE)" ]; then \
		cat "$(TRACKING_FILE)"; \
	else \
		echo '{}'; \
	fi

reset-tracking:
	@mkdir -p "$$(dirname "$(TRACKING_FILE)")"
	printf '{}\n' > "$(TRACKING_FILE)"

clean-output:
	rm -f "$(OUTPUT_DIR)"/*.txt "$(OUTPUT_DIR)"/*.html "$(OUTPUT_DIR)"/*.png
