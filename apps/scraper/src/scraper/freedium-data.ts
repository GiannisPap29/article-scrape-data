// Reads the article data Freedium (SvelteKit) embeds in its page script:
// `kit.start(app, element, { data: [null, {type:"data", data:{eager:{...}}}] })`.
// The payload is a JavaScript object literal, not JSON, so it is parsed with a
// small literal-only parser here instead of being evaluated as code.

export type FreediumEmbeddedArticle = {
  authors: string[];
  isFree: boolean | null;
  markdown: string | null;
  postImage: string | null;
  publishedAt: string | null;
  readingTime: string | null;
  subtitle: string | null;
  title: string | null;
  updatedAt: string | null;
};

type Literal = Literal[] | boolean | number | string | null | undefined | { [key: string]: Literal; };

export function extractFreediumEmbeddedArticle(scriptText: string): FreediumEmbeddedArticle | null {
  const marker = scriptText.search(/\bdata:\s*\[/u);
  if (marker < 0) {
    return null;
  }

  const start = scriptText.indexOf("[", marker);
  const nodes = new LiteralParser(scriptText, start).parse();
  if (!Array.isArray(nodes)) {
    return null;
  }

  for (const node of nodes) {
    const eager = asObject(asObject(asObject(node)?.data)?.eager);
    const article = asObject(eager?.article);
    if (!eager || !article) {
      continue;
    }

    const authors = Array.isArray(article.authors)
      ? article.authors.map((author) => asString(asObject(author)?.name)).filter((name): name is string => Boolean(name))
      : [];

    return {
      authors,
      isFree: typeof article.isFree === "boolean" ? article.isFree : null,
      markdown: asString(eager.markdown),
      postImage: asString(article.postImage),
      publishedAt: asString(article.publishedAt) ?? asString(article.date),
      readingTime: asString(article.readingTime),
      subtitle: asString(article.subtitle),
      title: asString(article.title),
      updatedAt: asString(article.updatedAt)
    };
  }

  return null;
}

function asObject(value: Literal): { [key: string]: Literal; } | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value: Literal): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

class LiteralParser {
  private position: number;

  constructor(private readonly text: string, start: number) {
    this.position = start;
  }

  parse(): Literal {
    this.skipWhitespace();
    const char = this.text[this.position];

    if (char === "[") {
      return this.parseArray();
    }
    if (char === "{") {
      return this.parseObject();
    }
    if (char === "\"" || char === "'") {
      return this.parseString();
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      return this.parseNumber();
    }

    const word = this.text.slice(this.position).match(/^[A-Za-z_$][\w$]*/u)?.[0];
    if (word === "true" || word === "false" || word === "null") {
      this.position += word.length;
      return word === "true" ? true : word === "false" ? false : null;
    }
    if (word === "void") {
      this.position += word.length;
      this.skipWhitespace();
      this.parseNumber();
      return undefined;
    }

    throw new Error(`Unsupported literal at ${this.position}: ${this.text.slice(this.position, this.position + 30)}`);
  }

  private parseArray(): Literal[] {
    const items: Literal[] = [];
    this.position += 1;
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.position] === "]") {
        this.position += 1;
        return items;
      }
      items.push(this.parse());
      this.skipWhitespace();
      if (this.text[this.position] === ",") {
        this.position += 1;
      }
    }
  }

  private parseObject(): { [key: string]: Literal; } {
    const result: { [key: string]: Literal; } = {};
    this.position += 1;
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.position] === "}") {
        this.position += 1;
        return result;
      }

      const char = this.text[this.position];
      let key: string;
      if (char === "\"" || char === "'") {
        key = this.parseString();
      } else {
        const match = this.text.slice(this.position).match(/^[\w$]+/u);
        if (!match) {
          throw new Error(`Invalid object key at ${this.position}`);
        }
        key = match[0];
        this.position += key.length;
      }

      this.skipWhitespace();
      if (this.text[this.position] !== ":") {
        throw new Error(`Expected ':' at ${this.position}`);
      }
      this.position += 1;
      result[key] = this.parse();
      this.skipWhitespace();
      if (this.text[this.position] === ",") {
        this.position += 1;
      }
    }
  }

  private parseString(): string {
    const quote = this.text[this.position];
    let end = this.position + 1;
    while (end < this.text.length && this.text[end] !== quote) {
      end += this.text[end] === "\\" ? 2 : 1;
    }
    const raw = this.text.slice(this.position + 1, end);
    this.position = end + 1;

    // JS string escapes are a superset of JSON's: translate the extra ones and
    // escape bare double quotes (legal inside single-quoted JS strings).
    let jsonCompatible = "";
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (char === "\"") {
        jsonCompatible += "\\\"";
        continue;
      }
      if (char !== "\\") {
        jsonCompatible += char;
        continue;
      }

      const next = raw[index + 1] ?? "";
      index += 1;
      if (next === "'") {
        jsonCompatible += "'";
      } else if (next === "x") {
        jsonCompatible += `\\u00${raw.slice(index + 1, index + 3)}`;
        index += 2;
      } else if (next === "v") {
        jsonCompatible += "\\u000b";
      } else if (next === "0" && !/[0-9]/u.test(raw[index + 1] ?? "")) {
        jsonCompatible += "\\u0000";
      } else {
        jsonCompatible += `\\${next}`;
      }
    }
    return JSON.parse(`"${jsonCompatible}"`) as string;
  }

  private parseNumber(): number {
    const match = this.text.slice(this.position).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) {
      throw new Error(`Invalid number at ${this.position}`);
    }
    this.position += match[0].length;
    return Number(match[0]);
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.text[this.position] ?? "")) {
      this.position += 1;
    }
  }
}
