import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getAllQueuedUrlRecords, openLibraryDatabase, upsertScrapedUrlRecord } from "../scraper/db.js";
import { exportScrapedUrlList, parseUrlList, requeueUrlsFromFile, snapshotLibrary } from "../scraper/pipeline.js";

const A = "https://medium.com/@a/first-post-0123456789ab";
const B = "https://medium.com/skillstuff/second-post-abcdef012345";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safety-"));
  const options = {
    backupsDir: path.join(dir, "backups"),
    libraryDbFile: path.join(dir, "library.db")
  };
  const db = openLibraryDatabase(options.libraryDbFile);
  upsertScrapedUrlRecord(db, {
    author: null, contentHash: null, docId: "d", excerpt: null, freediumUrl: null, language: null, metadataPath: null,
    outputPath: "/x.txt", publishedAt: null, scrapedAt: "2026-10-18T00:00:00.000Z", siteName: null, sourceUrl: B, tagsJson: null, title: null
  });
  db.close();
  return { dir, options };
}

test("parseUrlList normalizes, de-duplicates, skips comments and non-articles", () => {
  const text = `# my list\n${A}?source=rss\n  ${A}\nsee ${B}, and https://medium.com/@someone\n`;
  const { invalid, urls } = parseUrlList(text);
  assert.deepEqual(urls, [A, B]);
  assert.deepEqual(invalid, ["https://medium.com/@someone"]);
});

test("export writes one URL per line; requeue skips history and duplicates", () => {
  const { dir, options } = setup();
  const exported = exportScrapedUrlList(options);
  assert.equal(readFileSync(exported.file, "utf8"), `${B}\n`);

  const list = path.join(dir, "list.txt");
  writeFileSync(list, `${A}\n${B}\n`);
  const first = requeueUrlsFromFile({ ...options, requeueFile: list });
  assert.deepEqual({ ...first, alreadyScraped: first.alreadyScraped.length }, { alreadyQueued: 0, alreadyScraped: 1, invalid: [], queued: 1 });
  const again = requeueUrlsFromFile({ ...options, requeueFile: list });
  assert.equal(again.queued, 0);
  assert.equal(again.alreadyQueued, 1);

  const db = openLibraryDatabase(options.libraryDbFile);
  assert.deepEqual(getAllQueuedUrlRecords(db).map((row) => [row.sourceUrl, row.driveFileId, row.driveFileName]), [[A, "requeue", "list.txt"]]);
  db.close();
});

test("snapshotLibrary saves a restorable copy", () => {
  const { options } = setup();
  const file = snapshotLibrary(options, "reset");
  assert.match(path.basename(file), /^library-before-reset-.*\.db$/u);
  const copy = openLibraryDatabase(file);
  assert.equal((copy.prepare("SELECT COUNT(*) AS c FROM scraped_urls").get() as { c: number; }).c, 1);
  copy.close();
});
