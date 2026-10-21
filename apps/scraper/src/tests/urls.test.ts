import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDocId,
  describeArticleSource,
  extractSingleArticleUrlFromText,
  isArticleUrl,
  normalizeArticleUrl
} from "../scraper/urls.js";

test("normalizeArticleUrl drops query and hash", () => {
  assert.equal(
    normalizeArticleUrl("https://medium.com/@a/some-post-0123456789ab?source=rss----1&sk=x#frag"),
    "https://medium.com/@a/some-post-0123456789ab"
  );
});

test("normalizeArticleUrl unwraps links pasted from any Freedium mirror", () => {
  const article = "https://medium.com/skillstuff/10-database-mistakes-i-made-a1d6e116633e";
  assert.equal(normalizeArticleUrl(`https://freedium-mirror.cfd/${article}`), article);
  assert.equal(normalizeArticleUrl(`https://freedium.cfd/${article}?x=1`), article);
});

test("isArticleUrl accepts article slugs and /p/<id>, rejects profiles and lists", () => {
  assert.equal(isArticleUrl("https://medium.com/@a/some-post-0123456789ab"), true);
  assert.equal(isArticleUrl("https://uxplanet.org/design-md-best-practices-c00325e8b23a"), true);
  assert.equal(isArticleUrl("https://medium.com/p/0123456789ab"), true);
  assert.equal(isArticleUrl("https://medium.com/@someone"), false);
  assert.equal(isArticleUrl("https://medium.com/tag/golang-0123456789ab"), false);
  assert.equal(isArticleUrl("https://medium.com/@a/lists/reading-0123456789ab"), false);
});

test("extractSingleArticleUrlFromText finds exactly one article URL", () => {
  const url = "https://medium.com/@a/some-post-0123456789ab";
  assert.equal(extractSingleArticleUrlFromText(`Read this: ${url}.`), url);
  // The same article twice (with tracking params) is still one article.
  assert.equal(extractSingleArticleUrlFromText(`${url}?source=a\n${url}`), url);
  assert.throws(() => extractSingleArticleUrlFromText("no links here"), /No valid Medium article URL/);
  assert.throws(
    () => extractSingleArticleUrlFromText(`${url} https://medium.com/@b/other-post-abcdef012345`),
    /multiple Medium article URLs/
  );
});

test("createDocId is stable per URL", () => {
  const url = "https://medium.com/@a/some-post-0123456789ab";
  assert.equal(createDocId(url), createDocId(url));
  assert.match(createDocId(url), /^doc_[0-9a-f]{16}$/);
  assert.notEqual(createDocId(url), createDocId(`${url}x`));
});

test("describeArticleSource names Medium, publications, and custom domains", () => {
  assert.deepEqual(describeArticleSource("https://medium.com/skillstuff/x-a1d6e116633e"), { publication: "skillstuff", siteName: "Medium" });
  assert.deepEqual(describeArticleSource("https://medium.com/@user/x-a1d6e116633e"), { publication: null, siteName: "Medium" });
  assert.deepEqual(describeArticleSource("https://someone.medium.com/x-a1d6e116633e"), { publication: null, siteName: "Medium" });
  assert.deepEqual(describeArticleSource("https://www.uxplanet.org/x-a1d6e116633e"), { publication: "uxplanet.org", siteName: "uxplanet.org" });
});
