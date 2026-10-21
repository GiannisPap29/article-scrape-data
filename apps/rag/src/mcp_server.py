"""MCP server: lets an AI assistant (Claude Code, Claude Desktop, ...) search and
read the local Medium article library.

Read-only. Search uses the same sqlite-vec index and Ollama embedding model as
`make rag-ask`; there is deliberately no "answer" tool, because the calling
assistant writes the answer itself from the returned articles.

Run over stdio (how MCP hosts launch it):
    venv/bin/python apps/rag/src/mcp_server.py
"""
from __future__ import annotations

import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel

import vectorstore
from common import (
    DEFAULT_EMBED_MODEL,
    VECTORS_DB_PATH,
    DEFAULT_OLLAMA_HOST,
    collection_name_for,
    embed_texts,
    ensure_ollama_model,
    format_for_embedding,
    load_manifest,
    ollama_client,
)

# One line per Ollama HTTP call is noise in an MCP host's server log.
logging.getLogger("httpx").setLevel(logging.WARNING)

MAX_SEARCH_RESULTS = 20
MAX_LIST_RESULTS = 100
SNIPPET_CHARS = 600

mcp = MCPServer(
    "medium-library",
    instructions=(
        "Local library of saved Medium articles (software engineering, Go, system design, AI, ...). "
        "Use search_articles for questions about topics, then get_article to read the best matches in full. "
        "Cite articles by title and source_url."
    ),
)


class ArticleSummary(BaseModel):
    doc_id: str
    title: str
    author: str | None = None
    source_url: str
    published_at: str | None = None
    tags: list[str] = []
    excerpt: str | None = None


class SearchHit(ArticleSummary):
    score: float
    snippet: str


class SearchResults(BaseModel):
    query: str
    hits: list[SearchHit]
    indexed_documents: int


class Article(ArticleSummary):
    site_name: str | None = None
    freedium_url: str | None = None
    body_markdown: str


class LibraryStats(BaseModel):
    documents: int
    indexed: int
    top_tags: list[tuple[str, int]]
    top_authors: list[tuple[str, int]]


def _documents() -> dict[str, dict[str, Any]]:
    return {doc_id: record for doc_id, record in load_manifest()["documents"].items() if record.get("status") != "removed"}


def _tags(record: dict[str, Any]) -> list[str]:
    # Real Medium tags first; locally generated ones (make rag-tag) otherwise.
    return list(record.get("tags") or record.get("auto_tags") or [])


def _summary(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "doc_id": record["doc_id"],
        "title": record["title"],
        "author": record.get("author"),
        "source_url": record["source_url"],
        "published_at": record.get("published_at"),
        "tags": _tags(record),
        "excerpt": record.get("excerpt"),
    }


@mcp.tool(title="Search saved articles")
def search_articles(query: str, limit: int = 5) -> SearchResults:
    """Semantic search over the saved articles. Returns the best-matching passage
    per article, most relevant first. Use get_article(doc_id) to read one fully."""
    limit = max(1, min(limit, MAX_SEARCH_RESULTS))
    client = ollama_client(DEFAULT_OLLAMA_HOST)
    try:
        ensure_ollama_model(client, DEFAULT_EMBED_MODEL, "embedding")
    except SystemExit as exc:  # helper exits for CLIs; report it as a tool error here
        raise ToolError(str(exc)) from exc

    vector = embed_texts(client, DEFAULT_EMBED_MODEL, [format_for_embedding(DEFAULT_EMBED_MODEL, "query", query)])[0]
    store = vectorstore.open_store(VECTORS_DB_PATH)
    try:
        results = vectorstore.query(store, collection_name_for(DEFAULT_EMBED_MODEL), vector, limit * 4)
    except LookupError as exc:
        raise ToolError("The article index is empty. Run `make rag-sync rag-ingest` first.") from exc
    finally:
        store.close()

    documents = _documents()
    hits: list[SearchHit] = []
    seen: set[str] = set()
    for text, metadata, distance in results:
        doc_id = str(metadata.get("doc_id"))
        record = documents.get(doc_id)
        if doc_id in seen or record is None:
            continue
        seen.add(doc_id)
        # Cosine distance: score 1.0 = same direction, 0 = unrelated.
        hits.append(SearchHit(**_summary(record), score=round(1 - distance, 4), snippet=text[:SNIPPET_CHARS]))
        if len(hits) >= limit:
            break

    indexed = sum(1 for record in documents.values() if record.get("status") == "indexed")
    return SearchResults(query=query, hits=hits, indexed_documents=indexed)


@mcp.tool(title="Read a saved article")
def get_article(doc_id: str) -> Article:
    """Full article (Markdown body) and metadata for a doc_id from search_articles or list_articles."""
    record = _documents().get(doc_id)
    if record is None:
        raise ToolError(f"No article with doc_id {doc_id!r}. Use search_articles or list_articles to find ids.")
    text_path = Path(record["source_output_path"])
    if not text_path.exists():
        raise ToolError(f"The text file for {doc_id!r} is missing ({text_path.name}). Run `make rag-sync`.")
    return Article(
        **_summary(record),
        site_name=record.get("site_name"),
        freedium_url=record.get("freedium_url"),
        body_markdown=text_path.read_text(encoding="utf-8"),
    )


@mcp.tool(title="List saved articles")
def list_articles(tag: str | None = None, author: str | None = None, title_contains: str | None = None, limit: int = 20) -> list[ArticleSummary]:
    """Browse articles by tag, author, or words in the title (all optional, case-insensitive), newest first."""
    limit = max(1, min(limit, MAX_LIST_RESULTS))
    wanted_tag = tag.lower().strip() if tag else None
    matches = []
    for record in _documents().values():
        if wanted_tag and wanted_tag not in [value.lower() for value in _tags(record)]:
            continue
        if author and author.lower() not in (record.get("author") or "").lower():
            continue
        if title_contains and title_contains.lower() not in record["title"].lower():
            continue
        matches.append(record)
    matches.sort(key=lambda record: record.get("published_at") or record.get("scraped_at") or "", reverse=True)
    return [ArticleSummary(**_summary(record)) for record in matches[:limit]]


@mcp.tool(title="Library statistics")
def library_stats() -> LibraryStats:
    """How many articles are saved and indexed, plus the most common tags and authors."""
    documents = _documents()
    tags = Counter(tag for record in documents.values() for tag in _tags(record))
    authors = Counter(record["author"] for record in documents.values() if record.get("author"))
    return LibraryStats(
        documents=len(documents),
        indexed=sum(1 for record in documents.values() if record.get("status") == "indexed"),
        top_tags=tags.most_common(25),
        top_authors=authors.most_common(15),
    )


if __name__ == "__main__":
    # stdout carries the MCP protocol; anything else must go to stderr.
    print(f"medium-library MCP server (embed model: {DEFAULT_EMBED_MODEL})", file=sys.stderr)
    mcp.run()
