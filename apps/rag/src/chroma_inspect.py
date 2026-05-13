from __future__ import annotations

import argparse
import json

import chromadb

from common import CHROMA_DIR

DEFAULT_COLLECTION = "documents"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect the local Chroma collection.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    count_parser = subparsers.add_parser("count", help="Show total collection count.")
    count_parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Chroma collection name.")

    peek_parser = subparsers.add_parser("peek", help="Show a sample of stored records.")
    peek_parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Chroma collection name.")
    peek_parser.add_argument("--limit", type=int, default=3, help="Number of records to print.")

    doc_parser = subparsers.add_parser("doc", help="Show all chunks for one document id.")
    doc_parser.add_argument("doc_id", help="Document id to inspect.")
    doc_parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Chroma collection name.")

    return parser.parse_args()


def get_collection(name: str):
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    try:
        return client.get_collection(name)
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        raise SystemExit(
            f"Chroma collection '{name}' does not exist yet. Run apps/rag/src/ingest.py first."
        ) from exc


def print_json(payload: object) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=True))


def command_count(collection_name: str) -> None:
    collection = get_collection(collection_name)
    print(collection.count())


def command_peek(collection_name: str, limit: int) -> None:
    collection = get_collection(collection_name)
    print_json(collection.peek(limit))


def command_doc(collection_name: str, doc_id: str) -> None:
    collection = get_collection(collection_name)
    results = collection.get(where={"doc_id": doc_id})
    print_json(results)


def main() -> None:
    args = parse_args()
    if args.command == "count":
        command_count(args.collection)
        return
    if args.command == "peek":
        command_peek(args.collection, args.limit)
        return
    if args.command == "doc":
        command_doc(args.collection, args.doc_id)
        return
    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
