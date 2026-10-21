import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFreediumEmbeddedArticle } from "../scraper/freedium-data.js";

// Synthetic copy of the SvelteKit bootstrap script Freedium renders (shape
// observed 2026-10): JS object literal, unquoted keys, `void 0`, < escapes.
const SCRIPT = `
  __sveltekit_x = { base: "" };
  Promise.all([import("/a.js")]).then(([kit, app]) => {
    kit.start(app, element, {
      node_ids: [0, 3],
      data: [null,{type:"data",data:{slug:"x",eager:{html:"\\u003Cp>hi\\u003C/p>",markdown:"## Heading\\n\\nIt's \\"quoted\\" \\u003Cb>bold\\u003C/b>",article:{title:"Title With 'Quotes'",subtitle:'Single \\'quoted\\' "sub"',authors:[{name:"Ada",avatar:"/img/1"},{name:"Bob"}],readingTime:"4 min read",bylineBio:void 0,date:"2026-06-25T01:38:25.423Z",publishedAt:"2026-06-25T01:38:25.423Z",updatedAt:"2026-06-26T00:00:00.000Z",isFree:false,postImage:"/img/medium/700/0*abc",ratio:1.5e2,tableOfContents:[{id:"h",level:3,title:"Heading"}]}},streamed:null},uses:{params:["slug"]}}],
      form: null
    });
  });
`;

test("extracts article fields from the embedded SvelteKit data", () => {
  const article = extractFreediumEmbeddedArticle(SCRIPT);
  assert.ok(article);
  assert.equal(article.title, "Title With 'Quotes'");
  assert.equal(article.subtitle, "Single 'quoted' \"sub\"");
  assert.deepEqual(article.authors, ["Ada", "Bob"]);
  assert.equal(article.publishedAt, "2026-06-25T01:38:25.423Z");
  assert.equal(article.updatedAt, "2026-06-26T00:00:00.000Z");
  assert.equal(article.readingTime, "4 min read");
  assert.equal(article.isFree, false);
  assert.equal(article.postImage, "/img/medium/700/0*abc");
  assert.equal(article.markdown, "## Heading\n\nIt's \"quoted\" <b>bold</b>");
});

test("returns null when the page has no embedded article", () => {
  assert.equal(extractFreediumEmbeddedArticle("console.log('no data here')"), null);
  assert.equal(extractFreediumEmbeddedArticle("kit.start(app, el, { data: [null, {type:\"data\", data:{}}] })"), null);
});

test("never evaluates the payload as code", () => {
  // A function call is not a literal: parsing must fail instead of running it.
  assert.throws(() => extractFreediumEmbeddedArticle("kit.start(a, b, { data: [alert(1)] })"), /Unsupported literal/);
});
