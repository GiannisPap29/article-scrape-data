from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import chromadb
from sentence_transformers import SentenceTransformer

from common import CHROMA_DIR, chunk_text, compact_metadata, load_manifest, save_manifest, utc_now_iso

DEFAULT_COLLECTION = "documents"
DEFAULT_EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chunk, embed, and upsert scraper docs into Chroma.")
    parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Chroma collection name.")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help="SentenceTransformer model name.")
    parser.add_argument("--limit", type=int, default=None, help="Optional limit for documents to ingest.")
    parser.add_argument("--force", action="store_true", help="Re-ingest all documents regardless of manifest state.")
    return parser.parse_args()


def build_chunk_metadata(record: dict[str, Any], chunk_index: int) -> dict[str, Any]:
    return compact_metadata(
        {
            "doc_id": record["doc_id"],
            "chunk_index": chunk_index,
            "content_hash": record["content_hash"],
            "source_url": record["source_url"],
            "title": record["title"],
            "tags": record.get("tags", []),
            "scraped_at": record["scraped_at"],
            "published_at": record.get("published_at"),
            "language": record.get("language"),
            "author": record.get("author"),
            "site_name": record.get("site_name"),
            "filename": Path(record["source_output_path"]).name,
            "source_path": record["source_output_path"],
        }
    )


def ingest_documents(collection_name: str, embed_model: str, limit: int | None, force: bool) -> tuple[int, int]:
    manifest = load_manifest()
    docs = sorted(manifest["documents"].values(), key=lambda item: item["doc_id"])
    if limit is not None:
        docs = docs[:limit]

    try:
        model = SentenceTransformer(embed_model)
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        raise SystemExit(
            "Failed to load the embedding model. "
            "Pass a local model path with --embed-model or run once with network access "
            f"to cache it first. Requested model: {embed_model}\nOriginal error: {exc}"
        ) from exc

    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_or_create_collection(name=collection_name)

    indexed = 0
    skipped = 0

    for record in docs:
        if record.get("status") not in {"synced", "indexed"}:
            skipped += 1
            continue

        if not force and record.get("last_ingested_hash") == record["content_hash"]:
            skipped += 1
            continue

        text_path = Path(record["source_output_path"])
        if not text_path.exists():
            record["status"] = "missing_source_text"
            skipped += 1
            continue

        text = text_path.read_text(encoding="utf-8").strip()
        if not text:
            record["status"] = "empty_source_text"
            skipped += 1
            continue

        chunks = chunk_text(text)
        if not chunks:
            record["status"] = "empty_chunks"
            skipped += 1
            continue

        embeddings = model.encode(chunks, normalize_embeddings=True).tolist()
        ids = [f"{record['doc_id']}:chunk:{chunk_index}:{record['content_hash'][:12]}" for chunk_index in range(len(chunks))]
        metadatas = [build_chunk_metadata(record, chunk_index) for chunk_index in range(len(chunks))]

        collection.delete(where={"doc_id": record["doc_id"]})
        collection.add(ids=ids, documents=chunks, embeddings=embeddings, metadatas=metadatas)

        record["chunk_count"] = len(chunks)
        record["indexed_at"] = utc_now_iso()
        record["last_ingested_hash"] = record["content_hash"]
        record["collection"] = collection_name
        record["status"] = "indexed"
        indexed += 1

    manifest["last_ingest_at"] = utc_now_iso()
    save_manifest(manifest)
    return indexed, skipped


def main() -> None:
    args = parse_args()
    indexed, skipped = ingest_documents(args.collection, args.embed_model, args.limit, args.force)
    print(f"ingest complete: indexed={indexed} skipped={skipped}")


if __name__ == "__main__":
    main()
