from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "data"
STATE_DIR = DATA_DIR / "state"
CHROMA_DIR = DATA_DIR / "chroma"
MANIFEST_PATH = STATE_DIR / "manifest.json"
MANIFEST_SCHEMA_VERSION = 1
SUPPORTED_SCRAPER_METADATA_VERSIONS = {2, 3}
DEFAULT_SCRAPER_OUTPUT_DIR = DATA_DIR / "output"

REQUIRED_SIDECAR_FIELDS = {
    "docId",
    "contentHash",
    "sourceUrl",
    "scrapedAt",
    "title",
    "tags",
    "outputPath",
    "metadataPath",
    "batchId",
    "scraperMetadataVersion",
}


@dataclass
class ImportedDocument:
    doc_id: str
    title: str
    source_url: str
    content_hash: str
    scraped_at: str
    batch_id: str
    tags: list[str]
    source_output_path: str
    source_metadata_path: str
    scraper_metadata_version: int
    excerpt: str | None = None
    author: str | None = None
    site_name: str | None = None
    published_at: str | None = None
    language: str | None = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_directories() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=True)
        handle.write("\n")


def load_manifest() -> dict[str, Any]:
    ensure_directories()
    if not MANIFEST_PATH.exists():
        return {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "last_sync_at": None,
            "last_ingest_at": None,
            "documents": {},
        }

    manifest = load_json(MANIFEST_PATH)
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported manifest schema version: {manifest.get('schema_version')}. "
            f"Expected {MANIFEST_SCHEMA_VERSION}."
        )
    manifest.setdefault("documents", {})
    manifest.setdefault("last_sync_at", None)
    manifest.setdefault("last_ingest_at", None)
    return manifest


def save_manifest(manifest: dict[str, Any]) -> None:
    manifest["schema_version"] = MANIFEST_SCHEMA_VERSION
    write_json(MANIFEST_PATH, manifest)


def validate_sidecar(sidecar: dict[str, Any], sidecar_path: Path) -> None:
    missing = REQUIRED_SIDECAR_FIELDS - set(sidecar)
    if missing:
        raise ValueError(f"{sidecar_path} is missing required fields: {sorted(missing)}")

    version = sidecar.get("scraperMetadataVersion")
    if version not in SUPPORTED_SCRAPER_METADATA_VERSIONS:
        raise ValueError(
            f"{sidecar_path} has scraperMetadataVersion={version}; "
            f"expected one of {sorted(SUPPORTED_SCRAPER_METADATA_VERSIONS)}"
        )

    if not isinstance(sidecar.get("tags"), list):
        raise ValueError(f"{sidecar_path} field 'tags' must be a list")


def build_imported_document(sidecar: dict[str, Any], sidecar_path: Path) -> ImportedDocument:
    return ImportedDocument(
        doc_id=sidecar["docId"],
        title=sidecar["title"],
        source_url=sidecar["sourceUrl"],
        content_hash=sidecar["contentHash"],
        scraped_at=sidecar["scrapedAt"],
        batch_id=sidecar["batchId"],
        tags=[str(tag) for tag in sidecar.get("tags", [])],
        source_output_path=sidecar["outputPath"],
        source_metadata_path=str(sidecar_path),
        scraper_metadata_version=int(sidecar["scraperMetadataVersion"]),
        excerpt=sidecar.get("excerpt"),
        author=sidecar.get("author"),
        site_name=sidecar.get("siteName"),
        published_at=sidecar.get("publishedAt"),
        language=sidecar.get("language"),
    )


def document_record_payload(document: ImportedDocument) -> dict[str, Any]:
    return {
        "doc_id": document.doc_id,
        "title": document.title,
        "source_url": document.source_url,
        "content_hash": document.content_hash,
        "scraped_at": document.scraped_at,
        "batch_id": document.batch_id,
        "tags": document.tags,
        "excerpt": document.excerpt,
        "author": document.author,
        "site_name": document.site_name,
        "published_at": document.published_at,
        "language": document.language,
        "source_output_path": document.source_output_path,
        "source_metadata_path": document.source_metadata_path,
        "scraper_metadata_version": document.scraper_metadata_version,
    }


def chunk_text(text: str, target_chars: int = 2200, overlap_chars: int = 250) -> list[str]:
    paragraphs = [part.strip() for part in text.split("\n\n") if part.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if not current:
            return
        chunk = "\n\n".join(current).strip()
        if chunk:
            chunks.append(chunk)
        if overlap_chars <= 0:
            current = []
            current_len = 0
            return
        overlap_seed = chunk[-overlap_chars:].strip()
        current = [overlap_seed] if overlap_seed else []
        current_len = len(overlap_seed)

    for paragraph in paragraphs:
        if len(paragraph) > target_chars:
            if current:
                flush()
            start = 0
            step = max(target_chars - overlap_chars, 1)
            while start < len(paragraph):
                piece = paragraph[start : start + target_chars].strip()
                if piece:
                    chunks.append(piece)
                start += step
            current = []
            current_len = 0
            continue

        projected = current_len + len(paragraph) + (2 if current else 0)
        if current and projected > target_chars:
            flush()
        current.append(paragraph)
        current_len += len(paragraph) + (2 if len(current) > 1 else 0)

    flush()
    return chunks


def compact_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    cleaned: dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, list):
            cleaned[key] = ", ".join(str(item) for item in value)
        else:
            cleaned[key] = value
    return cleaned
