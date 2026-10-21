// SQLite access: data/library.db with the scraped-history and queue tables.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type QueueUrlRecord, type ScrapedUrlRecord } from "./types.js";

// One SQLite file (data/library.db) holds both tables, so promoting a URL from
// the queue into the history is a single transaction.
export function openLibraryDatabase(libraryDbFile: string): DatabaseSync {
  mkdirSyncLike(path.dirname(libraryDbFile));
  const db = new DatabaseSync(libraryDbFile);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  // Retryable staging queue: rows stay until the article's .txt/.json are
  // written and the URL is promoted to scraped_urls.
  db.exec(`
    CREATE TABLE IF NOT EXISTS url_from_drive (
      source_url TEXT PRIMARY KEY,
      drive_file_id TEXT NOT NULL,
      drive_file_name TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      last_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_url_from_drive_queued_at ON url_from_drive(queued_at);
  `);
  // Final success history: a row means the article's files were saved.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraped_urls (
      source_url TEXT PRIMARY KEY,
      output_path TEXT NOT NULL,
      scraped_at TEXT NOT NULL,
      doc_id TEXT,
      title TEXT,
      author TEXT,
      site_name TEXT,
      excerpt TEXT,
      freedium_url TEXT,
      metadata_path TEXT,
      content_hash TEXT,
      published_at TEXT,
      language TEXT,
      tags_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scraped_urls_scraped_at ON scraped_urls(scraped_at);
  `);
  return db;
}

// Queue -> history promotion: both writes commit together or not at all.
export function promoteQueuedUrl(db: DatabaseSync, record: ScrapedUrlRecord): void {
  db.exec("BEGIN");
  try {
    upsertScrapedUrlRecord(db, record);
    deleteQueuedUrlRecord(db, record.sourceUrl);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function mkdirSyncLike(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function getScrapedUrlRecord(db: DatabaseSync, sourceUrl: string): ScrapedUrlRecord | null {
  const row = db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        output_path AS outputPath,
        scraped_at AS scrapedAt,
        doc_id AS docId,
        title AS title,
        author AS author,
        site_name AS siteName,
        excerpt AS excerpt,
        freedium_url AS freediumUrl,
        metadata_path AS metadataPath,
        content_hash AS contentHash,
        published_at AS publishedAt,
        language AS language,
        tags_json AS tagsJson
      FROM scraped_urls
      WHERE source_url = ?
    `)
    .get(sourceUrl) as ScrapedUrlRecord | undefined;

  return row ?? null;
}

export function getAllScrapedUrlRecords(db: DatabaseSync): ScrapedUrlRecord[] {
  return db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        output_path AS outputPath,
        scraped_at AS scrapedAt,
        doc_id AS docId,
        title AS title,
        author AS author,
        site_name AS siteName,
        excerpt AS excerpt,
        freedium_url AS freediumUrl,
        metadata_path AS metadataPath,
        content_hash AS contentHash,
        published_at AS publishedAt,
        language AS language,
        tags_json AS tagsJson
      FROM scraped_urls
      ORDER BY scraped_at ASC, source_url ASC
    `)
    .all() as ScrapedUrlRecord[];
}

export function getQueuedUrlRecord(db: DatabaseSync, sourceUrl: string): QueueUrlRecord | null {
  const row = db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        drive_file_id AS driveFileId,
        drive_file_name AS driveFileName,
        queued_at AS queuedAt,
        last_error AS lastError,
        attempts AS attempts,
        next_retry_at AS nextRetryAt
      FROM url_from_drive
      WHERE source_url = ?
    `)
    .get(sourceUrl) as QueueUrlRecord | undefined;

  return row ?? null;
}

export function getAllQueuedUrlRecords(db: DatabaseSync): QueueUrlRecord[] {
  return db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        drive_file_id AS driveFileId,
        drive_file_name AS driveFileName,
        queued_at AS queuedAt,
        last_error AS lastError,
        attempts AS attempts,
        next_retry_at AS nextRetryAt
      FROM url_from_drive
      ORDER BY queued_at ASC, source_url ASC
    `)
    .all() as QueueUrlRecord[];
}

export function insertQueuedUrlRecord(db: DatabaseSync, record: QueueUrlRecord): void {
  db
    .prepare(`
      INSERT INTO url_from_drive (source_url, drive_file_id, drive_file_name, queued_at, last_error, attempts, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        drive_file_id = excluded.drive_file_id,
        drive_file_name = excluded.drive_file_name,
        queued_at = excluded.queued_at,
        last_error = excluded.last_error,
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at
    `)
    .run(record.sourceUrl, record.driveFileId, record.driveFileName, record.queuedAt, record.lastError, record.attempts, record.nextRetryAt);
}

export function deleteQueuedUrlRecord(db: DatabaseSync, sourceUrl: string): void {
  db.prepare("DELETE FROM url_from_drive WHERE source_url = ?").run(sourceUrl);
}

export function recordQueuedUrlFailure(
  db: DatabaseSync,
  sourceUrl: string,
  lastError: string,
  attempts: number,
  nextRetryAt: string | null
): void {
  db
    .prepare("UPDATE url_from_drive SET last_error = ?, attempts = ?, next_retry_at = ? WHERE source_url = ?")
    .run(lastError, attempts, nextRetryAt, sourceUrl);
}

export function resetQueuedUrlFailures(db: DatabaseSync): number {
  const result = db
    .prepare("UPDATE url_from_drive SET attempts = 0, next_retry_at = NULL WHERE attempts > 0 OR next_retry_at IS NOT NULL")
    .run();
  return Number(result.changes);
}

export function upsertScrapedUrlRecord(db: DatabaseSync, record: ScrapedUrlRecord): void {
  db
    .prepare(`
      INSERT INTO scraped_urls (
        source_url,
        output_path,
        scraped_at,
        doc_id,
        title,
        author,
        site_name,
        excerpt,
        freedium_url,
        metadata_path,
        content_hash,
        published_at,
        language,
        tags_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        output_path = excluded.output_path,
        scraped_at = excluded.scraped_at,
        doc_id = excluded.doc_id,
        title = excluded.title,
        author = excluded.author,
        site_name = excluded.site_name,
        excerpt = excluded.excerpt,
        freedium_url = excluded.freedium_url,
        metadata_path = excluded.metadata_path,
        content_hash = excluded.content_hash,
        published_at = excluded.published_at,
        language = excluded.language,
        tags_json = excluded.tags_json
    `)
    .run(
      record.sourceUrl,
      record.outputPath,
      record.scrapedAt,
      record.docId,
      record.title,
      record.author,
      record.siteName,
      record.excerpt,
      record.freediumUrl,
      record.metadataPath,
      record.contentHash,
      record.publishedAt,
      record.language,
      record.tagsJson
    );
}

export function resetTrackingDatabase(db: DatabaseSync): void {
  db.exec("DELETE FROM scraped_urls;");
}


export function createSQLiteBackup(db: DatabaseSync, backupDbFile: string): void {
  // VACUUM INTO writes a consistent, compacted copy even while WAL is active.
  mkdirSyncLike(path.dirname(backupDbFile));
  db.prepare("VACUUM INTO ?").run(backupDbFile);
}
