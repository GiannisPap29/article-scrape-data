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
    resolve_text_path,
    save_manifest,
    utc_now_iso,
    validate_sidecar,
)

# Manifest fields owned by ingest/tag steps; a sync must carry them over.
PRESERVED_FIELDS = (
    "last_ingested_hash",
    "chunk_count",
    "chunk_version",
    "indexed_at",
    "collection",
    "embed_model",
    "auto_tags",
    "auto_tags_model",
    "status",
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


def sync_documents(source_dir: Path, limit: int | None) -> dict[str, int]:
    ensure_directories()
    manifest = load_manifest()
    documents = manifest["documents"]
    counts = {"new_or_changed": 0, "unchanged": 0, "invalid": 0, "removed": 0}
    seen: set[str] = set()

    sidecar_paths = sorted(source_dir.glob("*.json"))
    if limit is not None:
        sidecar_paths = sidecar_paths[:limit]

    for sidecar_path in sidecar_paths:
        # One broken sidecar must not stop the whole sync: report and continue.
        try:
            sidecar = load_json(sidecar_path)
            validate_sidecar(sidecar, sidecar_path)
            txt_path = resolve_text_path(sidecar, sidecar_path)
            if not txt_path.exists():
                raise FileNotFoundError(f"missing text file {txt_path.name}")
            document = build_imported_document(sidecar, sidecar_path)
        except Exception as exc:  # noqa: BLE001 - reported, then skipped
            counts["invalid"] += 1
            print(f"sync: skipped {sidecar_path.name}: {exc}")
            continue

        seen.add(document.doc_id)
        existing = documents.get(document.doc_id)
        unchanged = bool(existing) and existing.get("content_hash") == document.content_hash

        # Preserve ingest/tag bookkeeping across sync runs. A metadata-only sync
        # should not make an already indexed, unchanged document look new.
        record = document_record_payload(document)
        if existing:
            for key in PRESERVED_FIELDS:
                if key in existing:
                    record[key] = existing[key]
        if not unchanged or record.get("status") in {None, "removed", "missing_source_text", "empty_source_text"}:
            record["status"] = "synced"
        record["imported_at"] = utc_now_iso()
        documents[document.doc_id] = record
        counts["unchanged" if unchanged else "new_or_changed"] += 1

    # Documents whose sidecar is gone from data/output: ingest deletes their
    # chunks and then drops the record. Skipped when --limit hides the rest.
    if limit is None:
        for doc_id, record in documents.items():
            if doc_id not in seen and record.get("status") != "removed":
                record["status"] = "removed"
                counts["removed"] += 1

    manifest["last_sync_at"] = utc_now_iso()
    save_manifest(manifest)
    return counts


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.expanduser().resolve()
    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory does not exist: {source_dir}")

    counts = sync_documents(source_dir, args.limit)
    print(
        "sync complete: "
        f"new_or_changed={counts['new_or_changed']} unchanged={counts['unchanged']} "
        f"invalid={counts['invalid']} marked_removed={counts['removed']}"
    )


if __name__ == "__main__":
    main()
