import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildStableOutputPath, writeExtraction } from "../scraper/output.js";
import { type ExtractionResult } from "../scraper/types.js";

const SOURCE_URL = "https://medium.com/@a/my-post-0123456789ab";

function extraction(tags: string[]): ExtractionResult {
  return {
    article: { docId: "doc_x", sourceUrl: SOURCE_URL, title: "my post" },
    author: "Ada", content: "## Hello\n\nBody", contentFormat: "markdown",
    coverImage: null, excerpt: "Sub", language: "en", publishedAt: "2026-06-25T01:38:25.423Z",
    readingTimeMinutes: 4, siteName: "Medium", tags, title: "My Post",
    freedium: { free: false, publication: null, updatedAt: null, url: `https://freedium-mirror.cfd/${SOURCE_URL}` }
  };
}

test("writes a .txt/.json pair with relative paths and no temp files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "output-"));
  const result = await writeExtraction(dir, extraction(["go"]), null);
  const txt = buildStableOutputPath(dir, SOURCE_URL);
  assert.equal(result.outputPath, txt);
  const sidecar = JSON.parse(readFileSync(txt.replace(/\.txt$/u, ".json"), "utf8"));
  assert.equal(sidecar.outputPath, path.basename(txt));
  assert.equal(sidecar.scraperMetadataVersion, 4);
  assert.equal(sidecar.contentFormat, "markdown");
  assert.equal(readFileSync(txt, "utf8"), "## Hello\n\nBody\n");
  assert.deepEqual(readdirSync(dir).sort(), [path.basename(txt).replace(/\.txt$/u, ".json"), path.basename(txt)].sort());
});

test("a re-scrape without tags keeps the tags of the previous sidecar", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "output-"));
  const json = buildStableOutputPath(dir, SOURCE_URL).replace(/\.txt$/u, ".json");
  writeFileSync(json, JSON.stringify({ tags: ["nodejs", "backend"] }));
  await writeExtraction(dir, extraction([]), null);
  assert.deepEqual(JSON.parse(readFileSync(json, "utf8")).tags, ["nodejs", "backend"]);
  // Fresh tags always win.
  await writeExtraction(dir, extraction(["fresh"]), null);
  assert.deepEqual(JSON.parse(readFileSync(json, "utf8")).tags, ["fresh"]);
});
