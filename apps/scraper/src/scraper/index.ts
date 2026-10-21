// CLI entry point: parse options, dispatch to the command implementation.

import path from "node:path";
import process from "node:process";
import { parseCliArgs } from "./cli-options.js";
import { resetQueuedUrlFailures, resetTrackingDatabase } from "./db.js";
import { logError, logInfo, logWarn } from "./log.js";
import { backupTrackingDatabaseToDrive, exportScrapedUrlList, ingestDriveQueue, openLibrary, requeueUrlsFromFile, rescrapeTrackedUrls, resolveDriveWorkerOptions, runPipeline, scrapeQueuedUrls, showStatus, snapshotLibrary } from "./pipeline.js";

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  logInfo(`Starting command=${options.command} browser=${options.browser} headless=${options.headless} outputDir=${options.outputDir} libraryDbFile=${options.libraryDbFile}`);

  if (options.command === "reset") {
    // Never wipe the URL history without a way back.
    const snapshot = snapshotLibrary(options, "reset");
    logInfo(`Snapshot before reset: ${snapshot}`);
    exportScrapedUrlList(options);
    const db = openLibrary(options);
    try {
      resetTrackingDatabase(db);
    } finally {
      db.close();
    }
    logInfo(`Reset scraped history in: ${path.resolve(process.cwd(), options.libraryDbFile)}`);
    return;
  }

  if (options.command === "rescan-db") {
    const summary = await rescrapeTrackedUrls(options);
    logInfo(`DB rescan finished: total=${summary.total} saved=${summary.saved} rescraped=${summary.rescraped} failed=${summary.failed}`);
    return;
  }

  if (options.command === "ingest-drive") {
    const summary = await ingestDriveQueue(resolveDriveWorkerOptions(options));
    logInfo(`Drive ingest finished: totalFiles=${summary.totalFiles} queued=${summary.queued} skippedExisting=${summary.skippedExisting} skippedQueued=${summary.skippedQueued} archived=${summary.archived} movedToFailure=${summary.movedToFailure} failed=${summary.failed}`);
    return;
  }

  if (options.command === "backup-db") {
    const backupFileId = await backupTrackingDatabaseToDrive(options);
    logInfo(`Drive backup finished: fileId=${backupFileId} fileName=${options.driveBackupFileName}`);
    return;
  }

  if (options.command === "scrape-queue") {
    const summary = await scrapeQueuedUrls(options);
    logInfo(`Queue scrape finished: totalQueued=${summary.totalQueued} saved=${summary.saved} removedAlreadyScraped=${summary.removedAlreadyScraped} failed=${summary.failed} waitingForRetry=${summary.deferred} gaveUp=${summary.gaveUp}`);
    return;
  }

  if (options.command === "run") {
    const summary = await runPipeline(options);
    const ingest = summary.ingest;
    logInfo(
      "Run finished: " +
      (ingest
        ? `driveFiles=${ingest.totalFiles} queued=${ingest.queued} alreadyKnown=${ingest.skippedExisting + ingest.skippedQueued} driveFailed=${ingest.movedToFailure} `
        : "driveIngest=FAILED ") +
      `scraped=${summary.scrape.saved} scrapeFailed=${summary.scrape.failed} (kept in queue) waitingForRetry=${summary.scrape.deferred} gaveUp=${summary.scrape.gaveUp} ` +
      `backup=${summary.backupFailed ? "FAILED" : "ok"}`
    );

    // Exit 2 means "finished, but something needs a look": failed scrapes stay
    // queued for the next run, and the Makefile still runs the RAG steps.
    const needsAttention = !ingest || ingest.failed > 0 || summary.scrape.failed > 0 || summary.backupFailed;
    if (needsAttention) {
      process.exitCode = 2;
    }
    return;
  }

  if (options.command === "status") {
    showStatus(options);
    return;
  }

  if (options.command === "export-urls") {
    exportScrapedUrlList(options);
    return;
  }

  if (options.command === "requeue-urls") {
    const summary = requeueUrlsFromFile(options);
    logInfo(`Requeue: queued=${summary.queued} alreadyQueued=${summary.alreadyQueued} alreadyScraped=${summary.alreadyScraped.length} invalid=${summary.invalid.length}`);
    if (summary.alreadyScraped.length > 0) {
      logInfo(`${summary.alreadyScraped.length} URL(s) are still in the scraped history and were not queued; use \`make rescan\` to re-scrape those.`);
    }
    for (const url of summary.invalid.slice(0, 10)) {
      logWarn(`Not a Medium article URL, skipped: ${url}`);
    }
    return;
  }

  if (options.command === "retry-failed") {
    const queueDb = openLibrary(options);
    try {
      const reset = resetQueuedUrlFailures(queueDb);
      logInfo(`Retry reset: ${reset} queued URL(s) will be tried on the next run.`);
    } finally {
      queueDb.close();
    }
    return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  logError(message);
  process.exitCode = 1;
});
