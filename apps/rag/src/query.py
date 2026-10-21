from __future__ import annotations

import argparse

import vectorstore
from common import (
    ANSWER_NUM_CTX,
    VECTORS_DB_PATH,
    OLLAMA_KEEP_ALIVE,
    DEFAULT_EMBED_MODEL,
    DEFAULT_LLM,
    DEFAULT_OLLAMA_HOST,
    collection_name_for,
    embed_texts,
    ensure_ollama_model,
    format_for_embedding,
    ollama_client,
    unload_ollama_model,
)

MAX_CHUNKS_PER_DOC = 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search the local vector index and ask a local Ollama model for a grounded answer.")
    parser.add_argument("question", help="Question to answer against the local corpus.")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help="Ollama embedding model name.")
    parser.add_argument(
        "--collection",
        default=None,
        help="Vector collection name (default: derived from the embedding model).",
    )
    parser.add_argument("--model", default=DEFAULT_LLM, help="Ollama model name for the answer.")
    parser.add_argument("--top-k", type=int, default=5, help="Number of retrieved chunks.")
    parser.add_argument("--ollama-host", default=DEFAULT_OLLAMA_HOST, help="Ollama host URL.")
    parser.add_argument("--sources-only", action="store_true", help="Print retrieved sources without calling the LLM.")
    return parser.parse_args()


def format_sources(documents: list[str], metadatas: list[dict]) -> str:
    sections = []
    for index, (document, metadata) in enumerate(zip(documents, metadatas, strict=False), start=1):
        sections.append(
            "\n".join(
                [
                    f"[S{index}] {metadata.get('title', 'Untitled')}",
                    f"author: {metadata.get('author', 'unknown')}",
                    f"url: {metadata.get('source_url', 'unknown')}",
                    f"file: {metadata.get('filename', 'unknown')}",
                    f"chunk_index: {metadata.get('chunk_index', '?')}",
                    "snippet:",
                    document.strip(),
                ]
            )
        )
    return "\n\n".join(sections)


def build_prompt(question: str, context: str) -> str:
    # Keep the generation step grounded: the model should answer from retrieved
    # chunks and surface insufficiency instead of filling gaps from memory.
    return f"""You are a local programming research assistant.

Answer the user's question using only the provided sources.
If the sources are insufficient, say that clearly.
When you make a claim that comes from a source, cite it with [S1], [S2], etc.
Prefer concrete, practical answers over generic ones.

Question:
{question}

Sources:
{context}
"""


def diversify(documents: list[str], metadatas: list[dict], top_k: int) -> tuple[list[str], list[dict]]:
    """Keep the best-ranked chunks but at most MAX_CHUNKS_PER_DOC per article,
    so one long article cannot crowd out every other source."""
    kept_documents: list[str] = []
    kept_metadatas: list[dict] = []
    per_doc: dict[str, int] = {}
    for document, metadata in zip(documents, metadatas, strict=False):
        doc_id = str(metadata.get("doc_id"))
        if per_doc.get(doc_id, 0) >= MAX_CHUNKS_PER_DOC:
            continue
        per_doc[doc_id] = per_doc.get(doc_id, 0) + 1
        kept_documents.append(document)
        kept_metadatas.append(metadata)
        if len(kept_documents) >= top_k:
            break
    return kept_documents, kept_metadatas


def main() -> None:
    args = parse_args()
    collection_name = args.collection or collection_name_for(args.embed_model)
    client = ollama_client(args.ollama_host)
    ensure_ollama_model(client, args.embed_model, "embedding")

    store = vectorstore.open_store(VECTORS_DB_PATH)
    query_embedding = embed_texts(client, args.embed_model, [format_for_embedding(args.embed_model, "query", args.question)])[0]
    try:
        hits = vectorstore.query(store, collection_name, query_embedding, args.top_k * 3)
    except LookupError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        store.close()

    documents, metadatas = diversify([hit[0] for hit in hits], [hit[1] for hit in hits], args.top_k)
    if not documents:
        raise SystemExit("The collection is empty or no matching documents were found.")

    context = format_sources(documents, metadatas)

    if args.sources_only:
        print(context)
        return

    ensure_ollama_model(client, args.model, "answer")
    # Only the question needed embedding; free that model before loading the
    # answer model so both are never resident together.
    unload_ollama_model(client, args.embed_model)
    response = client.generate(
        model=args.model,
        prompt=build_prompt(args.question, context),
        options={"num_ctx": ANSWER_NUM_CTX},
        keep_alive=OLLAMA_KEEP_ALIVE,
    )

    print(response["response"].strip())
    print("\nSources:")
    for index, metadata in enumerate(metadatas, start=1):
        print(
            f"[S{index}] {metadata.get('title')} "
            f"({metadata.get('source_url')}) "
            f"[{metadata.get('filename')}]"
        )


if __name__ == "__main__":
    main()
