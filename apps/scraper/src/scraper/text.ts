// Plain-text normalization and cleanup shared by extraction and output.

export const ARTICLE_UI_ARTIFACT_LINES = new Set([
  "copy",
  "copy link",
  "follow",
  "listen",
  "more from medium",
  "open in app",
  "save",
  "share",
  "subscribe"
]);

export function cleanExtractedArticleText(content: string, title: string): string {
  const lines = content.split("\n");
  const cleanedLines: string[] = [];
  const normalizedTitle = normalizeComparisonText(title);
  let titleSkipped = false;
  let inCodeBlock = false;

  for (const rawLine of lines) {
    if (rawLine.trim() === "```") {
      // Blank line before an opening fence only; adding one before the closing
      // fence would append an empty line to every code block.
      if (!inCodeBlock && cleanedLines.length > 0 && cleanedLines.at(-1) !== "") {
        cleanedLines.push("");
      }
      inCodeBlock = !inCodeBlock;
      cleanedLines.push("```");
      continue;
    }

    if (inCodeBlock) {
      cleanedLines.push(rawLine.replace(/\r$/u, ""));
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      if (cleanedLines.at(-1) !== "") {
        cleanedLines.push("");
      }
      continue;
    }

    const normalizedLine = normalizeComparisonText(line);
    if (!titleSkipped && normalizeComparisonText(line.replace(/^#{1,6}\s+/u, "")) === normalizedTitle) {
      titleSkipped = true;
      continue;
    }

    if (ARTICLE_UI_ARTIFACT_LINES.has(normalizedLine)) {
      continue;
    }

    if (normalizedLine === normalizeComparisonText(cleanedLines.at(-1) ?? "")) {
      continue;
    }

    cleanedLines.push(line);
  }

  return normalizeText(cleanedLines.join("\n"));
}

export function normalizeBrowserPageTitle(value: string): string {
  const normalized = normalizeTitle(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .replace(/\s*[|:-]\s*(medium|freedium).*$/iu, "")
    .replace(/\s*[|:-]\s*by\s+.+$/iu, "")
    .trim();
}

export function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toDisplayTitle(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => /^[a-z]/u.test(part) ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ")
    .trim() || "article";
}

export function normalizeComparisonText(value: string): string {
  return normalizeTitle(value).toLowerCase();
}


export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "article";
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
