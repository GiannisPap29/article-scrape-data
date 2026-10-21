"""Chunk + vector storage in one SQLite file (data/state/vectors.db) via sqlite-vec.

Replaces Chroma: at this library's size (~5k chunks x 768 dims) an exact
brute-force KNN takes a few milliseconds, and sqlite-vec is a 172 KB extension
instead of ~350 MB of Chroma dependencies. Evaluated 2026-10-18: identical
top-k results to Chroma on the same vectors.

Layout per collection (one per embedding model, since vector sizes differ):
  chunks           regular table: chunk text + JSON metadata, keyed by chunk_id
  vec_<collection> vec0 virtual table: embeddings, rowid = chunks.rowid
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

import sqlite_vec

VECTOR_STORE = "sqlite-vec"


def open_store(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS collections (
            name TEXT PRIMARY KEY,
            embed_model TEXT NOT NULL,
            dimensions INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            rowid INTEGER PRIMARY KEY,
            collection TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            document TEXT NOT NULL,
            metadata TEXT NOT NULL,
            UNIQUE (collection, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks (collection, doc_id);
        """
    )
    return conn


def _vec_table(collection: str) -> str:
    return "vec_" + re.sub(r"[^A-Za-z0-9_]", "_", collection)


def collection_exists(conn: sqlite3.Connection, collection: str) -> bool:
    return conn.execute("SELECT 1 FROM collections WHERE name = ?", (collection,)).fetchone() is not None


def ensure_collection(conn: sqlite3.Connection, collection: str, embed_model: str, dimensions: int) -> None:
    row = conn.execute("SELECT embed_model, dimensions FROM collections WHERE name = ?", (collection,)).fetchone()
    if row:
        if row[1] != dimensions:
            raise ValueError(
                f"Collection '{collection}' stores {row[1]}-dim vectors ({row[0]}), got {dimensions}. "
                "Use a different collection for a different embedding model."
            )
        return
    with conn:
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {_vec_table(collection)} USING vec0(embedding float[{int(dimensions)}] distance_metric=cosine)"
        )
        conn.execute("INSERT INTO collections (name, embed_model, dimensions) VALUES (?, ?, ?)", (collection, embed_model, dimensions))


def delete_document(conn: sqlite3.Connection, collection: str, doc_id: str) -> int:
    rowids = [row[0] for row in conn.execute("SELECT rowid FROM chunks WHERE collection = ? AND doc_id = ?", (collection, doc_id))]
    if rowids and collection_exists(conn, collection):
        conn.executemany(f"DELETE FROM {_vec_table(collection)} WHERE rowid = ?", [(rowid,) for rowid in rowids])
    conn.execute("DELETE FROM chunks WHERE collection = ? AND doc_id = ?", (collection, doc_id))
    return len(rowids)


def replace_document_chunks(
    conn: sqlite3.Connection,
    collection: str,
    doc_id: str,
    chunk_ids: list[str],
    documents: list[str],
    embeddings: list[list[float]],
    metadatas: list[dict[str, Any]],
) -> None:
    """Swap all chunks of one document in a single transaction, so a crash can
    never leave a mix of old and new chunks."""
    with conn:
        delete_document(conn, collection, doc_id)
        vec_table = _vec_table(collection)
        for index, (chunk_id, document, embedding, metadata) in enumerate(zip(chunk_ids, documents, embeddings, metadatas, strict=True)):
            cursor = conn.execute(
                "INSERT INTO chunks (collection, chunk_id, doc_id, chunk_index, document, metadata) VALUES (?, ?, ?, ?, ?, ?)",
                (collection, chunk_id, doc_id, int(metadata.get("chunk_index", index)), document, json.dumps(metadata)),
            )
            conn.execute(
                f"INSERT INTO {vec_table} (rowid, embedding) VALUES (?, ?)",
                (cursor.lastrowid, sqlite_vec.serialize_float32(embedding)),
            )


def query(conn: sqlite3.Connection, collection: str, embedding: list[float], k: int) -> list[tuple[str, dict[str, Any], float]]:
    """Nearest chunks as (document, metadata, cosine_distance), closest first."""
    if not collection_exists(conn, collection):
        raise LookupError(f"Vector collection '{collection}' does not exist yet. Run `make rag-sync rag-ingest` first.")
    rows = conn.execute(
        f"""
        SELECT c.document, c.metadata, v.distance
        FROM (SELECT rowid, distance FROM {_vec_table(collection)} WHERE embedding MATCH ? AND k = ?) AS v
        JOIN chunks AS c ON c.rowid = v.rowid
        ORDER BY v.distance
        """,
        (sqlite_vec.serialize_float32(embedding), int(k)),
    ).fetchall()
    return [(document, json.loads(metadata), float(distance)) for document, metadata, distance in rows]


def count(conn: sqlite3.Connection, collection: str) -> int:
    return conn.execute("SELECT COUNT(*) FROM chunks WHERE collection = ?", (collection,)).fetchone()[0]


def list_collections(conn: sqlite3.Connection) -> list[tuple[str, str, int, int]]:
    return [
        (name, model, dimensions, count(conn, name))
        for name, model, dimensions in conn.execute("SELECT name, embed_model, dimensions FROM collections ORDER BY name")
    ]


def get_chunks(conn: sqlite3.Connection, collection: str, doc_id: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
    sql = "SELECT chunk_id, document, metadata FROM chunks WHERE collection = ?"
    params: list[Any] = [collection]
    if doc_id is not None:
        sql += " AND doc_id = ?"
        params.append(doc_id)
    sql += " ORDER BY doc_id, chunk_index"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    return [{"id": chunk_id, "document": document, "metadata": json.loads(metadata)} for chunk_id, document, metadata in conn.execute(sql, params)]
