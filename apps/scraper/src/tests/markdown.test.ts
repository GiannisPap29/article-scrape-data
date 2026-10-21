import assert from "node:assert/strict";
import { test } from "node:test";
import { convertFreediumMarkdown, toPermanentImageUrl } from "../scraper/markdown.js";

const OPTIONS = { pageUrl: "https://freedium-mirror.cfd/https://medium.com/@a/x-0123456789ab", subtitle: "A subtitle", title: "The Title" };

test("figures become permanent Medium CDN images with captions", () => {
  const input = 'Intro\n\n<figure>\n  <picture><source srcset="/img/2000/1*abc.jpeg 1x"><img src="/img/700/1*abc.jpeg" alt="None" width="10"></picture>\n  <figcaption>Photo by <a href="x">Someone</a></figcaption>\n</figure>\n\nAfter';
  assert.equal(
    convertFreediumMarkdown(input, OPTIONS),
    "Intro\n\n![Photo by Someone](https://miro.medium.com/v2/resize:fit:700/1*abc.jpeg)\n\nPhoto by Someone\n\nAfter"
  );
});

test("iframes become links and tracking parameters are removed", () => {
  const input = 'See [this](https://medium.com/@a/post-0123456789ab?source=search_post---2&utm_medium=x&keep=1)\n\n<iframe src="https://gist.github.com/a/b.js"></iframe>';
  assert.equal(
    convertFreediumMarkdown(input, OPTIONS),
    "See [this](https://medium.com/@a/post-0123456789ab?keep=1)\n\n[Embedded content](https://gist.github.com/a/b.js)"
  );
});

test("code fences are left byte-for-byte untouched", () => {
  const code = '```html\n<figure><img src="/img/700/x"></figure>\n\n\n[link](https://a.b/?source=x)\n```';
  assert.equal(convertFreediumMarkdown(`Text\n\n${code}\n\nEnd`, OPTIONS), `Text\n\n${code}\n\nEnd`);
});

test("leading title/subtitle headings are dropped, real headings kept", () => {
  const input = "# The Title\n\n#### A subtitle\n\n### Real Section\n\nBody";
  assert.equal(convertFreediumMarkdown(input, OPTIONS), "### Real Section\n\nBody");
  // Freedium truncates long subtitles with an ellipsis.
  const truncated = { ...OPTIONS, subtitle: "Lessons about indexing, schema design, and…" };
  assert.equal(
    convertFreediumMarkdown("#### Lessons about indexing, schema design, and transactions\n\nBody", truncated),
    "Body"
  );
});

test("toPermanentImageUrl maps both Freedium proxy path shapes", () => {
  assert.equal(toPermanentImageUrl("/img/700/1*x.png", OPTIONS.pageUrl), "https://miro.medium.com/v2/resize:fit:700/1*x.png");
  assert.equal(toPermanentImageUrl("/img/medium/4000/0*y", OPTIONS.pageUrl), "https://miro.medium.com/v2/resize:fit:4000/0*y");
  assert.equal(toPermanentImageUrl("/other/z.png", OPTIONS.pageUrl), "https://freedium-mirror.cfd/other/z.png");
  assert.equal(toPermanentImageUrl("https://cdn.example/z.png", OPTIONS.pageUrl), "https://cdn.example/z.png");
});
