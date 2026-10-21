import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanExtractedArticleText, slugify } from "../scraper/text.js";

test("cleanExtractedArticleText drops the title, UI words, and directly repeated lines", () => {
  const input = "## My Title\n\nShare\n\nFirst paragraph.\nFirst paragraph.\n\nCopy\n\n```\nShare\n```";
  assert.equal(cleanExtractedArticleText(input, "My Title"), "First paragraph.\n\n```\nShare\n```");
  // Conservative on purpose: the same sentence later in the article is kept.
  assert.equal(cleanExtractedArticleText("A.\n\nB.\n\nA.", "T"), "A.\n\nB.\n\nA.");
});

test("slugify produces short, safe file names", () => {
  assert.equal(slugify("Go’s Error Handling: A Guide!"), "go-s-error-handling-a-guide");
  assert.equal(slugify("!!!"), "article");
  assert.equal(slugify("a".repeat(200)).length, 80);
});
