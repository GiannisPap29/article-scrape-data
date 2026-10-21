import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The reader reads its folders from env at import time: point it at a temp library.
const dir = mkdtempSync(path.join(os.tmpdir(), "reader-test-"));
const manifest = path.join(mkdtempSync(path.join(os.tmpdir(), "reader-state-")), "manifest.json");
process.env.READER_OUTPUT_DIR = dir;
process.env.READER_MANIFEST_PATH = manifest;

function addArticle(name, metadata, body) {
  writeFileSync(path.join(dir, `${name}.txt`), body);
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ outputPath: `${name}.txt`, ...metadata }));
}
addArticle("go", { docId: "go", title: "Error Handling in Go", tags: ["golang"], publishedAt: "2026-01-02" }, "Wrap errors early.\n\nKubernetes later.");
addArticle("k8s", { docId: "k8s", title: "Kubernetes Basics", tags: [], publishedAt: "2026-01-03" }, "Pods and <script>alert(1)</script> nodes.");
writeFileSync(path.join(dir, "broken.json"), "{oops");
writeFileSync(manifest, JSON.stringify({ documents: { k8s: { auto_tags: ["kubernetes", "devops"] } } }));

const reader = await import("../src/server.js");
const articles = await reader.loadArticles();

test("loads valid sidecars, skips broken ones, applies auto tags", () => {
  assert.deepEqual(articles.map((article) => article.docId), ["k8s", "go"]);
  const k8s = articles.find((article) => article.docId === "k8s");
  assert.deepEqual(reader.articleTags(k8s), ["kubernetes", "devops"]);
  // Real Medium tags win over auto tags.
  assert.deepEqual(reader.articleTags(articles.find((article) => article.docId === "go")), ["golang"]);
});

test("full-text search stems, prefixes, ranks title matches first, and is injection-safe", () => {
  assert.deepEqual([...reader.searchArticles("error").keys()], ["go"]);
  assert.deepEqual([...reader.searchArticles("kube").keys()], ["k8s", "go"]);
  assert.equal(reader.searchArticles("  "), null);
  assert.equal(reader.toFtsQuery('x"); DROP TABLE t;--'), '"x"* "drop"* "table"* "t"*');
  assert.doesNotThrow(() => reader.searchArticles('"); DROP * ^:'));
});

test("filterArticles narrows by tag and sorts search hits by relevance", () => {
  assert.deepEqual(reader.filterArticles(articles, { tag: "devops" }).map((article) => article.docId), ["k8s"]);
  const hits = reader.searchArticles("kubernetes");
  assert.deepEqual(reader.filterArticles(articles, { q: "kubernetes" }, hits).map((article) => article.docId), ["k8s", "go"]);
});

test("Markdown rendering escapes HTML and keeps lists, code, and safe links", () => {
  const html = reader.renderRichBody(
    "## Title\n\n- a\n- b\n\n```go\nx := <-ch\n```\n\n[ok](https://a.b) [bad](javascript:alert(1)) <img onerror=x>"
  );
  assert.match(html, /<h2>Title<\/h2>/u);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/u);
  assert.match(html, /<pre class="language-go" data-lang="go"><code>x := &lt;-ch<\/code><\/pre>/u);
  assert.match(html, /<a href="https:\/\/a.b"/u);
  assert.doesNotMatch(html, /href="javascript/u);
  assert.doesNotMatch(html, /<img onerror/u);
});

test("buildTextPath stays inside the sidecar folder", () => {
  assert.equal(reader.buildTextPath("/out/a.json", "a.txt"), "/out/a.txt");
  assert.equal(reader.buildTextPath("/out/a.json", "/host/old/path/a.txt"), "/out/a.txt");
  assert.equal(reader.buildTextPath("/out/a.json", "../../etc/passwd"), "/out/passwd");
});
