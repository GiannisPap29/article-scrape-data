// Command implementations: ingest, scrape queue, rescan, run, status, backup.

import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createSQLiteBackup, deleteQueuedUrlRecord, getAllQueuedUrlRecords, getAllScrapedUrlRecords, getQueuedUrlRecord, getScrapedUrlRecord, insertQueuedUrlRecord, openLibraryDatabase, promoteQueuedUrl, recordQueuedUrlFailure, upsertScrapedUrlRecord } from "./db.js";
import { type DatabaseSync } from "node:sqlite";
import { getDriveFileText, listSupportedDriveFilesInFolder, moveDriveFileToFolder, resolveArchiveFolderId, resolveFailureFolderId, resolveInboxSubfolderId, uploadDriveBackupFile } from "./drive.js";
import { ArticleNotFoundError, createBrowserSession } from "./freedium.js";
import { formatErrorWithCause, logError, logInfo, logWarn } from "./log.js";
import { getGoogleAccessSession } from "./oauth.js";
import { scrapeAndWriteUrl } from "./output.js";
import { type CliOptions, type DriveBackupOptions, type DriveIngestSummary, type DriveWorkerOptions, type GoogleOAuthToken, type PersistedDocumentMetadata, type QueueScrapeSummary, type RunSummary, type ScrapeOptions, type ScrapedUrlRecord } from "./types.js";
import { assertArticleUrl, createSingleArticle, extractSingleArticleUrlFromText } from "./urls.js";

export const QUEUE_RETRY_BASE_MS = 15 * 60 * 1000;

export const QUEUE_RETRY_MAX_MS = 12 * 60 * 60 * 1000;

export async function ingestDriveQueue(options: DriveWorkerOptions): Promise<DriveIngestSummary> {
  const oauthClientFile = path.resolve(process.cwd(), options.oauthClientFile);
  const oauthTokenFile = path.resolve(process.cwd(), options.oauthTokenFile);

  logInfo(`Drive ingest start: folderId=${options.driveFolderId}`);
  const session = await getGoogleAccessSession(oauthClientFile, oauthTokenFile);
  const archiveFolderId = await resolveArchiveFolderId(session, options.driveFolderId, options.driveArchiveFolderId);
  const failureFolderId = await resolveFailureFolderId(session, options.driveFolderId, options.driveFailedFolderId);
  const db = openLibrary(options);

  try {
    if (archiveFolderId === options.driveFolderId || failureFolderId === options.driveFolderId) {
      throw new Error("Drive archive/failure folders must be different from DRIVE_FOLDER_ID.");
    }

    if (archiveFolderId === failureFolderId) {
      throw new Error("Drive archive folder must be different from the failure folder.");
    }

    const files = await listSupportedDriveFilesInFolder(session, options.driveFolderId);
    if (files.length === 0) {
      logInfo("Drive ingest found no supported files to process.");
      return {
        archived: 0,
        failed: 0,
        movedToFailure: 0,
        queued: 0,
        skippedExisting: 0,
        skippedQueued: 0,
        totalFiles: 0
      };
    }

    logInfo(`Drive ingest found ${files.length} supported file(s).`);
    const summary: DriveIngestSummary = {
      archived: 0,
      failed: 0,
      movedToFailure: 0,
      queued: 0,
      skippedExisting: 0,
      skippedQueued: 0,
      totalFiles: files.length
    };

    for (const file of files) {
      logInfo(`Drive ingest file start: ${file.name} (${file.id}) mimeType=${file.mimeType ?? "unknown"}`);

      try {
        const text = await getDriveFileText(session, file);
        const sourceUrl = extractSingleArticleUrlFromText(text);
        logInfo(`Drive ingest URL extracted: ${file.name} (${file.id}) -> ${sourceUrl}`);

        // Drive ingest only stages work. Already-known files are archived, and
        // new URLs go into the retryable queue for scrape-queue to promote.
        if (getScrapedUrlRecord(db, sourceUrl)) {
          await moveDriveFileToFolder(session, file.id, archiveFolderId);
          summary.archived += 1;
          summary.skippedExisting += 1;
          logInfo(`Drive file archived after scraped DB match: ${file.name} (${file.id})`);
          continue;
        }

        if (getQueuedUrlRecord(db, sourceUrl)) {
          await moveDriveFileToFolder(session, file.id, archiveFolderId);
          summary.archived += 1;
          summary.skippedQueued += 1;
          logInfo(`Drive file archived after queue DB match: ${file.name} (${file.id})`);
          continue;
        }

        insertQueuedUrlRecord(db, {
          attempts: 0,
          driveFileId: file.id,
          driveFileName: file.name,
          lastError: null,
          nextRetryAt: null,
          queuedAt: new Date().toISOString(),
          sourceUrl
        });
        logInfo(`Queue inserted: ${sourceUrl} from ${file.name} (${file.id})`);

        await moveDriveFileToFolder(session, file.id, archiveFolderId);
        summary.archived += 1;
        summary.queued += 1;
        logInfo(`Drive file archived after queue insert: ${file.name} (${file.id})`);
      } catch (error) {
        summary.failed += 1;
        try {
          await moveDriveFileToFolder(session, file.id, failureFolderId);
          summary.movedToFailure += 1;
          logWarn(`Drive file moved to failure folder: ${file.name} (${file.id})`);
        } catch (moveError) {
          logError(`Failed to move Drive file to failure folder: ${file.name} (${file.id}): ${moveError instanceof Error ? moveError.message : String(moveError)}`);
        }

        logError(`Drive ingest failed: ${file.name} (${file.id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return summary;
  } finally {
    db.close();
  }
}

export async function backupTrackingDatabaseToDrive(options: DriveBackupOptions): Promise<string> {
  const oauthClientFile = path.resolve(process.cwd(), options.oauthClientFile);
  const oauthTokenFile = path.resolve(process.cwd(), options.oauthTokenFile);
  const session = await getGoogleAccessSession(oauthClientFile, oauthTokenFile);
  const backupFolderId = await resolveBackupFolderId(session, options);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "web-scrapper-backup-"));
  const tempBackupPath = path.join(tempDir, options.driveBackupFileName);

  try {
    const db = openLibrary(options);
    try {
      createSQLiteBackup(db, tempBackupPath);
    } finally {
      db.close();
    }
    return await uploadDriveBackupFile(session, backupFolderId, options.driveBackupFileName, tempBackupPath);
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function resolveBackupFolderId(session: GoogleOAuthToken, options: DriveBackupOptions): Promise<string> {
  // Backups must not land in the inbox itself: keep them in <INBOX>_BACKUPS
  // inside the inbox when no separate backup folder is configured.
  if (options.driveBackupFolderId && options.driveBackupFolderId !== options.driveFolderId) {
    return options.driveBackupFolderId;
  }

  if (!options.driveFolderId) {
    throw new Error("Missing DRIVE_BACKUP_FOLDER_ID or DRIVE_FOLDER_ID for Drive backup.");
  }

  if (options.driveBackupFolderId === options.driveFolderId) {
    logWarn("DRIVE_BACKUP_FOLDER_ID is the inbox folder; using the inbox _BACKUPS subfolder instead.");
  }

  return resolveInboxSubfolderId(session, options.driveFolderId, null, "BACKUPS");
}

export async function runPipeline(options: CliOptions): Promise<RunSummary> {
  // One command for the whole flow. Each stage keeps its own durability rules:
  // ingest only stages URLs, scrape-queue only promotes after files are written.
  let ingest: DriveIngestSummary | null = null;
  try {
    ingest = await ingestDriveQueue(resolveDriveWorkerOptions(options));
  } catch (error) {
    // Drive being unreachable should not block scraping URLs already queued.
    logError(`Run: Drive ingest failed, continuing with the existing queue: ${formatErrorWithCause(error)}`);
  }

  const scrape = await scrapeQueuedUrls(options);
  exportScrapedUrlList(options);

  let backupFailed = false;
  if (scrape.saved > 0 || (ingest?.totalFiles ?? 0) > 0) {
    try {
      const backupFileId = await backupTrackingDatabaseToDrive(options);
      logInfo(`Run: Drive backup updated fileId=${backupFileId}`);
    } catch (error) {
      backupFailed = true;
      logError(`Run: Drive backup failed: ${formatErrorWithCause(error)}`);
    }
  } else {
    logInfo("Run: nothing new, skipping Drive backup.");
  }

  return { backupFailed, ingest, scrape };
}

export async function scrapeQueuedUrls(options: ScrapeOptions & Pick<CliOptions, "libraryDbFile">): Promise<QueueScrapeSummary> {
  const db = openLibrary(options);
  const summary: QueueScrapeSummary = {
    deferred: 0,
    failed: 0,
    gaveUp: 0,
    removedAlreadyScraped: 0,
    saved: 0,
    totalQueued: 0
  };

  try {
    const records = getAllQueuedUrlRecords(db);
    summary.totalQueued = records.length;
    if (records.length === 0) {
      logInfo("Queue scrape found no queued URLs.");
      return summary;
    }

    // Rows that failed too often are kept (for make status / retry-failed) but
    // skipped; rows still inside their backoff window wait for a later run.
    const nowIso = new Date().toISOString();
    const due = records.filter((record) => {
      if (record.attempts >= options.maxScrapeAttempts) {
        summary.gaveUp += 1;
        return false;
      }
      if (record.nextRetryAt && record.nextRetryAt > nowIso) {
        summary.deferred += 1;
        return false;
      }
      return true;
    });

    logInfo(`Queue scrape: ${records.length} queued, ${due.length} due now, ${summary.deferred} waiting for retry backoff, ${summary.gaveUp} gave up after ${options.maxScrapeAttempts} attempts.`);
    if (due.length === 0) {
      return summary;
    }

    const session = createBrowserSession(options);
    let scrapedSinceLastPause = false;

    try {
      for (const [index, record] of due.entries()) {
        try {
          logInfo(`Queue scrape start (${index + 1}/${due.length}, attempt ${record.attempts + 1}): ${record.sourceUrl}`);
          if (getScrapedUrlRecord(db, record.sourceUrl)) {
            deleteQueuedUrlRecord(db, record.sourceUrl);
            summary.removedAlreadyScraped += 1;
            logInfo(`Queue row removed because URL already exists in scraped DB: ${record.sourceUrl}`);
            continue;
          }

          if (scrapedSinceLastPause) {
            await politePause(options.scrapeDelayMs);
          }
          scrapedSinceLastPause = true;

          const result = await scrapeAndWriteUrl(record.sourceUrl, options, session, null);
          promoteQueuedUrl(db, toScrapedUrlRecord(result));
          summary.saved += 1;
          logInfo(`Queue scrape saved: ${result.sourceUrl} -> ${result.outputPath}`);
        } catch (error) {
          summary.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          // A Freedium 404 is permanent: mark it gave-up now instead of five retries.
          const attempts = error instanceof ArticleNotFoundError ? options.maxScrapeAttempts : record.attempts + 1;
          const nextRetryAt = attempts >= options.maxScrapeAttempts ? null : computeNextRetryAt(attempts);
          recordQueuedUrlFailure(db, record.sourceUrl, message, attempts, nextRetryAt);
          logError(`Queue scrape failed (attempt ${attempts}/${options.maxScrapeAttempts}${nextRetryAt ? `, next try after ${nextRetryAt}` : ", giving up"}): ${record.sourceUrl}: ${message}`);
        }
      }
    } finally {
      await session.close();
    }

    return summary;
  } finally {
    db.close();
  }
}

// Backoff for failed queue rows: 15 min, 30 min, 1 h, 2 h, ... capped at 12 h.
export function computeNextRetryAt(attempts: number): string {
  const delayMs = Math.min(QUEUE_RETRY_BASE_MS * 2 ** (attempts - 1), QUEUE_RETRY_MAX_MS);
  return new Date(Date.now() + delayMs).toISOString();
}

export async function politePause([minMs, maxMs]: [number, number]): Promise<void> {
  const waitMs = Math.round(minMs + Math.random() * (maxMs - minMs));
  if (waitMs > 0) {
    logInfo(`Pausing ${Math.round(waitMs / 100) / 10}s before the next Freedium request.`);
    await delay(waitMs);
  }
}

export function toScrapedUrlRecord(result: PersistedDocumentMetadata): ScrapedUrlRecord {
  return {
    author: result.author,
    contentHash: result.contentHash,
    docId: result.docId,
    excerpt: result.excerpt,
    freediumUrl: result.freedium.url,
    language: result.language,
    metadataPath: result.metadataPath,
    outputPath: result.outputPath,
    publishedAt: result.publishedAt,
    scrapedAt: result.scrapedAt,
    siteName: result.siteName,
    sourceUrl: result.sourceUrl,
    tagsJson: JSON.stringify(result.tags),
    title: result.title
  };
}

export async function rescrapeTrackedUrls(
  options: ScrapeOptions & Pick<CliOptions, "libraryDbFile">
): Promise<{ failed: number; rescraped: number; saved: number; total: number; }> {
  const db = openLibrary(options);

  try {
    const records = getAllScrapedUrlRecords(db);
    if (records.length === 0) {
      logInfo("DB rescan found no tracked URLs.");
      return {
        failed: 0,
        rescraped: 0,
        saved: 0,
        total: 0
      };
    }

    logInfo(`DB rescan queued ${records.length} tracked URL(s).`);
    let failed = 0;
    let rescraped = 0;
    const session = createBrowserSession(options);

    try {
      for (const [index, record] of records.entries()) {
        try {
          if (index > 0) {
            await politePause(options.scrapeDelayMs);
          }
          logInfo(`DB rescan start (${index + 1}/${records.length}): ${record.sourceUrl}`);
          const result = await scrapeAndWriteUrl(record.sourceUrl, options, session, record.outputPath);
          upsertScrapedUrlRecord(db, toScrapedUrlRecord(result));
          rescraped += 1;
          logInfo(`DB rescan updated: ${result.sourceUrl} -> ${result.outputPath}`);
        } catch (error) {
          failed += 1;
          logError(`DB rescan failed: ${record.sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await session.close();
    }

    return {
      failed,
      rescraped,
      saved: rescraped,
      total: records.length
    };
  } finally {
    db.close();
  }
}


export function showStatus(options: Pick<CliOptions, "debugDir" | "libraryDbFile" | "manifestFile" | "maxScrapeAttempts" | "outputDir">): void {
  const outputDir = path.resolve(process.cwd(), options.outputDir);
  const manifestFile = path.resolve(process.cwd(), options.manifestFile);
  const db = openLibrary(options);

  try {
    const scrapedCount = getAllScrapedUrlRecords(db).length;
    const queuedRows = getAllQueuedUrlRecords(db);
    const failedRows = queuedRows.filter((row) => row.lastError);
    const gaveUpRows = queuedRows.filter((row) => row.attempts >= options.maxScrapeAttempts);
    const nowIso = new Date().toISOString();
    const waitingRows = queuedRows.filter((row) => row.attempts < options.maxScrapeAttempts && row.nextRetryAt && row.nextRetryAt > nowIso);
    const outputFiles = existsSync(outputDir) ? readdirSync(outputDir) : [];
    const countExt = (ext: string) => outputFiles.filter((name) => name.endsWith(ext)).length;

    let ragLine = "not synced yet (run make rag-sync)";
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        documents?: Record<string, { auto_tags?: string[]; status?: string; tags?: string[]; vector_store?: string; }>;
      };
      const docs = Object.values(manifest.documents ?? {}).filter((doc) => doc.status !== "removed");
      // Only documents in the current sqlite-vec index count; older records may
      // still say "indexed" from the retired Chroma store.
      const indexed = docs.filter((doc) => doc.status === "indexed" && doc.vector_store === "sqlite-vec").length;
      const untagged = docs.filter((doc) => !(doc.tags?.length) && !(doc.auto_tags?.length)).length;
      ragLine = `${indexed} indexed / ${docs.length} synced (${docs.length - indexed} to index, ${untagged} without tags)`;
    }

    console.log(`Library DB:          ${path.resolve(process.cwd(), options.libraryDbFile)}`);
    console.log(`Scraped (DB):        ${scrapedCount}`);
    console.log(`Articles on disk:    ${countExt(".txt")} txt / ${countExt(".json")} json`);
    const debugDir = path.resolve(process.cwd(), options.debugDir);
    const debugFiles = existsSync(debugDir) ? readdirSync(debugDir).length : 0;
    const strayDebugFiles = countExt(".html") + countExt(".png");
    console.log(`Debug captures:      ${debugFiles} in ${debugDir}${strayDebugFiles ? ` (+${strayDebugFiles} old ones still in data/output)` : ""}`);
    console.log(`Queue:               ${queuedRows.length} queued (${failedRows.length} with errors, ${waitingRows.length} in retry backoff, ${gaveUpRows.length} gave up)`);
    console.log(`RAG:                 ${ragLine}`);

    for (const row of failedRows.slice(0, 10)) {
      const state = row.attempts >= options.maxScrapeAttempts ? "gave up" : row.nextRetryAt ? `retry after ${row.nextRetryAt}` : "due";
      console.log(`  ! ${row.sourceUrl} [attempts ${row.attempts}, ${state}]\n      ${(row.lastError ?? "").split("\n")[0].slice(0, 160)}`);
    }
    if (gaveUpRows.length > 0) {
      console.log("  Run make retry-failed to give gave-up URLs another chance.");
    }
  } finally {
    db.close();
  }
}

export function resolveDriveWorkerOptions(options: CliOptions): DriveWorkerOptions {
  if (!options.driveFolderId) {
    throw new Error("Missing DRIVE_FOLDER_ID or --driveFolderId for Drive commands.");
  }

  return {
    browser: options.browser,
    connectUrl: options.connectUrl,
    driveArchiveFolderId: options.driveArchiveFolderId,
    driveFailedFolderId: options.driveFailedFolderId,
    driveFolderId: options.driveFolderId,
    headless: options.headless,
    libraryDbFile: options.libraryDbFile,
    oauthClientFile: options.oauthClientFile,
    oauthTokenFile: options.oauthTokenFile,
    outputDir: options.outputDir
  };
}

export function openLibrary(options: Pick<CliOptions, "libraryDbFile">): DatabaseSync {
  return openLibraryDatabase(path.resolve(process.cwd(), options.libraryDbFile));
}

// ---------------------------------------------------------------------------
// Safety net for the scraped URL list (the list you rescrape from after a loss).

export function scrapedUrlListPath(options: Pick<CliOptions, "backupsDir">): string {
  return path.resolve(process.cwd(), options.backupsDir, "scraped-urls.txt");
}

// Plain text, one URL per line: readable, grep-able, and usable even if every
// database file is lost. Rewritten atomically after each run.
export function exportScrapedUrlList(options: Pick<CliOptions, "backupsDir" | "libraryDbFile">): { count: number; file: string; } {
  const file = scrapedUrlListPath(options);
  const db = openLibrary(options);
  try {
    const urls = getAllScrapedUrlRecords(db).map((record) => record.sourceUrl).sort();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, urls.length > 0 ? `${urls.join("\n")}\n` : "", "utf8");
    renameSync(temp, file);
    logInfo(`Scraped URL list written: ${file} (${urls.length} URLs)`);
    return { count: urls.length, file };
  } finally {
    db.close();
  }
}

// Every distinct Medium article URL in a text: one per line, a Drive export,
// or a pasted list all work. Lines starting with "#" are comments.
export function parseUrlList(text: string): { invalid: string[]; urls: string[]; } {
  const urls = new Set<string>();
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().startsWith("#")) {
      continue;
    }
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'()]+/gu)) {
      const candidate = match[0].replace(/[.,;:!?]+$/u, "");
      try {
        const { sourceUrl } = createSingleArticle(candidate);
        assertArticleUrl(sourceUrl);
        urls.add(sourceUrl);
      } catch {
        invalid.push(candidate);
      }
    }
  }
  return { invalid, urls: [...urls] };
}

export type RequeueSummary = { alreadyQueued: number; alreadyScraped: string[]; invalid: string[]; queued: number; };

// Put URLs from a file back into the queue so the next `make run` scrapes them.
// URLs still in the scraped history are not queued (scrape-queue would skip
// them); those are re-scraped with `make rescan`.
export function requeueUrlsFromFile(options: Pick<CliOptions, "libraryDbFile" | "requeueFile">): RequeueSummary {
  if (!options.requeueFile) {
    throw new Error("Missing file. Usage: make requeue-urls FILE=data/backups/scraped-urls.txt");
  }
  const file = path.resolve(process.cwd(), options.requeueFile);
  const { invalid, urls } = parseUrlList(readFileSync(file, "utf8"));
  const summary: RequeueSummary = { alreadyQueued: 0, alreadyScraped: [], invalid, queued: 0 };
  const db = openLibrary(options);
  try {
    const queuedAt = new Date().toISOString();
    for (const sourceUrl of urls) {
      if (getScrapedUrlRecord(db, sourceUrl)) {
        summary.alreadyScraped.push(sourceUrl);
        continue;
      }
      if (getQueuedUrlRecord(db, sourceUrl)) {
        summary.alreadyQueued += 1;
        continue;
      }
      insertQueuedUrlRecord(db, {
        attempts: 0,
        driveFileId: "requeue",
        driveFileName: path.basename(file),
        lastError: null,
        nextRetryAt: null,
        queuedAt,
        sourceUrl
      });
      summary.queued += 1;
    }
  } finally {
    db.close();
  }
  return summary;
}

// Copy of library.db taken before anything destructive (make reset-db).
export function snapshotLibrary(options: Pick<CliOptions, "backupsDir" | "libraryDbFile">, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const file = path.resolve(process.cwd(), options.backupsDir, `library-before-${reason}-${stamp}.db`);
  const db = openLibrary(options);
  try {
    createSQLiteBackup(db, file);
  } finally {
    db.close();
  }
  return file;
}
