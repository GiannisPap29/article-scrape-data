from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "data"
STATE_DIR = DATA_DIR / "state"
VECTORS_DB_PATH = STATE_DIR / "vectors.db"
MANIFEST_PATH = STATE_DIR / "manifest.json"
MANIFEST_SCHEMA_VERSION = 1

# The scraper sidecar is the cross-app contract. Only accept versions whose
# required fields are understood by the manifest importer and Chroma ingester.
SUPPORTED_SCRAPER_METADATA_VERSIONS = {2, 3, 4}
DEFAULT_SCRAPER_OUTPUT_DIR = DATA_DIR / "output"

# Embeddings run through the same local Ollama server as generation.
# embeddinggemma: 768-dim vectors, 2048-token context, so a ~1400-char chunk
# (~350-450 tokens) is embedded in full. The old MiniLM model cut input at 256
# tokens, silently dropping about half of every 2200-char chunk.
DEFAULT_EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "embeddinggemma")
DEFAULT_LLM = os.getenv("RAG_MODEL", "gemma3:1b")
DEFAULT_OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")

# Keep model memory small: this machine shares RAM with the editor, and Ollama
# reserves KV cache for the whole context window (gemma3 allows 32k tokens).
# Prompts here need ~1-3k tokens. Models unload shortly after the last call.
TAG_NUM_CTX = 2048
ANSWER_NUM_CTX = 4096
OLLAMA_KEEP_ALIVE = "2m"

# Bump when chunking changes so ingest re-indexes every document.
CHUNK_VERSION = 2
CHUNK_TARGET_CHARS = 1400
CHUNK_OVERLAP_CHARS = 150

# Retrieval prompts recommended per embedding model family. Models not listed
# get the raw text.
EMBED_PROMPTS = {
    "embeddinggemma": {
        "document": "title: {title} | text: {text}",
        "query": "task: search result | query: {text}",
    },
    "nomic-embed-text": {
        "document": "search_document: {title}\n\n{text}",
        "query": "search_query: {text}",
    },
}

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
    freedium_url: str | None = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_directories() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)


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
        # The manifest is deliberately local runtime state, not source data.
        # data/output remains the source of truth and can recreate this file.
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


def resolve_text_path(sidecar: dict[str, Any], sidecar_path: Path) -> Path:
    """Locate the .txt body for a sidecar.

    v4 sidecars store a bare file name relative to the sidecar's folder; v2/v3
    stored absolute host paths. Fall back to the sidecar's folder whenever the
    recorded path does not exist (e.g. data/output was moved).
    """
    recorded = Path(sidecar["outputPath"])
    if not recorded.is_absolute():
        return sidecar_path.parent / recorded
    if recorded.exists():
        return recorded
    return sidecar_path.parent / recorded.name


def build_imported_document(sidecar: dict[str, Any], sidecar_path: Path) -> ImportedDocument:
    return ImportedDocument(
        doc_id=sidecar["docId"],
        title=sidecar["title"],
        source_url=sidecar["sourceUrl"],
        freedium_url=sidecar.get("freediumUrl") or (sidecar.get("freedium") or {}).get("url"),
        content_hash=sidecar["contentHash"],
        scraped_at=sidecar["scrapedAt"],
        batch_id=sidecar["batchId"],
        tags=[str(tag) for tag in sidecar.get("tags", [])],
        source_output_path=str(resolve_text_path(sidecar, sidecar_path)),
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
        "freedium_url": document.freedium_url,
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


def collection_name_for(embed_model: str) -> str:
    """One vector collection per embedding model: vector sizes differ between
    models, so switching models must never write into an existing collection."""
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", embed_model).strip("-._") or "default"
    return f"articles-{slug}"[:63]


def format_for_embedding(embed_model: str, kind: str, text: str, title: str = "none") -> str:
    family = embed_model.split(":", 1)[0].rsplit("/", 1)[-1]
    template = EMBED_PROMPTS.get(family, {}).get(kind)
    return template.format(title=title or "none", text=text) if template else text


def embed_texts(client: Any, embed_model: str, texts: list[str], batch_size: int = 16) -> list[list[float]]:
    """Embed through Ollama in small batches so one long article cannot exceed
    request limits or spike memory."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        response = client.embed(
            model=embed_model, input=texts[start : start + batch_size], keep_alive=OLLAMA_KEEP_ALIVE
        )
        vectors.extend([list(vector) for vector in response["embeddings"]])
    return vectors


def ollama_client(host: str) -> Any:
    from ollama import Client

    return Client(host=host)


def unload_ollama_model(client: Any, model: str) -> None:
    """Free the model's RAM right away (keep_alive=0) so the next pipeline step
    never has two models resident at once on this memory-tight machine."""
    # Generation models unload via generate; embedding-only models reject
    # generate, so fall back to an empty embed call.
    for unload in (
        lambda: client.generate(model=model, prompt="", keep_alive=0),
        lambda: client.embed(model=model, input=[], keep_alive=0),
    ):
        try:
            unload()
            return
        except Exception:  # noqa: BLE001 - best effort; Ollama unloads on its own timer anyway
            continue


def ensure_ollama_model(client: Any, model: str, purpose: str) -> None:
    """Fail early with an actionable message instead of mid-run."""
    try:
        installed = {entry["model"] for entry in client.list()["models"]}
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        raise SystemExit(
            f"Cannot reach Ollama ({exc}). Start it with `ollama serve` and retry."
        ) from exc

    wanted = model if ":" in model else f"{model}:latest"
    if model not in installed and wanted not in installed:
        raise SystemExit(f"Ollama {purpose} model '{model}' is not installed. Run: ollama pull {model}")


def chunk_text(text: str, target_chars: int = CHUNK_TARGET_CHARS, overlap_chars: int = CHUNK_OVERLAP_CHARS) -> list[str]:
    """Split article text into retrieval-sized chunks while preserving paragraph boundaries."""
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
        # Seed the next chunk with trailing context so answers can bridge a
        # paragraph boundary without relying on adjacent chunk retrieval.
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
    """Convert optional/list metadata into scalar Chroma-compatible values."""
    cleaned: dict[str, Any] = {}
    for key, value in metadata.items():
        if value is None:
            continue
        if isinstance(value, list):
            cleaned[key] = ", ".join(str(item) for item in value)
        else:
            cleaned[key] = value
    return cleaned
