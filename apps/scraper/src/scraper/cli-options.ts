// CLI flags + environment -> CliOptions. Kept apart from index.ts (which runs
// main() on import) so option parsing can be unit-tested.

import process from "node:process";
import { DEFAULT_BACKUPS_DIR, DEFAULT_DEBUG_DIR, DEFAULT_DRIVE_BACKUP_FILE_NAME, DEFAULT_GOOGLE_OAUTH_CLIENT_FILE, DEFAULT_GOOGLE_OAUTH_TOKEN_FILE, DEFAULT_LIBRARY_DB_FILE, DEFAULT_OUTPUT_DIR, DEFAULT_RAG_MANIFEST_FILE, TARGET_URL } from "../config/index.js";
import { type BrowserName, type CliOptions, type Command } from "./types.js";

export const DEFAULT_MAX_SCRAPE_ATTEMPTS = 5;

export const DEFAULT_SCRAPE_DELAY_MS: [number, number] = [3000, 8000];


export function parseCliArgs(args: string[]): CliOptions {
  let browser: BrowserName = "chrome";
  let command: Command = "ingest-drive";
  let connectUrl: string | null = readEnv("CONNECT_URL");
  let headless = readEnv("HEADLESS") !== "false";
  let outputDir = readEnv("OUTPUT_DIR") ?? DEFAULT_OUTPUT_DIR;
  let libraryDbFile = readEnv("LIBRARY_DB_FILE") ?? DEFAULT_LIBRARY_DB_FILE;
  let driveBackupFolderId = readEnv("DRIVE_BACKUP_FOLDER_ID");
  let driveBackupFileName = readEnv("DRIVE_BACKUP_FILE_NAME") ?? DEFAULT_DRIVE_BACKUP_FILE_NAME;
  let driveFolderId = readEnv("DRIVE_FOLDER_ID");
  let driveArchiveFolderId = readEnv("DRIVE_ARCHIVE_FOLDER_ID");
  let driveFailedFolderId = readEnv("DRIVE_FAILED_FOLDER_ID");
  let oauthClientFile = readEnv("GOOGLE_OAUTH_CLIENT_FILE") ?? DEFAULT_GOOGLE_OAUTH_CLIENT_FILE;
  let oauthTokenFile = readEnv("GOOGLE_OAUTH_TOKEN_FILE") ?? DEFAULT_GOOGLE_OAUTH_TOKEN_FILE;
  let manifestFile = readEnv("RAG_MANIFEST_FILE") ?? DEFAULT_RAG_MANIFEST_FILE;
  let debugDir = readEnv("DEBUG_DIR") ?? DEFAULT_DEBUG_DIR;
  let backupsDir = readEnv("BACKUPS_DIR") ?? DEFAULT_BACKUPS_DIR;
  let requeueFile: string | null = null;
  const freediumUrls = parseFreediumUrls(readEnv("FREEDIUM_URL"), readEnv("FREEDIUM_FALLBACK_URLS"));
  const maxScrapeAttempts = parsePositiveIntegerEnv("MAX_SCRAPE_ATTEMPTS", DEFAULT_MAX_SCRAPE_ATTEMPTS);
  const scrapeDelayMs = parseDelayRange(readEnv("SCRAPE_DELAY_MS"));
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

    if (arg === "--backup-db") {
      command = "backup-db";
      continue;
    }

    if (arg === "--scrape-queue") {
      command = "scrape-queue";
      continue;
    }

    if (arg === "--run") {
      command = "run";
      continue;
    }

    if (arg === "--status") {
      command = "status";
      continue;
    }

    if (arg === "--export-urls") {
      command = "export-urls";
      continue;
    }

    if (arg.startsWith("--requeue-urls=")) {
      command = "requeue-urls";
      requeueFile = requiredFlagValue(arg, "--requeue-urls");
      continue;
    }

    if (arg.startsWith("--backupsDir=")) {
      backupsDir = requiredFlagValue(arg, "--backupsDir");
      continue;
    }

    if (arg === "--retry-failed") {
      command = "retry-failed";
      continue;
    }

    if (arg.startsWith("--debugDir=")) {
      debugDir = requiredFlagValue(arg, "--debugDir");
      continue;
    }

    if (arg.startsWith("--manifestFile=")) {
      manifestFile = requiredFlagValue(arg, "--manifestFile");
      continue;
    }

    if (arg === "--headless=false") {
      headless = false;
      continue;
    }

    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length).trim();
      if (value !== "chromium" && value !== "chrome" && value !== "msedge" && value !== "firefox" && value !== "webkit") {
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

    if (arg.startsWith("--libraryDbFile=")) {
      libraryDbFile = requiredFlagValue(arg, "--libraryDbFile");
      continue;
    }

    if (arg.startsWith("--driveBackupFolderId=")) {
      driveBackupFolderId = requiredFlagValue(arg, "--driveBackupFolderId");
      continue;
    }

    if (arg.startsWith("--driveBackupFileName=")) {
      driveBackupFileName = requiredFlagValue(arg, "--driveBackupFileName");
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
    backupsDir,
    browser,
    command,
    connectUrl,
    debugDir,
    driveBackupFileName,
    driveBackupFolderId,
    driveArchiveFolderId,
    driveFailedFolderId,
    driveFolderId,
    freediumUrls,
    headless,
    libraryDbFile,
    manifestFile,
    maxScrapeAttempts,
    oauthClientFile,
    oauthTokenFile,
    outputDir,
    requeueFile,
    scrapeDelayMs
  };
}

export function parseFreediumUrls(primary: string | null, fallbacks: string | null): string[] {
  // Mirror domains change often, so the primary mirror and any fallbacks come
  // from .env. Each is normalized to an origin with a trailing slash.
  const candidates = [primary ?? TARGET_URL, ...(fallbacks ?? "").split(",")]
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = candidates.map((value) => {
    try {
      return `${new URL(value).origin}/`;
    } catch {
      throw new Error(`Invalid Freedium mirror URL: ${value}`);
    }
  });
  return [...new Set(origins)];
}

export function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = readEnv(name);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value} (expected a positive integer)`);
  }
  return parsed;
}

export function parseDelayRange(value: string | null): [number, number] {
  if (value === null) {
    return DEFAULT_SCRAPE_DELAY_MS;
  }
  // Accepts "5000" (fixed) or "3000-8000" (random in range), in milliseconds.
  const match = value.match(/^(\d+)(?:\s*-\s*(\d+))?$/u);
  if (!match) {
    throw new Error(`Invalid SCRAPE_DELAY_MS value: ${value} (expected e.g. 3000-8000)`);
  }
  const minMs = Number(match[1]);
  const maxMs = match[2] ? Number(match[2]) : minMs;
  return minMs <= maxMs ? [minMs, maxMs] : [maxMs, minMs];
}

export function requiredFlagValue(arg: string, flagName: string): string {
  const value = arg.slice(`${flagName}=`.length).trim();
  if (!value) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  return value;
}

export function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
