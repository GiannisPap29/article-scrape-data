// Turns Freedium's embedded article Markdown into the body stored in .txt
// files: plain Markdown with permanent image links, no raw HTML blocks, and
// no Medium tracking parameters. Code fences are never rewritten.

type ConvertOptions = {
  pageUrl: string;
  subtitle: string | null;
  title: string;
};

const FENCE_PATTERN = /^\s*(```|~~~)/u;

export function convertFreediumMarkdown(markdown: string, options: ConvertOptions): string {
  const text = mapOutsideCodeFences(markdown.replace(/\r\n/gu, "\n"), (segment) => {
    let result = segment.replace(/<figure\b[\s\S]*?<\/figure>/giu, (block) => convertFigure(block, options.pageUrl));
    result = result.replace(/<img\b[^>]*>/giu, (tag) => convertImageTag(tag, options.pageUrl, ""));
    result = result.replace(
      /<iframe\b[^>]*\bsrc="([^"]+)"[^>]*>(?:\s*<\/iframe>)?/giu,
      (_match, src: string) => `\n\n[Embedded content](${absolutizeUrl(decodeHtmlEntities(src), options.pageUrl)})\n\n`
    );
    // Any other leftover HTML blocks: keep their text, drop the tags.
    result = result.replace(/<\/?(?:picture|source|div|span|br|section)\b[^>]*>/giu, "");
    result = result.replace(/\]\((https?:\/\/[^)\s]+)\)/gu, (_match, url: string) => `](${stripTrackingParams(url)})`);
    return result;
  });

  return dropLeadingTitleLines(collapseBlankLines(text), options);
}

export function toPermanentImageUrl(src: string, pageUrl: string): string {
  // Freedium proxies Medium images as /img/<width>/<id> or /img/medium/<width>/<id>.
  // The same image is permanently available on Medium's CDN, independent of
  // which Freedium mirror was used.
  const match = src.match(/^(?:https?:\/\/[^/]+)?\/img\/(?:medium\/)?(\d+)\/(.+)$/u);
  if (match) {
    return `https://miro.medium.com/v2/resize:fit:${match[1]}/${match[2]}`;
  }
  return absolutizeUrl(src, pageUrl);
}

function convertFigure(block: string, pageUrl: string): string {
  const caption = stripTags(block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/iu)?.[1] ?? "");
  const imageTag = block.match(/<img\b[^>]*>/iu)?.[0];
  const image = imageTag ? convertImageTag(imageTag, pageUrl, caption).trim() : "";
  const parts = [image, caption].filter(Boolean);
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}\n\n` : "\n\n";
}

function convertImageTag(tag: string, pageUrl: string, fallbackAlt: string): string {
  const src = tag.match(/\bsrc="([^"]+)"/iu)?.[1];
  if (!src) {
    return "";
  }
  const rawAlt = decodeHtmlEntities(tag.match(/\balt="([^"]*)"/iu)?.[1] ?? "").trim();
  // Medium exports missing alt text as the literal string "None".
  const alt = (rawAlt && rawAlt !== "None" ? rawAlt : fallbackAlt).replace(/[[\]]/gu, "");
  return `\n\n![${alt}](${toPermanentImageUrl(decodeHtmlEntities(src), pageUrl)})\n\n`;
}

function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key === "source" || key.startsWith("utm_") || key === "sk") {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function absolutizeUrl(src: string, pageUrl: string): string {
  try {
    return new URL(src, pageUrl).toString();
  } catch {
    return src;
  }
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

function mapOutsideCodeFences(text: string, transform: (segment: string) => string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      output.push(transform(buffer.join("\n")));
      buffer = [];
    }
  };

  for (const line of lines) {
    const marker = line.match(FENCE_PATTERN)?.[1] ?? null;
    if (fence === null && marker) {
      flush();
      fence = marker;
      output.push(line);
      continue;
    }
    if (fence !== null) {
      output.push(line);
      if (marker === fence && line.trim() === fence) {
        fence = null;
      }
      continue;
    }
    buffer.push(line);
  }

  flush();
  return output.join("\n");
}

function collapseBlankLines(text: string): string {
  // Collapse runs of blank lines outside code, keep code blocks byte-exact.
  return mapOutsideCodeFences(text, (segment) => segment.replace(/[ \t]+$/gmu, "").replace(/\n{3,}/gu, "\n\n")).trim();
}

function dropLeadingTitleLines(text: string, options: ConvertOptions): string {
  // Some articles repeat the title and/or subtitle as headings at the top; the
  // sidecar already stores both, so drop them from the body.
  const normalize = (value: string) => value.replace(/^#+\s*/u, "").replace(/[…\s]+$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
  const title = normalize(options.title);
  const subtitle = options.subtitle ? normalize(options.subtitle) : null;
  const blocks = text.split("\n\n");

  while (blocks.length > 1) {
    const first = blocks[0].trim();
    if (!/^#{1,6}\s/u.test(first) || first.includes("\n")) {
      break;
    }
    const heading = normalize(first);
    const matchesTitle = heading === title;
    const matchesSubtitle = subtitle !== null && subtitle.length > 0 && (heading === subtitle || heading.startsWith(subtitle));
    if (!matchesTitle && !matchesSubtitle) {
      break;
    }
    blocks.shift();
  }

  return blocks.join("\n\n").trim();
}
