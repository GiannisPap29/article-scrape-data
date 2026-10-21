from __future__ import annotations

import argparse
import json

import vectorstore
from common import DEFAULT_EMBED_MODEL, VECTORS_DB_PATH, collection_name_for

DEFAULT_COLLECTION = collection_name_for(DEFAULT_EMBED_MODEL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect the local sqlite-vec article index.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("collections", help="List collections (one per embedding model) with chunk counts.")

    doc_parser = subparsers.add_parser("doc", help="Show all chunks for one document id.")
    doc_parser.add_argument("doc_id")
    doc_parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    store = vectorstore.open_store(VECTORS_DB_PATH)
    try:
        if args.command == "collections":
            for name, model, dimensions, chunks in vectorstore.list_collections(store):
                marker = " (default)" if name == DEFAULT_COLLECTION else ""
                print(f"{name}\t{chunks} chunks\t{model}\t{dimensions} dims{marker}")
        elif args.command == "doc":
            print(json.dumps(vectorstore.get_chunks(store, args.collection, doc_id=args.doc_id), indent=2, ensure_ascii=False))
    finally:
        store.close()


if __name__ == "__main__":
    main()
