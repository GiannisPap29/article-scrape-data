from __future__ import annotations

import argparse
import os

import chromadb
from ollama import Client
from sentence_transformers import SentenceTransformer

from common import CHROMA_DIR

DEFAULT_COLLECTION = "documents"
DEFAULT_EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_LLM = "gemma4:e4b"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query Chroma and ask Gemma for a grounded answer.")
    parser.add_argument("question", help="Question to answer against the local corpus.")
    parser.add_argument("--collection", default=DEFAULT_COLLECTION, help="Chroma collection name.")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help="SentenceTransformer model name.")
    parser.add_argument("--model", default=DEFAULT_LLM, help="Ollama model name.")
    parser.add_argument("--top-k", type=int, default=4, help="Number of retrieved chunks.")
    parser.add_argument(
        "--ollama-host",
        default=os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434"),
        help="Ollama host URL.",
    )
    parser.add_argument("--sources-only", action="store_true", help="Print retrieved sources without calling Gemma.")
    return parser.parse_args()


def format_sources(documents: list[str], metadatas: list[dict]) -> str:
    sections = []
    for index, (document, metadata) in enumerate(zip(documents, metadatas, strict=False), start=1):
        title = metadata.get("title", "Untitled")
        source_url = metadata.get("source_url", "unknown")
        filename = metadata.get("filename", "unknown")
        chunk_index = metadata.get("chunk_index", "?")
        sections.append(
            "\n".join(
                [
                    f"[S{index}] {title}",
                    f"url: {source_url}",
                    f"file: {filename}",
                    f"chunk_index: {chunk_index}",
                    "snippet:",
                    document.strip(),
                ]
            )
        )
    return "\n\n".join(sections)


def build_prompt(question: str, context: str) -> str:
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


def main() -> None:
    args = parse_args()
    try:
        model = SentenceTransformer(args.embed_model)
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        raise SystemExit(
            "Failed to load the embedding model used for retrieval. "
            "Pass a local model path with --embed-model or run once with network access "
            f"to cache it first. Requested model: {args.embed_model}\nOriginal error: {exc}"
        ) from exc

    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    try:
        collection = client.get_collection(args.collection)
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        raise SystemExit(
            f"Chroma collection '{args.collection}' does not exist yet. "
            "Run apps/rag/src/ingest.py first."
        ) from exc

    query_embedding = model.encode([args.question], normalize_embeddings=True).tolist()[0]
    results = collection.query(query_embeddings=[query_embedding], n_results=args.top_k)

    documents = results["documents"][0]
    metadatas = results["metadatas"][0]
    if not documents:
        raise SystemExit("The collection is empty or no matching documents were found.")

    context = format_sources(documents, metadatas)

    if args.sources_only:
        print(context)
        return

    prompt = build_prompt(args.question, context)
    ollama = Client(host=args.ollama_host)
    response = ollama.generate(model=args.model, prompt=prompt)

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
