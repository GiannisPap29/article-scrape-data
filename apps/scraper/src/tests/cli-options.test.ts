import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliArgs, parseDelayRange, parseFreediumUrls } from "../scraper/cli-options.js";

test("parseDelayRange accepts fixed and range values", () => {
  assert.deepEqual(parseDelayRange(null), [3000, 8000]);
  assert.deepEqual(parseDelayRange("5000"), [5000, 5000]);
  assert.deepEqual(parseDelayRange("2000-4000"), [2000, 4000]);
  assert.deepEqual(parseDelayRange("4000 - 2000"), [2000, 4000]);
  assert.throws(() => parseDelayRange("soon"), /Invalid SCRAPE_DELAY_MS/);
});

test("parseFreediumUrls normalizes and de-duplicates mirrors", () => {
  assert.deepEqual(
    parseFreediumUrls("https://freedium-mirror.cfd", " https://freedium.cfd/path , https://freedium-mirror.cfd/ "),
    ["https://freedium-mirror.cfd/", "https://freedium.cfd/"]
  );
  assert.throws(() => parseFreediumUrls("not a url", null), /Invalid Freedium mirror URL/);
});

test("parseCliArgs maps flags to options", () => {
  const options = parseCliArgs(["--run", "--browser=firefox", "--libraryDbFile=/tmp/x.db", "--headless=false"]);
  assert.equal(options.command, "run");
  assert.equal(options.browser, "firefox");
  assert.equal(options.libraryDbFile, "/tmp/x.db");
  assert.equal(options.headless, false);
  assert.throws(() => parseCliArgs(["--browser=netscape"]), /Invalid --browser value/);
  assert.throws(() => parseCliArgs(["--outputDir="]), /Missing value for --outputDir/);
});
