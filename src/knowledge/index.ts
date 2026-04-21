import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "@huggingface/transformers";
import * as sqliteVec from "sqlite-vec";
import {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_CHUNK_TARGET_TOKENS,
  DEFAULT_DB_FILE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_KNOWLEDGE_DB_FILE,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_QUERY_TOP_K
} from "../config/index.js";

type Command = "index-corpus" | "query-corpus" | "reset-index";

type CliOptions = {
  chunkOverlapTokens: number;
  chunkTargetTokens: number;
  command: Command;
  embeddingModel: string;
  knowledgeDbFile: string;
  outputDir: string;
  query: string | null;
  queryTopK: number;
  scrapedDbFile: string;
};

type ScrapedUrlRecord = {
  outputPath: string;
  scrapedAt: string;
  sourceUrl: string;
};

type KnowledgeDocumentRecord = {
  contentHash: string;
  indexedAt: string;
  outputPath: string;
  sourceUrl: string;
  title: string;
  updatedAt: string;
};

type ChunkInput = {
  chunkIndex: number;
  text: string;
  tokenCount: number;
};

type IndexSummary = {
  failed: number;
  indexed: number;
  skippedUnchanged: number;
  total: number;
  updated: number;
};

type QueryMatch = {
  chunkIndex: number;
  distance: number;
  outputPath: string;
  sourceUrl: string;
  text: string;
  title: string;
};

const KNOWLEDGE_META_EMBEDDING_DIMENSIONS = "embedding_dimensions";
const KNOWLEDGE_META_EMBEDDING_MODEL = "embedding_model";
const SENTENCE_SPLIT_TARGET_TOKENS = 500;
const LOCAL_EMBEDDING_POOLING = "mean";

type LocalEmbeddingOutput = {
  data: Float32Array | number[];
  dims: number[];
};

type LocalEmbeddingExtractor = (
  input: string,
  options: {
    normalize: boolean;
    pooling: typeof LOCAL_EMBEDDING_POOLING;
  }
) => Promise<LocalEmbeddingOutput>;

const embeddingExtractorCache = new Map<string, Promise<LocalEmbeddingExtractor>>();

async function main(): Promise<void> {
  loadDotEnv(path.resolve(process.cwd(), ".env"));
  const options = parseCliArgs(process.argv.slice(2));
  logInfo(`Starting command=${options.command} knowledgeDbFile=${options.knowledgeDbFile} scrapedDbFile=${options.scrapedDbFile}`);

  if (options.command === "reset-index") {
    await resetKnowledgeDatabase(path.resolve(process.cwd(), options.knowledgeDbFile));
    logInfo(`Reset knowledge database: ${path.resolve(process.cwd(), options.knowledgeDbFile)}`);
    return;
  }

  if (options.command === "index-corpus") {
    const summary = await indexCorpus(options);
    logInfo(`Index complete: total=${summary.total} indexed=${summary.indexed} updated=${summary.updated} skippedUnchanged=${summary.skippedUnchanged} failed=${summary.failed}`);
    return;
  }

  const results = await queryCorpus(options);
  renderQueryResults(options.query ?? "", results);
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
  let command: Command = "index-corpus";
  let scrapedDbFile = readEnv("DB_FILE") ?? DEFAULT_DB_FILE;
  let outputDir = readEnv("OUTPUT_DIR") ?? DEFAULT_OUTPUT_DIR;
  let knowledgeDbFile = readEnv("KNOWLEDGE_DB_FILE") ?? DEFAULT_KNOWLEDGE_DB_FILE;
  let embeddingModel = readEnv("EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL;
  let chunkTargetTokens = parsePositiveInteger(readEnv("CHUNK_TARGET_TOKENS"), "CHUNK_TARGET_TOKENS", DEFAULT_CHUNK_TARGET_TOKENS);
  let chunkOverlapTokens = parsePositiveInteger(readEnv("CHUNK_OVERLAP_TOKENS"), "CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP_TOKENS);
  let queryTopK = parsePositiveInteger(readEnv("QUERY_TOP_K"), "QUERY_TOP_K", DEFAULT_QUERY_TOP_K);
  let query: string | null = readEnv("QUERY");

  for (const arg of args) {
    if (arg === "--index-corpus") {
      command = "index-corpus";
      continue;
    }

    if (arg === "--query-corpus") {
      command = "query-corpus";
      continue;
    }

    if (arg === "--reset-index") {
      command = "reset-index";
      continue;
    }

    if (arg.startsWith("--scrapedDbFile=")) {
      scrapedDbFile = requiredFlagValue(arg, "--scrapedDbFile");
      continue;
    }

    if (arg.startsWith("--outputDir=")) {
      outputDir = requiredFlagValue(arg, "--outputDir");
      continue;
    }

    if (arg.startsWith("--knowledgeDbFile=")) {
      knowledgeDbFile = requiredFlagValue(arg, "--knowledgeDbFile");
      continue;
    }

    if (arg.startsWith("--embeddingModel=")) {
      embeddingModel = requiredFlagValue(arg, "--embeddingModel");
      continue;
    }

    if (arg.startsWith("--chunkTargetTokens=")) {
      chunkTargetTokens = parsePositiveInteger(requiredFlagValue(arg, "--chunkTargetTokens"), "--chunkTargetTokens");
      continue;
    }

    if (arg.startsWith("--chunkOverlapTokens=")) {
      chunkOverlapTokens = parsePositiveInteger(requiredFlagValue(arg, "--chunkOverlapTokens"), "--chunkOverlapTokens");
      continue;
    }

    if (arg.startsWith("--queryTopK=")) {
      queryTopK = parsePositiveInteger(requiredFlagValue(arg, "--queryTopK"), "--queryTopK");
      continue;
    }

    if (arg.startsWith("--query=")) {
      query = requiredFlagValue(arg, "--query");
    }
  }

  if (chunkOverlapTokens >= chunkTargetTokens) {
    throw new Error("CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_TARGET_TOKENS.");
  }

  if (command === "query-corpus" && !query) {
    throw new Error("Missing query. Use QUERY=\"...\" or --query=\"...\" for query-corpus.");
  }

  return {
    chunkOverlapTokens,
    chunkTargetTokens,
    command,
    embeddingModel,
    knowledgeDbFile,
    outputDir,
    query,
    queryTopK,
    scrapedDbFile
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

async function indexCorpus(options: CliOptions): Promise<IndexSummary> {
  const scrapedDbFile = path.resolve(process.cwd(), options.scrapedDbFile);
  const knowledgeDbFile = path.resolve(process.cwd(), options.knowledgeDbFile);
  const outputDir = path.resolve(process.cwd(), options.outputDir);

  const scrapedDb = openScrapedHistoryDatabase(scrapedDbFile);
  const knowledgeDb = openKnowledgeDatabase(knowledgeDbFile);
  const records = getAllScrapedUrlRecords(scrapedDb);

  try {
    if (records.length === 0) {
      logInfo("Index corpus found no scraped documents.");
      return { failed: 0, indexed: 0, skippedUnchanged: 0, total: 0, updated: 0 };
    }

    await getLocalEmbeddingExtractor(options.embeddingModel);

    const summary: IndexSummary = {
      failed: 0,
      indexed: 0,
      skippedUnchanged: 0,
      total: records.length,
      updated: 0
    };

    for (const record of records) {
      try {
        const outputPath = path.resolve(process.cwd(), record.outputPath);
        if (!isPathInsideDirectory(outputPath, outputDir)) {
          throw new Error(`Output path is outside OUTPUT_DIR: ${outputPath}`);
        }

        const content = normalizeText(await readFile(outputPath, "utf8"));
        if (!content) {
          throw new Error(`Document content is empty: ${outputPath}`);
        }

        const contentHash = sha256(content);
        const existingDocument = getKnowledgeDocumentRecord(knowledgeDb, record.sourceUrl);
        if (existingDocument?.contentHash === contentHash) {
          summary.skippedUnchanged += 1;
          logInfo(`Index skipped unchanged: ${record.sourceUrl}`);
          continue;
        }

        const chunks = chunkText(content, options.chunkTargetTokens, options.chunkOverlapTokens);
        if (chunks.length === 0) {
          throw new Error(`No chunks produced for ${record.sourceUrl}`);
        }

        const embeddings = await embedTexts(options.embeddingModel, chunks.map((chunk) => chunk.text));
        await ensureVectorSchema(knowledgeDb, embeddings[0]?.length ?? 0, options.embeddingModel);
        replaceKnowledgeDocument(knowledgeDb, record, chunks, embeddings, contentHash);

        if (existingDocument) {
          summary.updated += 1;
          logInfo(`Index updated: ${record.sourceUrl}`);
        } else {
          summary.indexed += 1;
          logInfo(`Index added: ${record.sourceUrl}`);
        }
      } catch (error) {
        summary.failed += 1;
        logError(`Index failed: ${record.sourceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return summary;
  } finally {
    knowledgeDb.close();
    scrapedDb.close();
  }
}

async function queryCorpus(options: CliOptions): Promise<QueryMatch[]> {
  const knowledgeDbFile = path.resolve(process.cwd(), options.knowledgeDbFile);
  const db = openKnowledgeDatabase(knowledgeDbFile);

  try {
    if (getIndexedChunkCount(db) === 0) {
      logInfo("Knowledge query found no indexed chunks.");
      return [];
    }

    const [queryEmbedding] = await embedTexts(options.embeddingModel, [options.query ?? ""]);
    await ensureVectorSchema(db, queryEmbedding.length, options.embeddingModel);

    return searchKnowledge(db, queryEmbedding, options.queryTopK);
  } finally {
    db.close();
  }
}

async function resetKnowledgeDatabase(knowledgeDbFile: string): Promise<void> {
  await rm(knowledgeDbFile, { force: true });
}

function openScrapedHistoryDatabase(dbFile: string): DatabaseSync {
  return new DatabaseSync(dbFile);
}

function openKnowledgeDatabase(dbFile: string): DatabaseSync {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile, { allowExtension: true });
  sqliteVec.load(db);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      source_url TEXT PRIMARY KEY,
      output_path TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      FOREIGN KEY(source_url) REFERENCES documents(source_url) ON DELETE CASCADE,
      UNIQUE(source_url, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source_url ON chunks(source_url);
  `);
  return db;
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getAllScrapedUrlRecords(db: DatabaseSync): ScrapedUrlRecord[] {
  return db
    .prepare("SELECT source_url AS sourceUrl, output_path AS outputPath, scraped_at AS scrapedAt FROM scraped_urls ORDER BY scraped_at ASC, source_url ASC")
    .all() as ScrapedUrlRecord[];
}

function getKnowledgeDocumentRecord(db: DatabaseSync, sourceUrl: string): KnowledgeDocumentRecord | null {
  const row = db.prepare(`
    SELECT
      source_url AS sourceUrl,
      output_path AS outputPath,
      title,
      content_hash AS contentHash,
      indexed_at AS indexedAt,
      updated_at AS updatedAt
    FROM documents
    WHERE source_url = ?
  `).get(sourceUrl) as KnowledgeDocumentRecord | undefined;

  return row ?? null;
}

function getIndexedChunkCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number; };
  return row.count;
}

async function ensureVectorSchema(db: DatabaseSync, dimensions: number, embeddingModel: string): Promise<void> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }

  const storedDimensions = getMetaValue(db, KNOWLEDGE_META_EMBEDDING_DIMENSIONS);
  const storedModel = getMetaValue(db, KNOWLEDGE_META_EMBEDDING_MODEL);

  if (storedDimensions && Number(storedDimensions) !== dimensions) {
    throw new Error(`Knowledge DB embedding dimension mismatch. Expected ${storedDimensions}, received ${dimensions}. Run make reset-index and rebuild the index.`);
  }

  if (storedModel && storedModel !== embeddingModel) {
    throw new Error(`Knowledge DB embedding model mismatch. Expected ${storedModel}, received ${embeddingModel}. Run make reset-index and rebuild the index.`);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine
    );
  `);

  if (!storedDimensions) {
    setMetaValue(db, KNOWLEDGE_META_EMBEDDING_DIMENSIONS, String(dimensions));
  }

  if (!storedModel) {
    setMetaValue(db, KNOWLEDGE_META_EMBEDDING_MODEL, embeddingModel);
  }
}

function getMetaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM knowledge_meta WHERE key = ?").get(key) as { value: string; } | undefined;
  return row?.value ?? null;
}

function setMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO knowledge_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function replaceKnowledgeDocument(
  db: DatabaseSync,
  record: ScrapedUrlRecord,
  chunks: ChunkInput[],
  embeddings: number[][],
  contentHash: string
): void {
  if (chunks.length !== embeddings.length) {
    throw new Error("Chunk count and embedding count do not match.");
  }

  const now = new Date().toISOString();
  const existing = getKnowledgeDocumentRecord(db, record.sourceUrl);
  const indexedAt = existing?.indexedAt ?? now;
  const title = deriveTitleFromUrl(record.sourceUrl);

  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    deleteVectorsForSourceUrl(db, record.sourceUrl);
    db.prepare("DELETE FROM chunks WHERE source_url = ?").run(record.sourceUrl);

    db.prepare(`
      INSERT INTO documents (source_url, output_path, title, content_hash, indexed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_url) DO UPDATE SET
        output_path = excluded.output_path,
        title = excluded.title,
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
    `).run(record.sourceUrl, record.outputPath, title, contentHash, indexedAt, now);

    const insertChunk = db.prepare(`
      INSERT INTO chunks (source_url, chunk_index, text, token_count, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertVector = db.prepare(`
      INSERT INTO chunk_vectors (chunk_id, embedding)
      VALUES (?, ?)
    `);

    for (const [index, chunk] of chunks.entries()) {
      const result = insertChunk.run(record.sourceUrl, chunk.chunkIndex, chunk.text, chunk.tokenCount, contentHash);
      const chunkId = toSqliteInteger(result.lastInsertRowid);
      insertVector.run(chunkId, toVectorBlob(embeddings[index]));
    }

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function deleteVectorsForSourceUrl(db: DatabaseSync, sourceUrl: string): void {
  const rows = db.prepare("SELECT chunk_id AS chunkId FROM chunks WHERE source_url = ? ORDER BY chunk_id ASC").all(sourceUrl) as Array<{ chunkId: number; }>;
  const stmt = db.prepare("DELETE FROM chunk_vectors WHERE chunk_id = ?");
  for (const row of rows) {
    stmt.run(toSqliteInteger(row.chunkId));
  }
}

function toSqliteInteger(value: bigint | number): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (!Number.isInteger(value)) {
    throw new Error(`Expected integer SQLite rowid, received: ${value}`);
  }

  return BigInt(value);
}

async function embedTexts(embeddingModel: string, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) {
    return [];
  }

  const extractor = await getLocalEmbeddingExtractor(embeddingModel);
  const embeddings: number[][] = [];

  for (const input of inputs) {
    const output = await extractor(input, {
      normalize: true,
      pooling: LOCAL_EMBEDDING_POOLING
    });
    embeddings.push(normalizeEmbeddingOutput(output));
  }

  return embeddings;
}

async function getLocalEmbeddingExtractor(embeddingModel: string): Promise<LocalEmbeddingExtractor> {
  const cached = embeddingExtractorCache.get(embeddingModel);
  if (cached) {
    return cached;
  }

  logInfo(`Loading local embedding model: ${embeddingModel}`);

  const pendingExtractor = (async () => {
    const extractor = await pipeline("feature-extraction", embeddingModel);
    return extractor as unknown as LocalEmbeddingExtractor;
  })();

  embeddingExtractorCache.set(embeddingModel, pendingExtractor);

  try {
    return await pendingExtractor;
  } catch (error) {
    embeddingExtractorCache.delete(embeddingModel);
    throw new Error(
      `Failed to load local embedding model "${embeddingModel}". On first use the model must be downloaded and cached locally. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeEmbeddingOutput(output: LocalEmbeddingOutput): number[] {
  const values = Array.from(output.data);

  if (output.dims.length === 1) {
    return values;
  }

  if (output.dims.length === 2 && output.dims[0] === 1) {
    return values;
  }

  throw new Error(`Unexpected local embedding tensor shape: [${output.dims.join(", ")}]`);
}

function searchKnowledge(db: DatabaseSync, queryEmbedding: number[], topK: number): QueryMatch[] {
  return db.prepare(`
    WITH matches AS (
      SELECT
        chunk_id,
        distance
      FROM chunk_vectors
      WHERE embedding MATCH ?
        AND k = ?
    )
    SELECT
      documents.source_url AS sourceUrl,
      documents.title AS title,
      documents.output_path AS outputPath,
      chunks.chunk_index AS chunkIndex,
      chunks.text AS text,
      matches.distance AS distance
    FROM matches
    JOIN chunks ON chunks.chunk_id = matches.chunk_id
    JOIN documents ON documents.source_url = chunks.source_url
    ORDER BY matches.distance ASC, chunks.chunk_id ASC
  `).all(toVectorBlob(queryEmbedding), topK) as QueryMatch[];
}

function chunkText(text: string, targetTokens: number, overlapTokens: number): ChunkInput[] {
  const units = splitIntoChunkUnits(text, targetTokens);
  const chunks: ChunkInput[] = [];
  let cursor = 0;

  while (cursor < units.length) {
    const currentUnits: string[] = [];
    let currentTokens = 0;
    let nextCursor = cursor;

    while (nextCursor < units.length) {
      const unit = units[nextCursor];
      const tokenCount = estimateTokenCount(unit);
      if (currentUnits.length > 0 && currentTokens + tokenCount > targetTokens) {
        break;
      }

      currentUnits.push(unit);
      currentTokens += tokenCount;
      nextCursor += 1;

      if (currentTokens >= targetTokens) {
        break;
      }
    }

    if (currentUnits.length === 0) {
      break;
    }

    chunks.push({
      chunkIndex: chunks.length,
      text: currentUnits.join("\n\n"),
      tokenCount: currentTokens
    });

    if (nextCursor >= units.length) {
      break;
    }

    let overlapTokensUsed = 0;
    let overlapStart = currentUnits.length;
    while (overlapStart > 0 && overlapTokensUsed < overlapTokens) {
      overlapStart -= 1;
      overlapTokensUsed += estimateTokenCount(currentUnits[overlapStart]);
    }

    cursor += Math.max(1, overlapStart);
  }

  return chunks;
}

function splitIntoChunkUnits(text: string, targetTokens: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const units: string[] = [];

  for (const paragraph of paragraphs) {
    if (estimateTokenCount(paragraph) <= targetTokens) {
      units.push(paragraph);
      continue;
    }

    const sentences = paragraph
      .split(/(?<=[.!?])\s+/u)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    if (sentences.length === 0) {
      units.push(paragraph);
      continue;
    }

    let current = "";
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (current && estimateTokenCount(candidate) > Math.max(targetTokens, SENTENCE_SPLIT_TARGET_TOKENS)) {
        units.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }

    if (current) {
      units.push(current);
    }
  }

  return units;
}

function estimateTokenCount(text: string): number {
  const pieces = text.match(/\S+/g);
  return pieces?.length ?? 0;
}

function toVectorBlob(embedding: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(embedding).buffer);
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

function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function renderQueryResults(query: string, results: QueryMatch[]): void {
  if (results.length === 0) {
    console.log(`Query: ${query}\n\nNo indexed matches found.`);
    return;
  }

  const lines: string[] = [];
  lines.push(`Query: ${query}`);
  lines.push("");
  lines.push(`Top matches: ${results.length}`);

  for (const [index, result] of results.entries()) {
    lines.push("");
    lines.push(`[${index + 1}] ${result.title}`);
    lines.push(`source_url: ${result.sourceUrl}`);
    lines.push(`output_path: ${result.outputPath}`);
    lines.push(`chunk_index: ${result.chunkIndex}`);
    lines.push(`distance: ${result.distance.toFixed(6)}`);
    lines.push("");
    lines.push(result.text);
  }

  console.log(lines.join("\n"));
}

function logInfo(message: string): void {
  console.log(formatLogMessage("info", message));
}

function logError(message: string): void {
  console.error(formatLogMessage("error", message));
}

function formatLogMessage(level: "error" | "info", message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  logError(message);
  process.exitCode = 1;
});
