// Types shared across scraper modules.

export type BrowserName = "chromium" | "chrome" | "msedge" | "firefox" | "webkit";

export type Command = "backup-db" | "export-urls" | "ingest-drive" | "requeue-urls" | "rescan-db" | "reset" | "retry-failed" | "run" | "scrape-queue" | "status";

export type CliOptions = {
  backupsDir: string;
  browser: BrowserName;
  command: Command;
  connectUrl: string | null;
  debugDir: string;
  driveBackupFileName: string;
  driveBackupFolderId: string | null;
  driveArchiveFolderId: string | null;
  driveFailedFolderId: string | null;
  driveFolderId: string | null;
  freediumUrls: string[];
  headless: boolean;
  libraryDbFile: string;
  manifestFile: string;
  maxScrapeAttempts: number;
  oauthClientFile: string;
  oauthTokenFile: string;
  outputDir: string;
  requeueFile: string | null;
  scrapeDelayMs: [number, number];
};

export type ScrapeOptions = Pick<CliOptions, "browser" | "connectUrl" | "debugDir" | "freediumUrls" | "headless" | "maxScrapeAttempts" | "outputDir" | "scrapeDelayMs">;

export type DriveWorkerOptions = {
  driveArchiveFolderId: string | null;
  driveFailedFolderId: string | null;
  driveFolderId: string;
  oauthClientFile: string;
  oauthTokenFile: string;
  outputDir: string;
} & Pick<CliOptions, "browser" | "connectUrl" | "headless" | "libraryDbFile">;

export type Article = {
  docId: string;
  title: string;
  sourceUrl: string;
};

export type DriveBackupOptions = Pick<CliOptions, "libraryDbFile" | "driveBackupFileName" | "driveBackupFolderId" | "driveFolderId" | "oauthClientFile" | "oauthTokenFile">;

export type DriveDocumentFile = {
  id: string;
  mimeType?: string;
  modifiedTime: string;
  name: string;
  parents?: string[];
  webViewLink?: string;
};

export type DriveFileParentsResponse = {
  id: string;
  name?: string;
  parents?: string[];
};

export type DriveListResponse = {
  files?: DriveDocumentFile[];
  nextPageToken?: string;
};

export type DriveIngestSummary = {
  archived: number;
  failed: number;
  movedToFailure: number;
  skippedExisting: number;
  skippedQueued: number;
  queued: number;
  totalFiles: number;
};

export type FreediumMetadata = {
  free: boolean | null;
  publication: string | null;
  updatedAt: string | null;
  url: string | null;
};

export type ExtractionResult = {
  article: Article;
  author: string | null;
  content: string;
  contentFormat: ContentFormat;
  coverImage: string | null;
  excerpt: string | null;
  freedium: FreediumMetadata;
  language: string | null;
  publishedAt: string | null;
  readingTimeMinutes: number | null;
  siteName: string | null;
  tags: string[];
  title: string;
};

// "markdown": body is Freedium's own Markdown export (v4+).
// "text": body was rebuilt from the page HTML (fallback, and all v2/v3 files).
export type ContentFormat = "markdown" | "text";

export type GoogleDocument = {
  body?: {
    content?: StructuralElement[];
  };
  title?: string;
};

export type GoogleOAuthClient = {
  authUri: string;
  clientId: string;
  clientSecret?: string;
  tokenUri: string;
};

export type GoogleOAuthToken = {
  accessToken: string;
  expiryDateMs?: number;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
};

export type OAuthCallbackResult = {
  code: string;
  redirectUri: string;
};

export type ScrapedUrlRecord = {
  author: string | null;
  contentHash: string | null;
  docId: string | null;
  excerpt: string | null;
  freediumUrl: string | null;
  language: string | null;
  metadataPath: string | null;
  outputPath: string;
  publishedAt: string | null;
  scrapedAt: string;
  siteName: string | null;
  sourceUrl: string;
  tagsJson: string | null;
  title: string | null;
};

export type QueueUrlRecord = {
  attempts: number;
  driveFileId: string;
  driveFileName: string;
  lastError: string | null;
  nextRetryAt: string | null;
  queuedAt: string;
  sourceUrl: string;
};

export type QueueScrapeSummary = {
  deferred: number;
  failed: number;
  gaveUp: number;
  removedAlreadyScraped: number;
  saved: number;
  totalQueued: number;
};

export type RunSummary = {
  backupFailed: boolean;
  ingest: DriveIngestSummary | null;
  scrape: QueueScrapeSummary;
};

export type PersistedDocumentMetadata = {
  author: string | null;
  batchId: string;
  contentFormat: ContentFormat;
  contentHash: string;
  coverImage: string | null;
  docId: string;
  excerpt: string | null;
  freediumUrl: string | null;
  freedium: FreediumMetadata;
  language: string | null;
  metadataPath: string;
  outputPath: string;
  publishedAt: string | null;
  readingTimeMinutes: number | null;
  scraperMetadataVersion: number;
  scrapedAt: string;
  siteName: string | null;
  sourceUrl: string;
  tags: string[];
  title: string;
};

export type StructuralElement = {
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
