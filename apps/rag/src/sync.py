from __future__ import annotations

import argparse
from pathlib import Path

from common import (
    DEFAULT_SCRAPER_OUTPUT_DIR,
    build_imported_document,
    document_record_payload,
    ensure_directories,
    load_json,
    load_manifest,
    save_manifest,
    utc_now_iso,
    validate_sidecar,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync scraper metadata into the local manifest.")
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=DEFAULT_SCRAPER_OUTPUT_DIR,
        help="Directory that contains scraper .json sidecars and .txt files.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Optional limit for imported documents.")
    return parser.parse_args()


def sync_documents(source_dir: Path, limit: int | None) -> tuple[int, int]:
    ensure_directories()
    manifest = load_manifest()
    imported = 0
    skipped = 0

    sidecar_paths = sorted(source_dir.glob("*.json"))
    if limit is not None:
        sidecar_paths = sidecar_paths[:limit]

    for sidecar_path in sidecar_paths:
        sidecar = load_json(sidecar_path)
        validate_sidecar(sidecar, sidecar_path)

        txt_path = Path(sidecar["outputPath"])
        if not txt_path.exists():
            raise FileNotFoundError(f"Missing text file for {sidecar_path}: {txt_path}")

        document = build_imported_document(sidecar, sidecar_path)
        existing = manifest["documents"].get(document.doc_id)
        unchanged = existing and existing.get("content_hash") == document.content_hash

        record = document_record_payload(document)
        if existing:
            for key in ("last_ingested_hash", "chunk_count", "indexed_at", "collection"):
                if key in existing:
                    record[key] = existing[key]
        record["imported_at"] = utc_now_iso()
        record["status"] = "synced"
        manifest["documents"][document.doc_id] = record

        if unchanged:
            skipped += 1
        else:
            imported += 1

    manifest["last_sync_at"] = utc_now_iso()
    save_manifest(manifest)
    return imported, skipped


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.expanduser().resolve()
    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory does not exist: {source_dir}")

    imported, skipped = sync_documents(source_dir, args.limit)
    print(f"sync complete: imported_or_updated={imported} unchanged={skipped}")


if __name__ == "__main__":
    main()
