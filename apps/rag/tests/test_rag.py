"""RAG unit tests. Run: venv/bin/python -m unittest discover -s apps/rag/tests"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import common  # noqa: E402
import vectorstore  # noqa: E402
import sync  # noqa: E402
from query import diversify  # noqa: E402
from tag import normalize_tags  # noqa: E402


def sidecar(doc_id: str, txt_name: str, content_hash: str = "h1", version: int = 4) -> dict:
    return {
        "docId": doc_id,
        "contentHash": content_hash,
        "sourceUrl": f"https://medium.com/@a/{doc_id}-0123456789ab",
        "scrapedAt": "2026-10-18T00:00:00Z",
        "title": f"Title {doc_id}",
        "tags": [],
        "outputPath": txt_name,
        "metadataPath": txt_name.replace(".txt", ".json"),
        "batchId": "2026-10-18",
        "scraperMetadataVersion": version,
    }


class ChunkTextTests(unittest.TestCase):
    def test_short_text_is_one_chunk(self) -> None:
        self.assertEqual(common.chunk_text("One.\n\nTwo."), ["One.\n\nTwo."])

    def test_chunks_respect_target_size_and_overlap(self) -> None:
        paragraphs = [f"Paragraph {index} " + "word " * 60 for index in range(30)]
        chunks = common.chunk_text("\n\n".join(paragraphs))
        self.assertGreater(len(chunks), 1)
        # Target + one paragraph of slack; nothing near the old 2200-char size.
        self.assertTrue(all(len(chunk) <= common.CHUNK_TARGET_CHARS + 400 for chunk in chunks))
        # Each chunk after the first starts with the tail of the previous one.
        self.assertIn(chunks[0][-40:].strip()[-20:], chunks[1])

    def test_huge_paragraph_is_split(self) -> None:
        chunks = common.chunk_text("x" * 5000)
        self.assertTrue(all(len(chunk) <= common.CHUNK_TARGET_CHARS for chunk in chunks))
        self.assertGreaterEqual(len(chunks), 4)


class EmbeddingNamingTests(unittest.TestCase):
    def test_collection_per_model(self) -> None:
        self.assertEqual(common.collection_name_for("embeddinggemma"), "articles-embeddinggemma")
        self.assertEqual(common.collection_name_for("nomic-embed-text:v1.5"), "articles-nomic-embed-text-v1.5")

    def test_model_specific_prompts(self) -> None:
        self.assertEqual(
            common.format_for_embedding("embeddinggemma:latest", "document", "body", "T"),
            "title: T | text: body",
        )
        self.assertEqual(
            common.format_for_embedding("embeddinggemma", "query", "q"),
            "task: search result | query: q",
        )
        self.assertEqual(common.format_for_embedding("unknown-model", "query", "q"), "q")


class SidecarTests(unittest.TestCase):
    def test_resolve_text_path_for_v4_and_legacy_absolute_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            json_path = folder / "a.json"
            self.assertEqual(common.resolve_text_path({"outputPath": "a.txt"}, json_path), folder / "a.txt")
            # Legacy absolute path that no longer exists: fall back next to the sidecar.
            self.assertEqual(
                common.resolve_text_path({"outputPath": "/old/host/path/a.txt"}, json_path), folder / "a.txt"
            )

    def test_validate_rejects_unknown_versions(self) -> None:
        with self.assertRaises(ValueError):
            common.validate_sidecar(sidecar("d", "d.txt", version=99), Path("d.json"))
        common.validate_sidecar(sidecar("d", "d.txt", version=4), Path("d.json"))


class SyncTests(unittest.TestCase):
    def test_sync_skips_bad_files_preserves_bookkeeping_and_marks_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "output"
            output.mkdir()
            for doc_id in ("good", "gone"):
                (output / f"{doc_id}.txt").write_text("body")
                (output / f"{doc_id}.json").write_text(json.dumps(sidecar(doc_id, f"{doc_id}.txt")))
            (output / "broken.json").write_text("{not json")

            patches = [
                mock.patch.object(common, "STATE_DIR", root / "state"),
                mock.patch.object(common, "MANIFEST_PATH", root / "state" / "manifest.json"),
            ]
            for patch in patches:
                patch.start()
            try:
                counts = sync.sync_documents(output, None)
                self.assertEqual(counts["new_or_changed"], 2)
                self.assertEqual(counts["invalid"], 1)

                manifest = common.load_manifest()
                manifest["documents"]["good"].update({"status": "indexed", "embed_model": "m", "auto_tags": ["x"]})
                common.save_manifest(manifest)

                (output / "gone.json").unlink()
                counts = sync.sync_documents(output, None)
                manifest = common.load_manifest()
                self.assertEqual(counts["removed"], 1)
                self.assertEqual(manifest["documents"]["gone"]["status"], "removed")
                # Unchanged + already indexed: bookkeeping survives the sync.
                good = manifest["documents"]["good"]
                self.assertEqual((good["status"], good["embed_model"], good["auto_tags"]), ("indexed", "m", ["x"]))
            finally:
                for patch in patches:
                    patch.stop()


class TagAndQueryTests(unittest.TestCase):
    def test_normalize_tags(self) -> None:
        self.assertEqual(
            normalize_tags(["#GoLang", "golang", "  System   Design ", "x" * 40, "c++", "", 7]),
            ["golang", "system design", "c++", "7"],
        )
        self.assertEqual(normalize_tags("not a list"), [])
        self.assertEqual(len(normalize_tags([f"t{i}" for i in range(20)])), 6)

    def test_diversify_limits_chunks_per_document(self) -> None:
        documents = ["a1", "a2", "a3", "b1", "c1"]
        metadatas = [{"doc_id": "a"}, {"doc_id": "a"}, {"doc_id": "a"}, {"doc_id": "b"}, {"doc_id": "c"}]
        kept, _ = diversify(documents, metadatas, top_k=4)
        self.assertEqual(kept, ["a1", "a2", "b1", "c1"])


class VectorStoreTests(unittest.TestCase):
    def test_replace_query_delete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = vectorstore.open_store(Path(tmp) / "vectors.db")
            vectorstore.ensure_collection(store, "c", "m", 3)
            vectorstore.replace_document_chunks(
                store, "c", "a", ["a:0", "a:1"], ["east", "north"], [[1, 0, 0], [0, 1, 0]],
                [{"doc_id": "a", "chunk_index": 0}, {"doc_id": "a", "chunk_index": 1}],
            )
            vectorstore.replace_document_chunks(store, "c", "b", ["b:0"], ["mostly east"], [[0.9, 0.1, 0]], [{"doc_id": "b"}])

            hits = vectorstore.query(store, "c", [1, 0, 0], 3)
            self.assertEqual([text for text, _metadata, _distance in hits], ["east", "mostly east", "north"])
            self.assertAlmostEqual(hits[0][2], 0.0, places=5)  # cosine distance
            self.assertEqual(hits[0][1]["doc_id"], "a")

            # Re-indexing a document swaps its chunks; nothing stale remains.
            vectorstore.replace_document_chunks(store, "c", "a", ["a:0"], ["west"], [[-1, 0, 0]], [{"doc_id": "a"}])
            self.assertEqual(vectorstore.count(store, "c"), 2)
            self.assertEqual([hit[0] for hit in vectorstore.query(store, "c", [1, 0, 0], 5)], ["mostly east", "west"])

            with store:
                vectorstore.delete_document(store, "c", "b")
            self.assertEqual([chunk["id"] for chunk in vectorstore.get_chunks(store, "c")], ["a:0"])

            with self.assertRaises(ValueError):
                vectorstore.ensure_collection(store, "c", "other-model", 768)
            with self.assertRaises(LookupError):
                vectorstore.query(store, "missing", [1, 0, 0], 1)
            store.close()


class McpToolTests(unittest.TestCase):
    def test_list_get_and_stats_read_the_manifest(self) -> None:
        import mcp_server
        from mcp.server.mcpserver.exceptions import ToolError

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text("# Body A")
            manifest = {
                "schema_version": common.MANIFEST_SCHEMA_VERSION,
                "documents": {
                    "a": {"doc_id": "a", "title": "Kafka Basics", "author": "Ada", "source_url": "u1", "tags": [],
                          "auto_tags": ["kafka"], "status": "indexed", "source_output_path": str(root / "a.txt"),
                          "published_at": "2026-02-01"},
                    "b": {"doc_id": "b", "title": "Go Errors", "author": "Bob", "source_url": "u2", "tags": ["golang"],
                          "status": "synced", "source_output_path": str(root / "b.txt"), "published_at": "2026-03-01"},
                    "c": {"doc_id": "c", "title": "Gone", "source_url": "u3", "status": "removed", "source_output_path": ""},
                },
            }
            (root / "manifest.json").write_text(json.dumps(manifest))
            with mock.patch.object(common, "MANIFEST_PATH", root / "manifest.json"), \
                    mock.patch.object(common, "STATE_DIR", root):
                self.assertEqual([a.doc_id for a in mcp_server.list_articles()], ["b", "a"])
                self.assertEqual([a.doc_id for a in mcp_server.list_articles(tag="KAFKA")], ["a"])
                self.assertEqual([a.doc_id for a in mcp_server.list_articles(author="bo")], ["b"])
                self.assertEqual(mcp_server.get_article("a").body_markdown, "# Body A")
                with self.assertRaises(ToolError):
                    mcp_server.get_article("c")  # removed
                with self.assertRaises(ToolError):
                    mcp_server.get_article("b")  # text file missing
                stats = mcp_server.library_stats()
                self.assertEqual((stats.documents, stats.indexed), (2, 1))


if __name__ == "__main__":
    unittest.main()
