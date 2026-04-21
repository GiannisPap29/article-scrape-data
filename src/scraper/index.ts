import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium, firefox, webkit, type BrowserContext, type Page } from "@playwright/test";
import {
  DEFAULT_DB_FILE,
  DEFAULT_GOOGLE_OAUTH_CLIENT_FILE,
  DEFAULT_GOOGLE_OAUTH_TOKEN_FILE,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_URL_QUEUE_DB_FILE,
  GOOGLE_DRIVE_SCOPE,
  TARGET_URL
} from "../config/index.js";

type BrowserName = "chrome" | "msedge" | "firefox" | "webkit";
type Command = "ingest-drive" | "rescan-db" | "reset" | "scrape-queue" | "show-db";

type CliOptions = {
  browser: BrowserName;
  command: Command;
  connectUrl: string | null;
  dbFile: string;
  driveArchiveFolderId: string | null;
  driveFailedFolderId: string | null;
  driveFolderId: string | null;
  headless: boolean;
  oauthClientFile: string;
  oauthTokenFile: string;
  outputDir: string;
  queueDbFile: string;
};

type DriveWorkerOptions = {
  dbFile: string;
  driveArchiveFolderId: string | null;
  driveFailedFolderId: string | null;
  driveFolderId: string;
  oauthClientFile: string;
  oauthTokenFile: string;
  outputDir: string;
  queueDbFile: string;
} & Pick<CliOptions, "browser" | "connectUrl" | "headless">;

type Article = {
  title: string;
  sourceUrl: string;
};

type DriveDocumentFile = {
  id: string;
  mimeType?: string;
  modifiedTime: string;
  name: string;
  parents?: string[];
  webViewLink?: string;
};

type DriveFileParentsResponse = {
  id: string;
  name?: string;
  parents?: string[];
};

type DriveListResponse = {
  files?: DriveDocumentFile[];
  nextPageToken?: string;
};

type DriveIngestSummary = {
  archived: number;
  failed: number;
  movedToFailure: number;
  skippedExisting: number;
  skippedQueued: number;
  queued: number;
  totalFiles: number;
};

type ExtractionResult = {
  article: Article;
  content: string;
  footerContent: string | null;
};

type GoogleDocument = {
  body?: {
    content?: StructuralElement[];
  };
  title?: string;
};

type GoogleOAuthClient = {
  authUri: string;
  clientId: string;
  clientSecret?: string;
  tokenUri: string;
};

type GoogleOAuthToken = {
  accessToken: string;
  expiryDateMs?: number;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
};

type OAuthCallbackResult = {
  code: string;
  redirectUri: string;
};

type ScrapedUrlRecord = {
  outputPath: string;
  scrapedAt: string;
  sourceUrl: string;
};

type QueueUrlRecord = {
  driveFileId: string;
  driveFileName: string;
  lastError: string | null;
  queuedAt: string;
  sourceUrl: string;
};

type QueueScrapeSummary = {
  failed: number;
  removedAlreadyScraped: number;
  saved: number;
  totalQueued: number;
};

type StructuralElement = {
  paragraph?: {
    elements?: Array<{
      autoText?: { content?: string; };
      textRun?: { content?: string; };
    }>;
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{
        content?: StructuralElement[];
      }>;
    }>;
  };
  tableOfContents?: {
    content?: StructuralElement[];
  };
};

const GOOGLE_DRIVE_FILE_FIELDS = "files(id,name,mimeType,modifiedTime,parents,webViewLink),nextPageToken";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/csv",
  "text/markdown",
  "text/plain"
]);
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const SECURITY_VERIFICATION_PATTERNS = [
  "performing security verification",
  "verifies you are not a bot",
  "security service to protect against malicious bots",
  "checking if the site connection is secure",
  "please wait while we verify",
  "just a moment"
];

const BLOCKED_MEDIUM_PATH_PREFIXES = new Set([
  "about",
  "jobs",
  "jobs-at-medium",
  "list",
  "lists",
  "m",
  "me",
  "policy",
  "search",
  "tag",
  "topics"
]);

async function main(): Promise<void> {
  loadDotEnv(path.resolve(process.cwd(), ".env"));
  const options = parseCliArgs(process.argv.slice(2));
  logInfo(`Starting command=${options.command} browser=${options.browser} headless=${options.headless} outputDir=${options.outputDir} dbFile=${options.dbFile} queueDbFile=${options.queueDbFile}`);

  if (options.command === "reset") {
    resetTrackingDatabase(path.resolve(process.cwd(), options.dbFile));
    logInfo(`Reset tracking database: ${path.resolve(process.cwd(), options.dbFile)}`);
    return;
  }

  if (options.command === "rescan-db") {
    const summary = await rescrapeTrackedUrls(options);
    logInfo(`DB rescan finished: total=${summary.total} saved=${summary.saved} rescraped=${summary.rescraped} skipped=${summary.skipped} failed=${summary.failed}`);
    return;
  }

  if (options.command === "ingest-drive") {
    const summary = await ingestDriveQueue(resolveDriveWorkerOptions(options));
    logInfo(`Drive ingest finished: totalFiles=${summary.totalFiles} queued=${summary.queued} skippedExisting=${summary.skippedExisting} skippedQueued=${summary.skippedQueued} archived=${summary.archived} movedToFailure=${summary.movedToFailure} failed=${summary.failed}`);
    return;
  }

  if (options.command === "scrape-queue") {
    const summary = await scrapeQueuedUrls(options);
    logInfo(`Queue scrape finished: totalQueued=${summary.totalQueued} saved=${summary.saved} removedAlreadyScraped=${summary.removedAlreadyScraped} failed=${summary.failed}`);
    return;
  }

  if (options.command === "show-db") {
    showDatabases(options);
    return;
  }
}

function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseCliArgs(args: string[]): CliOptions {
  let browser: BrowserName = "chrome";
  let command: Command = "ingest-drive";
  let connectUrl: string | null = readEnv("CONNECT_URL");
  let headless = readEnv("HEADLESS") !== "false";
  let outputDir = readEnv("OUTPUT_DIR") ?? DEFAULT_OUTPUT_DIR;
  let dbFile = readEnv("DB_FILE") ?? DEFAULT_DB_FILE;
  let queueDbFile = readEnv("URL_QUEUE_DB_FILE") ?? DEFAULT_URL_QUEUE_DB_FILE;
  let driveFolderId = readEnv("DRIVE_FOLDER_ID");
  let driveArchiveFolderId = readEnv("DRIVE_ARCHIVE_FOLDER_ID");
  let driveFailedFolderId = readEnv("DRIVE_FAILED_FOLDER_ID");
  let oauthClientFile = readEnv("GOOGLE_OAUTH_CLIENT_FILE") ?? DEFAULT_GOOGLE_OAUTH_CLIENT_FILE;
  let oauthTokenFile = readEnv("GOOGLE_OAUTH_TOKEN_FILE") ?? DEFAULT_GOOGLE_OAUTH_TOKEN_FILE;
  for (const arg of args) {
    if (arg === "--reset") {
      command = "reset";
      continue;
    }

    if (arg === "--rescan-db") {
      command = "rescan-db";
      continue;
    }

    if (arg === "--ingest-drive") {
      command = "ingest-drive";
      continue;
    }

    if (arg === "--scrape-queue") {
      command = "scrape-queue";
      continue;
    }

    if (arg === "--show-db") {
      command = "show-db";
      continue;
    }

    if (arg === "--headless=false") {
      headless = false;
      continue;
    }

    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length).trim();
      if (value !== "chrome" && value !== "msedge" && value !== "firefox" && value !== "webkit") {
        throw new Error(`Invalid --browser value: ${arg}`);
      }
      browser = value;
      continue;
    }

    if (arg.startsWith("--connectUrl=")) {
      connectUrl = requiredFlagValue(arg, "--connectUrl");
      continue;
    }

    if (arg.startsWith("--outputDir=")) {
      outputDir = requiredFlagValue(arg, "--outputDir");
      continue;
    }

    if (arg.startsWith("--dbFile=")) {
      dbFile = requiredFlagValue(arg, "--dbFile");
      continue;
    }

    if (arg.startsWith("--queueDbFile=")) {
      queueDbFile = requiredFlagValue(arg, "--queueDbFile");
      continue;
    }

    if (arg.startsWith("--driveFolderId=")) {
      driveFolderId = requiredFlagValue(arg, "--driveFolderId");
      continue;
    }

    if (arg.startsWith("--driveArchiveFolderId=")) {
      driveArchiveFolderId = requiredFlagValue(arg, "--driveArchiveFolderId");
      continue;
    }

    if (arg.startsWith("--driveFailedFolderId=")) {
      driveFailedFolderId = requiredFlagValue(arg, "--driveFailedFolderId");
      continue;
    }

    if (arg.startsWith("--oauthClientFile=")) {
      oauthClientFile = requiredFlagValue(arg, "--oauthClientFile");
      continue;
    }

    if (arg.startsWith("--oauthTokenFile=")) {
      oauthTokenFile = requiredFlagValue(arg, "--oauthTokenFile");
      continue;
    }

  }

  return {
    browser,
    command,
    connectUrl,
    dbFile,
    driveArchiveFolderId,
    driveFailedFolderId,
    driveFolderId,
    headless,
    oauthClientFile,
    oauthTokenFile,
    outputDir,
    queueDbFile
  };
}

function requiredFlagValue(arg: string, flagName: string): string {
  const value = arg.slice(`${flagName}=`.length).trim();
  if (!value) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  return value;
}

function parsePositiveInteger(value: string | null, label: string, fallback?: number): number {
  if (value === null || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }

    throw new Error(`Missing value for ${label}.`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} value: ${value}`);
  }

  return parsed;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function resolveDriveWorkerOptions(options: CliOptions): DriveWorkerOptions {
  if (!options.driveFolderId) {
    throw new Error("Missing DRIVE_FOLDER_ID or --driveFolderId for Drive commands.");
  }

  return {
    browser: options.browser,
    connectUrl: options.connectUrl,
    dbFile: options.dbFile,
    driveArchiveFolderId: options.driveArchiveFolderId,
    driveFailedFolderId: options.driveFailedFolderId,
    driveFolderId: options.driveFolderId,
    headless: options.headless,
    oauthClientFile: options.oauthClientFile,
    oauthTokenFile: options.oauthTokenFile,
    outputDir: options.outputDir,
    queueDbFile: options.queueDbFile
  };
}

async function ingestDriveQueue(options: DriveWorkerOptions): Promise<DriveIngestSummary> {
  const dbFile = path.resolve(process.cwd(), options.dbFile);
  const queueDbFile = path.resolve(process.cwd(), options.queueDbFile);
  const oauthClientFile = path.resolve(process.cwd(), options.oauthClientFile);
  const oauthTokenFile = path.resolve(process.cwd(), options.oauthTokenFile);

  logInfo(`Drive ingest start: folderId=${options.driveFolderId}`);
  const session = await getGoogleAccessSession(oauthClientFile, oauthTokenFile);
  const archiveFolderId = await resolveArchiveFolderId(session, options.driveFolderId, options.driveArchiveFolderId);
  const failureFolderId = await resolveFailureFolderId(session, options.driveFolderId, options.driveFailedFolderId);
  const scrapedDb = openTrackingDatabase(dbFile);
  const queueDb = openQueueDatabase(queueDbFile);

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

        if (getScrapedUrlRecord(scrapedDb, sourceUrl)) {
          await moveDriveFileToFolder(session, file.id, archiveFolderId);
          summary.archived += 1;
          summary.skippedExisting += 1;
          logInfo(`Drive file archived after scraped DB match: ${file.name} (${file.id})`);
          continue;
        }

        if (getQueuedUrlRecord(queueDb, sourceUrl)) {
          await moveDriveFileToFolder(session, file.id, archiveFolderId);
          summary.archived += 1;
          summary.skippedQueued += 1;
          logInfo(`Drive file archived after queue DB match: ${file.name} (${file.id})`);
          continue;
        }

        insertQueuedUrlRecord(queueDb, {
          driveFileId: file.id,
          driveFileName: file.name,
          lastError: null,
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
    queueDb.close();
    scrapedDb.close();
  }
}

async function scrapeQueuedUrls(
  options: Pick<CliOptions, "browser" | "connectUrl" | "dbFile" | "headless" | "outputDir" | "queueDbFile">
): Promise<QueueScrapeSummary> {
  const dbFile = path.resolve(process.cwd(), options.dbFile);
  const queueDbFile = path.resolve(process.cwd(), options.queueDbFile);
  const scrapedDb = openTrackingDatabase(dbFile);
  const queueDb = openQueueDatabase(queueDbFile);

  try {
    const records = getAllQueuedUrlRecords(queueDb);
    if (records.length === 0) {
      logInfo("Queue scrape found no queued URLs.");
      return {
        failed: 0,
        removedAlreadyScraped: 0,
        saved: 0,
        totalQueued: 0
      };
    }

    logInfo(`Queue scrape queued ${records.length} URL(s).`);
    const summary: QueueScrapeSummary = {
      failed: 0,
      removedAlreadyScraped: 0,
      saved: 0,
      totalQueued: records.length
    };

    for (const [index, record] of records.entries()) {
      try {
        logInfo(`Queue scrape start: ${record.sourceUrl}`);
        const existingRecord = getScrapedUrlRecord(scrapedDb, record.sourceUrl);
        if (existingRecord) {
          deleteQueuedUrlRecord(queueDb, record.sourceUrl);
          summary.removedAlreadyScraped += 1;
          logInfo(`Queue row removed because URL already exists in scraped DB: ${record.sourceUrl}`);
          continue;
        }

        const result = await scrapeAndWriteUrl(record.sourceUrl, options, index + 1, null);
        upsertScrapedUrlRecord(scrapedDb, {
          outputPath: result.outputPath,
          scrapedAt: new Date().toISOString(),
          sourceUrl: result.sourceUrl
        });
        deleteQueuedUrlRecord(queueDb, record.sourceUrl);
        summary.saved += 1;
        logInfo(`Queue scrape saved: ${result.sourceUrl} -> ${result.outputPath}`);
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        updateQueuedUrlError(queueDb, record.sourceUrl, message);
        logError(`Queue scrape failed: ${record.sourceUrl}: ${message}`);
      }
    }

    return summary;
  } finally {
    queueDb.close();
    scrapedDb.close();
  }
}

async function rescrapeTrackedUrls(
  options: Pick<CliOptions, "browser" | "connectUrl" | "dbFile" | "headless" | "outputDir">
): Promise<{ failed: number; rescraped: number; saved: number; skipped: number; total: number; }> {
  const dbFile = path.resolve(process.cwd(), options.dbFile);
  const db = openTrackingDatabase(dbFile);

  try {
    const records = getAllScrapedUrlRecords(db);
    if (records.length === 0) {
      logInfo("DB rescan found no tracked URLs.");
      return {
        failed: 0,
        rescraped: 0,
        saved: 0,
        skipped: 0,
        total: 0
      };
    }

    logInfo(`DB rescan queued ${records.length} tracked URL(s).`);
    let failed = 0;
    let rescraped = 0;
    let skipped = 0;

    for (const [index, record] of records.entries()) {
      try {
        logInfo(`DB rescan start: ${record.sourceUrl}`);
        const result = await scrapeAndWriteUrl(record.sourceUrl, options, index + 1, record.outputPath);
        upsertScrapedUrlRecord(db, {
          outputPath: result.outputPath,
          scrapedAt: new Date().toISOString(),
          sourceUrl: result.sourceUrl
        });
        rescraped += 1;
        logInfo(`DB rescan updated: ${result.sourceUrl} -> ${result.outputPath}`);
      } catch (error) {
        failed += 1;
        logError(`DB rescan failed: ${record.sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      failed,
      rescraped,
      saved: rescraped,
      skipped,
      total: records.length
    };
  } finally {
    db.close();
  }
}

function showDatabases(options: Pick<CliOptions, "dbFile" | "queueDbFile">): void {
  const dbFile = path.resolve(process.cwd(), options.dbFile);
  const queueDbFile = path.resolve(process.cwd(), options.queueDbFile);
  const scrapedDb = openTrackingDatabase(dbFile);
  const queueDb = openQueueDatabase(queueDbFile);

  try {
    const scrapedRows = getAllScrapedUrlRecords(scrapedDb);
    const queuedRows = getAllQueuedUrlRecords(queueDb);

    console.log(`scraped_urls (${scrapedRows.length})`);
    for (const row of scrapedRows) {
      console.log(`${row.scrapedAt}\t${row.sourceUrl}\t${row.outputPath}`);
    }

    console.log("");
    console.log(`url_from_drive (${queuedRows.length})`);
    for (const row of queuedRows) {
      const lastError = row.lastError ? `\tlast_error=${row.lastError}` : "";
      console.log(`${row.queuedAt}\t${row.sourceUrl}\t${row.driveFileName} (${row.driveFileId})${lastError}`);
    }
  } finally {
    queueDb.close();
    scrapedDb.close();
  }
}

async function getGoogleAccessSession(clientFile: string, tokenFile: string): Promise<GoogleOAuthToken> {
  const client = await readGoogleOAuthClient(clientFile);
  const existingToken = await readGoogleOAuthToken(tokenFile);
  if (existingToken && isAccessTokenValid(existingToken)) {
    return existingToken;
  }

  if (existingToken?.refreshToken) {
    const refreshedToken = await refreshGoogleAccessToken(client, existingToken, tokenFile);
    return refreshedToken;
  }

  return authorizeGoogleAccess(client, tokenFile);
}

async function readGoogleOAuthClient(clientFile: string): Promise<GoogleOAuthClient> {
  let raw: string;

  try {
    raw = await readFile(clientFile, "utf8");
  } catch {
    throw new Error(`Google OAuth client file not found: ${clientFile}`);
  }

  const parsed = JSON.parse(raw) as {
    installed?: {
      auth_uri?: string;
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
      token_uri?: string;
    };
    web?: {
      auth_uri?: string;
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
      token_uri?: string;
    };
  };

  const source = parsed.installed ?? parsed.web;
  if (!source?.client_id || !source.auth_uri || !source.token_uri) {
    throw new Error(`Invalid Google OAuth client file: ${clientFile}`);
  }

  return {
    authUri: source.auth_uri,
    clientId: source.client_id,
    clientSecret: source.client_secret,
    tokenUri: source.token_uri
  };
}

async function readGoogleOAuthToken(tokenFile: string): Promise<GoogleOAuthToken | null> {
  try {
    const raw = await readFile(tokenFile, "utf8");
    const parsed = JSON.parse(raw) as {
      access_token?: string;
      expiry_date_ms?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };

    if (!parsed.access_token) {
      return null;
    }

    return {
      accessToken: parsed.access_token,
      expiryDateMs: parsed.expiry_date_ms,
      refreshToken: parsed.refresh_token,
      scope: parsed.scope,
      tokenType: parsed.token_type
    };
  } catch {
    return null;
  }
}

function isAccessTokenValid(token: GoogleOAuthToken): boolean {
  return Boolean(token.accessToken && token.expiryDateMs && token.expiryDateMs > Date.now() + 60_000);
}

async function refreshGoogleAccessToken(
  client: GoogleOAuthClient,
  existingToken: GoogleOAuthToken,
  tokenFile: string
): Promise<GoogleOAuthToken> {
  if (!existingToken.refreshToken) {
    throw new Error("Google OAuth token file does not contain a refresh token.");
  }

  logInfo("Refreshing Google OAuth access token.");
  const params = new URLSearchParams({
    client_id: client.clientId,
    grant_type: "refresh_token",
    refresh_token: existingToken.refreshToken
  });

  if (client.clientSecret) {
    params.set("client_secret", client.clientSecret);
  }

  const response = await fetch(client.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const payload = await parseJsonResponse<{
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  }>(response);

  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(`Failed to refresh Google OAuth token: ${payload.error_description ?? payload.error ?? response.statusText}`);
  }

  const refreshedToken: GoogleOAuthToken = {
    accessToken: payload.access_token,
    expiryDateMs: Date.now() + payload.expires_in * 1000,
    refreshToken: payload.refresh_token ?? existingToken.refreshToken,
    scope: payload.scope ?? existingToken.scope,
    tokenType: payload.token_type ?? existingToken.tokenType ?? "Bearer"
  };

  await writeGoogleOAuthToken(tokenFile, refreshedToken);
  return refreshedToken;
}

async function authorizeGoogleAccess(client: GoogleOAuthClient, tokenFile: string): Promise<GoogleOAuthToken> {
  const callback = await waitForGoogleAuthorizationCode(client);
  const params = new URLSearchParams({
    client_id: client.clientId,
    code: callback.code,
    code_verifier: callback.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: callback.redirectUri
  });

  if (client.clientSecret) {
    params.set("client_secret", client.clientSecret);
  }

  const response = await fetch(client.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  const payload = await parseJsonResponse<{
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  }>(response);

  if (!response.ok || !payload.access_token || !payload.expires_in) {
    throw new Error(`Failed to exchange Google OAuth authorization code: ${payload.error_description ?? payload.error ?? response.statusText}`);
  }

  const token: GoogleOAuthToken = {
    accessToken: payload.access_token,
    expiryDateMs: Date.now() + payload.expires_in * 1000,
    refreshToken: payload.refresh_token,
    scope: payload.scope,
    tokenType: payload.token_type ?? "Bearer"
  };

  if (!token.refreshToken) {
    logWarn("Google OAuth did not return a refresh token. Future runs may require re-authorization.");
  }

  await writeGoogleOAuthToken(tokenFile, token);
  return token;
}

async function waitForGoogleAuthorizationCode(
  client: GoogleOAuthClient
): Promise<OAuthCallbackResult & { codeVerifier: string; }> {
  const state = base64UrlEncode(randomBytes(32));
  const codeVerifier = base64UrlEncode(randomBytes(64));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

  const server = createServer();
  const redirectHost = "127.0.0.1";
  const redirectPath = "/oauth2/callback";
  let resolveCallback: ((value: OAuthCallbackResult) => void) | null = null;
  let rejectCallback: ((reason?: unknown) => void) | null = null;

  const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  server.on("request", (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${redirectHost}`);
    if (requestUrl.pathname !== redirectPath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    if (requestUrl.searchParams.get("state") !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Invalid OAuth state.");
      rejectCallback?.(new Error("Google OAuth state mismatch."));
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Google OAuth failed: ${error}`);
      rejectCallback?.(new Error(`Google OAuth authorization failed: ${error}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code.");
      rejectCallback?.(new Error("Google OAuth callback did not include an authorization code."));
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>Authorization received</h1><p>You can close this browser tab and return to the scraper.</p></body></html>");
    resolveCallback?.({
      code,
      redirectUri: `http://${redirectHost}:${(server.address() as AddressInfo).port}${redirectPath}`
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, redirectHost, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local Google OAuth callback listener.");
  }

  const redirectUri = `http://${redirectHost}:${address.port}${redirectPath}`;
  const authUrl = new URL(client.authUri);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  authUrl.searchParams.set("state", state);

  logInfo("Google OAuth authorization required.");
  logInfo(`Open this URL in your browser, sign in, and approve access:\n${authUrl.toString()}`);

  const callbackResult = await Promise.race([
    callbackPromise,
    delay(OAUTH_CALLBACK_TIMEOUT_MS).then(() => {
      throw new Error("Timed out waiting for Google OAuth authorization callback.");
    })
  ]).finally(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    }).catch(() => undefined);
  });

  return {
    ...callbackResult,
    codeVerifier
  };
}

async function writeGoogleOAuthToken(tokenFile: string, token: GoogleOAuthToken): Promise<void> {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, JSON.stringify({
    access_token: token.accessToken,
    expiry_date_ms: token.expiryDateMs,
    refresh_token: token.refreshToken,
    scope: token.scope,
    token_type: token.tokenType
  }, null, 2), "utf8");
}

async function listSupportedDriveFilesInFolder(session: GoogleOAuthToken, folderId: string): Promise<DriveDocumentFile[]> {
  const docs: DriveDocumentFile[] = [];
  let pageToken: string | null = null;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("fields", GOOGLE_DRIVE_FILE_FIELDS);
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("orderBy", "modifiedTime");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("q", `'${folderId}' in parents and trashed=false and (mimeType='${GOOGLE_DOC_MIME_TYPE}' or mimeType='text/plain' or mimeType='text/markdown' or mimeType='text/csv' or mimeType='application/json' or mimeType='application/xml')`);
    url.searchParams.set("supportsAllDrives", "true");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await googleApiRequest<DriveListResponse>(session, url);
    docs.push(...(response.files ?? []));
    pageToken = response.nextPageToken ?? null;
  } while (pageToken);

  return docs;
}

async function getGoogleDocument(session: GoogleOAuthToken, documentId: string): Promise<GoogleDocument> {
  const url = new URL(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`);
  return googleApiRequest<GoogleDocument>(session, url);
}

async function getDriveFileText(session: GoogleOAuthToken, file: DriveDocumentFile): Promise<string> {
  if (file.mimeType === GOOGLE_DOC_MIME_TYPE) {
    const document = await getGoogleDocument(session, file.id);
    return extractTextFromGoogleDocument(document);
  }

  if (file.mimeType && GOOGLE_TEXT_MIME_TYPES.has(file.mimeType)) {
    return downloadDriveTextFile(session, file.id);
  }

  throw new Error(`Unsupported Drive file type: ${file.mimeType ?? "unknown"}`);
}

async function downloadDriveTextFile(session: GoogleOAuthToken, fileId: string): Promise<string> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "text/plain, text/markdown, application/json, application/xml, text/csv;q=0.9, */*;q=0.1"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to download Drive text file (${response.status}): ${text || response.statusText}`);
  }

  return normalizeText(text);
}

function extractTextFromGoogleDocument(document: GoogleDocument): string {
  return normalizeText(extractStructuralElements(document.body?.content ?? []));
}

function extractStructuralElements(elements: StructuralElement[]): string {
  const parts: string[] = [];

  for (const element of elements) {
    if (element.paragraph?.elements) {
      const paragraphText = element.paragraph.elements
        .map((paragraphElement) => paragraphElement.textRun?.content ?? paragraphElement.autoText?.content ?? "")
        .join("");
      parts.push(paragraphText);
    }

    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          parts.push(extractStructuralElements(cell.content ?? []));
        }
      }
    }

    if (element.tableOfContents?.content) {
      parts.push(extractStructuralElements(element.tableOfContents.content));
    }
  }

  return parts.join("\n");
}

function extractSingleArticleUrlFromText(text: string): string {
  const candidates = [...text.matchAll(/https?:\/\/[^\s<>"'()]+/g)]
    .map((match) => trimTrailingUrlPunctuation(match[0]));

  const articleUrls = [...new Set(candidates.flatMap((candidate) => {
    try {
      const article = createSingleArticle(candidate);
      assertArticleUrl(article.sourceUrl);
      return [article.sourceUrl];
    } catch {
      return [];
    }
  }))];

  if (articleUrls.length === 0) {
    throw new Error("No valid Medium article URL found in Drive file.");
  }

  if (articleUrls.length > 1) {
    throw new Error(`Drive file contains multiple Medium article URLs: ${articleUrls.join(", ")}`);
  }

  return articleUrls[0];
}

function trimTrailingUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

async function resolveFailureFolderId(
  session: GoogleOAuthToken,
  watchedFolderId: string,
  configuredFailureFolderId: string | null
): Promise<string> {
  if (configuredFailureFolderId) {
    return configuredFailureFolderId;
  }

  const watchedFolder = await getDriveFileParents(session, watchedFolderId);
  const parentId = watchedFolder.parents?.[0] ?? "root";
  const folderName = `${watchedFolder.name ?? "MEDIUM"}_FAILED`;
  const existingFolderId = await findFolderIdByName(session, folderName, parentId);

  if (existingFolderId) {
    return existingFolderId;
  }

  return createDriveFolder(session, folderName, parentId);
}

async function resolveArchiveFolderId(
  session: GoogleOAuthToken,
  watchedFolderId: string,
  configuredArchiveFolderId: string | null
): Promise<string> {
  if (configuredArchiveFolderId) {
    return configuredArchiveFolderId;
  }

  const watchedFolder = await getDriveFileParents(session, watchedFolderId);
  const parentId = watchedFolder.parents?.[0] ?? "root";
  const folderName = `${watchedFolder.name ?? "MEDIUM"}_ARCHIVED`;
  const existingFolderId = await findFolderIdByName(session, folderName, parentId);

  if (existingFolderId) {
    return existingFolderId;
  }

  return createDriveFolder(session, folderName, parentId);
}

async function getDriveFileParents(session: GoogleOAuthToken, fileId: string): Promise<DriveFileParentsResponse> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,parents");
  url.searchParams.set("supportsAllDrives", "true");
  return googleApiRequest<DriveFileParentsResponse>(session, url);
}

async function findFolderIdByName(session: GoogleOAuthToken, folderName: string, parentId: string): Promise<string | null> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("q", `'${parentId}' in parents and name='${escapeDriveQueryValue(folderName)}' and mimeType='${GOOGLE_FOLDER_MIME_TYPE}' and trashed=false`);
  url.searchParams.set("supportsAllDrives", "true");

  const response = await googleApiRequest<{ files?: Array<{ id: string; }>; }>(session, url);
  return response.files?.[0]?.id ?? null;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function createDriveFolder(session: GoogleOAuthToken, name: string, parentId: string): Promise<string> {
  logInfo(`Creating Drive folder "${name}" under parent ${parentId}.`);
  const response = await googleApiRequest<{ id: string; }>(
    session,
    new URL("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true"),
    {
      method: "POST",
      body: JSON.stringify({
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        name,
        parents: [parentId]
      }),
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return response.id;
}

async function moveDriveFileToFolder(session: GoogleOAuthToken, fileId: string, folderId: string): Promise<void> {
  const file = await getDriveFileParents(session, fileId);
  const currentParents = (file.parents ?? []).join(",");
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("addParents", folderId);
  if (currentParents) {
    url.searchParams.set("removeParents", currentParents);
  }
  url.searchParams.set("fields", "id,parents");
  url.searchParams.set("supportsAllDrives", "true");

  await googleApiRequest(session, url, {
    method: "PATCH",
    body: JSON.stringify({}),
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function openQueueDatabase(queueDbFile: string): DatabaseSync {
  mkdirSyncLike(path.dirname(queueDbFile));
  const db = new DatabaseSync(queueDbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS url_from_drive (
      source_url TEXT PRIMARY KEY,
      drive_file_id TEXT NOT NULL,
      drive_file_name TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_url_from_drive_queued_at ON url_from_drive(queued_at);
  `);
  return db;
}

async function googleApiRequest<T = void>(
  session: GoogleOAuthToken,
  url: URL,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await parseJsonResponse<T & { error?: { message?: string; }; }>(response);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error?.message
      : response.statusText;
    throw new Error(`Google API request failed (${response.status}): ${message ?? "Unknown error"}`);
  }

  return payload;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text ? JSON.parse(text) as T : {} as T;
}

async function scrapeAndWriteUrl(
  inputUrl: string,
  options: Pick<CliOptions, "browser" | "connectUrl" | "headless" | "outputDir">,
  index = 1,
  existingOutputPath: string | null = null
): Promise<{ outputPath: string; sourceUrl: string; }> {
  const outputDir = path.resolve(process.cwd(), options.outputDir);

  await mkdir(outputDir, { recursive: true });

  const article = createSingleArticle(inputUrl);
  assertArticleUrl(article.sourceUrl);
  logInfo(`Normalized article URL: ${inputUrl} -> ${article.sourceUrl}`);

  logInfo(`Opening browser for article: ${article.sourceUrl}`);
  const { browser, context } = await openBrowserSession(options.browser, options.headless, options.connectUrl);

  try {
    const result = await extractArticleContent(context, article, outputDir, index);
    const outputPath = await writeExtraction(outputDir, result, existingOutputPath);
    return {
      outputPath,
      sourceUrl: article.sourceUrl
    };
  } finally {
    await browser.close();
  }
}

function openTrackingDatabase(dbFile: string): DatabaseSync {
  mkdirSyncLike(path.dirname(dbFile));
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scraped_urls (
      source_url TEXT PRIMARY KEY,
      output_path TEXT NOT NULL,
      scraped_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scraped_urls_scraped_at ON scraped_urls(scraped_at);
  `);
  return db;
}

function mkdirSyncLike(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function getScrapedUrlRecord(db: DatabaseSync, sourceUrl: string): ScrapedUrlRecord | null {
  const row = db
    .prepare("SELECT source_url AS sourceUrl, output_path AS outputPath, scraped_at AS scrapedAt FROM scraped_urls WHERE source_url = ?")
    .get(sourceUrl) as ScrapedUrlRecord | undefined;

  return row ?? null;
}

function getAllScrapedUrlRecords(db: DatabaseSync): ScrapedUrlRecord[] {
  return db
    .prepare("SELECT source_url AS sourceUrl, output_path AS outputPath, scraped_at AS scrapedAt FROM scraped_urls ORDER BY scraped_at ASC, source_url ASC")
    .all() as ScrapedUrlRecord[];
}

function getQueuedUrlRecord(db: DatabaseSync, sourceUrl: string): QueueUrlRecord | null {
  const row = db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        drive_file_id AS driveFileId,
        drive_file_name AS driveFileName,
        queued_at AS queuedAt,
        last_error AS lastError
      FROM url_from_drive
      WHERE source_url = ?
    `)
    .get(sourceUrl) as QueueUrlRecord | undefined;

  return row ?? null;
}

function getAllQueuedUrlRecords(db: DatabaseSync): QueueUrlRecord[] {
  return db
    .prepare(`
      SELECT
        source_url AS sourceUrl,
        drive_file_id AS driveFileId,
        drive_file_name AS driveFileName,
        queued_at AS queuedAt,
        last_error AS lastError
      FROM url_from_drive
      ORDER BY queued_at ASC, source_url ASC
    `)
    .all() as QueueUrlRecord[];
}

function insertQueuedUrlRecord(db: DatabaseSync, record: QueueUrlRecord): void {
  db
    .prepare(`
      INSERT INTO url_from_drive (source_url, drive_file_id, drive_file_name, queued_at, last_error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        drive_file_id = excluded.drive_file_id,
        drive_file_name = excluded.drive_file_name,
        queued_at = excluded.queued_at,
        last_error = excluded.last_error
    `)
    .run(record.sourceUrl, record.driveFileId, record.driveFileName, record.queuedAt, record.lastError);
}

function deleteQueuedUrlRecord(db: DatabaseSync, sourceUrl: string): void {
  db.prepare("DELETE FROM url_from_drive WHERE source_url = ?").run(sourceUrl);
}

function updateQueuedUrlError(db: DatabaseSync, sourceUrl: string, lastError: string): void {
  db
    .prepare("UPDATE url_from_drive SET last_error = ? WHERE source_url = ?")
    .run(lastError, sourceUrl);
}

function upsertScrapedUrlRecord(db: DatabaseSync, record: ScrapedUrlRecord): void {
  db
    .prepare(`
      INSERT INTO scraped_urls (source_url, output_path, scraped_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        output_path = excluded.output_path,
        scraped_at = excluded.scraped_at
    `)
    .run(record.sourceUrl, record.outputPath, record.scrapedAt);
}

function resetTrackingDatabase(dbFile: string): void {
  const db = openTrackingDatabase(dbFile);
  db.exec("DELETE FROM scraped_urls;");
  db.close();
}

function createSingleArticle(inputUrl: string): Article {
  const sourceUrl = normalizeArticleUrl(inputUrl);
  const title = deriveTitleFromUrl(sourceUrl);
  return { title, sourceUrl };
}

function assertArticleUrl(sourceUrl: string): void {
  if (isArticleUrl(sourceUrl)) {
    return;
  }

  throw new Error(`Not an article URL: ${sourceUrl}`);
}

function isArticleUrl(sourceUrl: string): boolean {
  const parsed = new URL(sourceUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "";
  const lastSegment = segments.at(-1) ?? "";

  if (BLOCKED_MEDIUM_PATH_PREFIXES.has(firstSegment) || segments.includes("following-feed")) {
    return false;
  }

  if (segments[0] === "p" && /^[a-f0-9]{8,}$/i.test(lastSegment)) {
    return true;
  }

  if (/^[a-z0-9-]+-[a-f0-9]{8,}$/i.test(lastSegment)) {
    return true;
  }

  return false;
}

async function openBrowserSession(browserName: BrowserName, headless: boolean, connectUrl: string | null) {
  const browser = connectUrl
    ? await chromium.connectOverCDP(connectUrl)
    : await launchBrowser(browserName, headless);

  const existingContext = browser.contexts()[0];
  const context = existingContext ?? await browser.newContext();

  return { browser, context };
}

async function launchBrowser(browserName: BrowserName, headless: boolean) {
  if (browserName === "chrome") {
    return chromium.launch({ channel: "chrome", headless });
  }

  if (browserName === "msedge") {
    return chromium.launch({ channel: "msedge", headless });
  }

  if (browserName === "firefox") {
    return firefox.launch({ headless });
  }

  return webkit.launch({ headless });
}

async function extractArticleContent(
  context: BrowserContext,
  article: Article,
  outputDir: string,
  index: number
): Promise<ExtractionResult> {
  const page = await context.newPage();

  try {
    logInfo(`Freedium open: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

    const urlInput = page.locator('input[type="text"], input[type="url"], textarea').first();
    logInfo(`Freedium waiting for URL input: ${article.sourceUrl}`);
    await urlInput.waitFor({ state: "visible", timeout: 30000 });
    await urlInput.fill(article.sourceUrl);
    logInfo(`Freedium submitted: ${article.sourceUrl}`);
    await urlInput.press("Enter");

    await page.waitForURL((currentUrl) => currentUrl.pathname !== "/", { timeout: 30000 });
    logInfo(`Freedium result URL: ${page.url()}`);
    await assertNoSecurityVerification(page, article.sourceUrl);

    const mainContent = page.locator(".main-content, main, article, .content").first();
    logInfo(`Freedium waiting for content: ${article.sourceUrl}`);
    await mainContent.waitFor({ state: "visible", timeout: 30000 });
    const footerContent = await page
      .locator(".flex.flex-wrap.gap-2.mt-5")
      .first()
      .innerText()
      .then((value) => normalizeText(value))
      .catch(() => null);

    const content = normalizeText(await mainContent.innerText());
    if (!content) {
      throw new Error(`Empty content extracted for ${article.sourceUrl}`);
    }
    validateExtractedContent(content, article.sourceUrl);
    logInfo(`Freedium content extracted: ${article.sourceUrl} chars=${content.length}`);

    return {
      article,
      content,
      footerContent
    };
  } catch (error) {
    const safeName = `${String(index).padStart(3, "0")}-${slugify(article.title)}`;
    await saveDebugPage(page, outputDir, safeName);
    throw error;
  } finally {
    await page.close();
  }
}

async function assertNoSecurityVerification(page: Page, sourceUrl: string): Promise<void> {
  const pageTitle = (await page.title().catch(() => "")).toLowerCase();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const combinedText = `${pageTitle}\n${bodyText}`;

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (combinedText.includes(pattern)) {
      logWarn(`Anti-bot verification detected for ${sourceUrl} with pattern "${pattern}" at ${page.url()}`);
      throw new Error(
        `Blocked by an anti-bot verification page while loading ${sourceUrl}. ` +
        "The scraper did not extract article content."
      );
    }
  }
}

async function saveDebugPage(page: Page, outputDir: string, baseName: string): Promise<void> {
  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const screenshotPath = path.join(outputDir, `${baseName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeFile(htmlPath, await page.content(), "utf8").catch(() => undefined);
  logWarn(`Saved debug page artifacts: ${htmlPath} and ${screenshotPath}`);
}

function validateExtractedContent(content: string, sourceUrl: string): void {
  const normalized = content.toLowerCase();

  for (const pattern of SECURITY_VERIFICATION_PATTERNS) {
    if (normalized.includes(pattern)) {
      throw new Error(
        `Invalid article content extracted for ${sourceUrl}. ` +
        "The page content matches an anti-bot verification screen."
      );
    }
  }
}

function normalizeArticleUrl(inputUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid article URL: ${inputUrl}`);
  }

  if (parsed.origin === new URL(TARGET_URL).origin) {
    const embeddedUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/^\/+/, "");
    if (!embeddedUrl) {
      throw new Error("Freedium URL does not contain an embedded source article URL.");
    }

    try {
      parsed = new URL(embeddedUrl);
    } catch {
      throw new Error(`Unsupported Freedium URL: ${inputUrl}`);
    }
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function deriveTitleFromUrl(articleUrl: string): string {
  const pathname = new URL(articleUrl).pathname
    .split("/")
    .filter(Boolean)
    .pop();

  if (!pathname) {
    return "article";
  }

  return pathname
    .replace(/-[a-f0-9]{8,}$/i, "")
    .replace(/[-_]+/g, " ")
    .trim() || "article";
}

async function writeExtraction(outputDir: string, result: ExtractionResult, existingOutputPath: string | null): Promise<string> {
  const outputPath = buildStableOutputPath(outputDir, result.article.sourceUrl);
  const body = result.footerContent
    ? `${result.content}\n\n${result.footerContent}\n`
    : `${result.content}\n`;
  await writeFile(outputPath, body, "utf8");

  const previousOutputPath = existingOutputPath ? path.resolve(existingOutputPath) : null;
  if (previousOutputPath && previousOutputPath !== outputPath && existsSync(previousOutputPath)) {
    await unlink(previousOutputPath).catch(() => undefined);
  }

  return outputPath;
}

function buildStableOutputPath(outputDir: string, sourceUrl: string): string {
  const slug = slugify(deriveTitleFromUrl(sourceUrl));
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12);
  return path.join(outputDir, `${slug}-${hash}.txt`);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function logInfo(message: string): void {
  console.log(formatLogMessage("info", message));
}

function logWarn(message: string): void {
  console.warn(formatLogMessage("warn", message));
}

function logError(message: string): void {
  console.error(formatLogMessage("error", message));
}

function formatLogMessage(level: "error" | "info" | "warn", message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  logError(message);
  process.exitCode = 1;
});
