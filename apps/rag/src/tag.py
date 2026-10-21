from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

from common import (
    DEFAULT_LLM,
    DEFAULT_OLLAMA_HOST,
    OLLAMA_KEEP_ALIVE,
    TAG_NUM_CTX,
    ensure_ollama_model,
    load_manifest,
    ollama_client,
    save_manifest,
    unload_ollama_model,
)

# Freedium stopped exposing Medium tags (2026-06). Tags generated here live in
# the RAG manifest (`auto_tags`), never in the scraper's sidecars, and are only
# used when a document has no scraped tags.
TAG_SCHEMA = {
    "type": "object",
    "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
    "required": ["tags"],
}
MAX_TAGS = 6
TAG_MAX_OUTPUT_TOKENS = 120
EXCERPT_CHARS = 1200


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate topic tags for untagged documents with a local Ollama model.")
    parser.add_argument("--model", default=DEFAULT_LLM, help="Ollama model used for tagging.")
    parser.add_argument("--ollama-host", default=DEFAULT_OLLAMA_HOST, help="Ollama host URL.")
    parser.add_argument("--limit", type=int, default=None, help="Optional limit for documents to tag.")
    parser.add_argument("--force", action="store_true", help="Re-tag documents that already have auto tags.")
    return parser.parse_args()


def build_prompt(record: dict[str, Any], body: str) -> str:
    return f"""Give 3 to {MAX_TAGS} topic tags for this technical article.
Tags are lowercase, 1 to 3 words, specific (for example: "golang", "system design",
"postgresql", "kubernetes", "career"), and describe what the article is about.
Answer as JSON: {{"tags": [...]}}

Title: {record["title"]}
Summary: {record.get("excerpt") or "none"}

Article start:
{body[:EXCERPT_CHARS]}
"""


def normalize_tags(raw: Any) -> list[str]:
    tags: list[str] = []
    for value in raw if isinstance(raw, list) else []:
        tag = re.sub(r"\s+", " ", str(value).strip().lstrip("#").lower())
        tag = re.sub(r"[^\w .+#/-]", "", tag).strip()
        if tag and len(tag) <= 30 and tag not in tags:
            tags.append(tag)
    return tags[:MAX_TAGS]


def tag_documents(model: str, ollama_host: str, limit: int | None, force: bool) -> tuple[int, int]:
    manifest = load_manifest()
    client = ollama_client(ollama_host)
    ensure_ollama_model(client, model, "tagging")

    pending = [
        record
        for record in sorted(manifest["documents"].values(), key=lambda item: item["doc_id"])
        if record.get("status") != "removed"
        and not record.get("tags")
        and (force or not record.get("auto_tags") or record.get("auto_tags_model") != model)
    ]
    if limit is not None:
        pending = pending[:limit]

    print(f"tag: {len(pending)} untagged document(s) with {model}", flush=True)
    tagged = 0
    failed = 0
    started = time.monotonic()

    for position, record in enumerate(pending, start=1):
        text_path = Path(record["source_output_path"])
        try:
            body = text_path.read_text(encoding="utf-8")
            response = client.generate(
                model=model,
                prompt=build_prompt(record, body),
                format=TAG_SCHEMA,
                # num_predict caps the answer: with JSON-constrained output small
                # models can otherwise keep emitting whitespace indefinitely.
                options={"temperature": 0, "num_ctx": TAG_NUM_CTX, "num_predict": TAG_MAX_OUTPUT_TOKENS},
                keep_alive=OLLAMA_KEEP_ALIVE,
            )
            tags = normalize_tags(json.loads(response["response"]).get("tags"))
        except Exception as exc:  # noqa: BLE001 - one bad doc must not stop the run
            failed += 1
            print(f"tag: failed {record['doc_id']} ({record['title'][:50]}): {exc}")
            continue

        if not tags:
            failed += 1
            print(f"tag: no usable tags for {record['doc_id']} ({record['title'][:50]})")
            continue

        record["auto_tags"] = tags
        record["auto_tags_model"] = model
        tagged += 1
        save_manifest(manifest)
        if position % 10 == 0 or position == len(pending):
            elapsed = time.monotonic() - started
            print(f"tag: {position}/{len(pending)} done ({elapsed:.0f}s)", flush=True)

    save_manifest(manifest)
    unload_ollama_model(client, model)
    return tagged, failed


def main() -> None:
    args = parse_args()
    tagged, failed = tag_documents(args.model, args.ollama_host, args.limit, args.force)
    print(f"tag complete: tagged={tagged} failed={failed}")


if __name__ == "__main__":
    main()
