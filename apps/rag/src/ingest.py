from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

import vectorstore
from common import (
    CHUNK_VERSION,
    VECTORS_DB_PATH,
    DEFAULT_EMBED_MODEL,
    DEFAULT_OLLAMA_HOST,
    chunk_text,
    collection_name_for,
    compact_metadata,
    embed_texts,
    ensure_ollama_model,
    format_for_embedding,
    load_manifest,
    ollama_client,
    save_manifest,
    unload_ollama_model,
    utc_now_iso,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chunk, embed (via Ollama), and store scraper docs in the sqlite-vec index.")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help="Ollama embedding model name.")
    parser.add_argument(
        "--collection",
        default=None,
        help="Vector collection name (default: derived from the embedding model).",
    )
    parser.add_argument("--ollama-host", default=DEFAULT_OLLAMA_HOST, help="Ollama host URL.")
    parser.add_argument("--limit", type=int, default=None, help="Optional limit for documents to ingest.")
    parser.add_argument("--force", action="store_true", help="Re-ingest all documents regardless of manifest state.")
    return parser.parse_args()


def build_chunk_metadata(record: dict[str, Any], chunk_index: int, embed_model: str) -> dict[str, Any]:
    return compact_metadata(
        {
            "doc_id": record["doc_id"],
            "chunk_index": chunk_index,
            "content_hash": record["content_hash"],
            "source_url": record["source_url"],
            "title": record["title"],
            # Scraped Medium tags when present, otherwise locally generated ones.
            "tags": record.get("tags") or record.get("auto_tags", []),
            "scraped_at": record["scraped_at"],
            "published_at": record.get("published_at"),
            "language": record.get("language"),
            "author": record.get("author"),
            "site_name": record.get("site_name"),
            "filename": Path(record["source_output_path"]).name,
            "source_path": record["source_output_path"],
            "embed_model": embed_model,
        }
    )


def needs_indexing(record: dict[str, Any], collection_name: str, embed_model: str, force: bool) -> bool:
    if force:
        return True
    return not (
        record.get("last_ingested_hash") == record["content_hash"]
        and record.get("collection") == collection_name
        and record.get("embed_model") == embed_model
        and record.get("chunk_version") == CHUNK_VERSION
        and record.get("vector_store") == vectorstore.VECTOR_STORE
    )


def ingest_documents(
    collection_name: str, embed_model: str, ollama_host: str, limit: int | None, force: bool
) -> tuple[int, int, int]:
    manifest = load_manifest()
    documents = manifest["documents"]

    client = ollama_client(ollama_host)
    ensure_ollama_model(client, embed_model, "embedding")

    store = vectorstore.open_store(VECTORS_DB_PATH)

    # Documents whose scraper files disappeared: drop their chunks and records.
    removed = 0
    for doc_id in [doc_id for doc_id, record in documents.items() if record.get("status") == "removed"]:
        with store:
            vectorstore.delete_document(store, collection_name, doc_id)
        del documents[doc_id]
        removed += 1

    pending = [
        record
        for record in sorted(documents.values(), key=lambda item: item["doc_id"])
        if record.get("status") in {"synced", "indexed"} and needs_indexing(record, collection_name, embed_model, force)
    ]
    if limit is not None:
        pending = pending[:limit]

    print(f"ingest: {len(pending)} document(s) to index with {embed_model} into '{collection_name}'", flush=True)
    indexed = 0
    skipped = 0
    started = time.monotonic()

    for position, record in enumerate(pending, start=1):
        text_path = Path(record["source_output_path"])
        if not text_path.exists():
            record["status"] = "missing_source_text"
            skipped += 1
            continue

        text = text_path.read_text(encoding="utf-8").strip()
        chunks = chunk_text(text) if text else []
        if not chunks:
            record["status"] = "empty_source_text"
            skipped += 1
            continue

        inputs = [format_for_embedding(embed_model, "document", chunk, record["title"]) for chunk in chunks]
        embeddings = embed_texts(client, embed_model, inputs)
        ids = [f"{record['doc_id']}:chunk:{index}:{record['content_hash'][:12]}" for index in range(len(chunks))]
        metadatas = [build_chunk_metadata(record, index, embed_model) for index in range(len(chunks))]

        # Replace all chunks for this document (one transaction) so stale
        # chunks from an older content hash or chunking cannot linger.
        vectorstore.ensure_collection(store, collection_name, embed_model, len(embeddings[0]))
        vectorstore.replace_document_chunks(store, collection_name, record["doc_id"], ids, chunks, embeddings, metadatas)

        record.update(
            {
                "chunk_count": len(chunks),
                "chunk_version": CHUNK_VERSION,
                "collection": collection_name,
                "embed_model": embed_model,
                "indexed_at": utc_now_iso(),
                "last_ingested_hash": record["content_hash"],
                "status": "indexed",
                "vector_store": vectorstore.VECTOR_STORE,
            }
        )
        indexed += 1

        # Save as we go: a full re-index takes a while, and an interruption
        # should resume where it stopped instead of starting over.
        save_manifest(manifest)
        if position % 10 == 0 or position == len(pending):
            elapsed = time.monotonic() - started
            print(f"ingest: {position}/{len(pending)} done ({elapsed:.0f}s, ~{elapsed / position:.1f}s/doc)", flush=True)

    manifest["last_ingest_at"] = utc_now_iso()
    save_manifest(manifest)
    store.close()
    if pending:
        unload_ollama_model(client, embed_model)
    return indexed, skipped, removed


def main() -> None:
    args = parse_args()
    collection_name = args.collection or collection_name_for(args.embed_model)
    indexed, skipped, removed = ingest_documents(
        collection_name, args.embed_model, args.ollama_host, args.limit, args.force
    )
    print(f"ingest complete: indexed={indexed} skipped={skipped} removed={removed}")


if __name__ == "__main__":
    main()
