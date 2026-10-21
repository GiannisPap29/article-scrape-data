import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getAllQueuedUrlRecords,
  getScrapedUrlRecord,
  insertQueuedUrlRecord,
  openLibraryDatabase,
  promoteQueuedUrl
} from "../scraper/db.js";
import { type ScrapedUrlRecord } from "../scraper/types.js";

const QUEUED = {
  attempts: 0,
  driveFileId: "f1",
  driveFileName: "link.txt",
  lastError: null,
  nextRetryAt: null,
  queuedAt: "2026-10-18T00:00:00.000Z",
  sourceUrl: "https://medium.com/@a/post-0123456789ab"
};

function scrapedRecord(overrides: Partial<ScrapedUrlRecord> = {}): ScrapedUrlRecord {
  return {
    author: "Ada", contentHash: "h", docId: "doc_1", excerpt: null, freediumUrl: null, language: "en",
    metadataPath: "/x.json", outputPath: "/x.txt", publishedAt: null, scrapedAt: "2026-10-18T00:00:00.000Z",
    siteName: "Medium", sourceUrl: QUEUED.sourceUrl, tagsJson: "[]", title: "T", ...overrides
  };
}

test("promoteQueuedUrl moves a row atomically", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "library-db-"));
  const db = openLibraryDatabase(path.join(dir, "library.db"));
  insertQueuedUrlRecord(db, QUEUED);

  // A failing history write (NOT NULL output_path) must leave the queue intact.
  assert.throws(() => promoteQueuedUrl(db, scrapedRecord({ outputPath: null as unknown as string })));
  assert.equal(getAllQueuedUrlRecords(db).length, 1);
  assert.equal(getScrapedUrlRecord(db, QUEUED.sourceUrl), null);

  promoteQueuedUrl(db, scrapedRecord());
  assert.equal(getAllQueuedUrlRecords(db).length, 0);
  assert.equal(getScrapedUrlRecord(db, QUEUED.sourceUrl)?.title, "T");
  db.close();
});
