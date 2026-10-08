/**
 * Blog posts as Markdown files with YAML front matter (src/content/blog/<slug>.md).
 *
 * - Importing a post module gives `meta`, the rendered `html` and the `toc` (its H2 headings),
 *   all worked out at build time, so pages ship HTML and no Markdown parser.
 * - `virtual:blog-posts` lists every post's `meta`, newest first, for the index, the sitemap,
 *   llms.txt and the "guides" links on tool pages.
 *
 * Inside a post, a line `<!-- tool:remove-password -->` places a card for that tool.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import yaml from "js-yaml";
import { Marked, type Tokens } from "marked";
import type { Plugin } from "vite";
import type { Faq, PostMeta } from "../src/lib/blog/types";

const DIR = join(process.cwd(), "src/content/blog");
const VIRTUAL = "virtual:blog-posts";
const RESOLVED = "\0" + VIRTUAL;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function iso(v: unknown, file: string, key: string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new Error(`${file}: "${key}" must be a date like 2026-10-08`);
}

function split(src: string, file: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) throw new Error(`${file}: missing front matter`);
  const data = (yaml.load(m[1]) ?? {}) as Record<string, unknown>;
  return { data, body: src.slice(m[0].length) };
}

function parseMeta(file: string, src: string): { meta: PostMeta; body: string } {
  const { data, body } = split(src, file);
  const slug = basename(file, ".md");
  const need = (k: string) => {
    const v = data[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`${file}: "${k}" is required`);
    return v.trim();
  };
  const date = iso(data.date, file, "date");
  const words = body.replace(/<!--[\s\S]*?-->/g, "").split(/\s+/).filter(Boolean).length;
  const faq = Array.isArray(data.faq) ? (data.faq as Faq[]).map((f) => ({ q: String(f.q).trim(), a: String(f.a).trim() })) : [];
  const meta: PostMeta = {
    slug,
    title: need("title"),
    seoTitle: typeof data.seoTitle === "string" ? data.seoTitle : undefined,
    description: need("description"),
    date,
    updated: data.updated ? iso(data.updated, file, "updated") : date,
    author: typeof data.author === "string" ? data.author : "harsh",
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    tools: Array.isArray(data.tools) ? data.tools.map(String) : [],
    faq,
    words,
    readingMinutes: Math.max(1, Math.round(words / 200)),
  };
  if (meta.description.length > 170) throw new Error(`${file}: description is ${meta.description.length} characters; keep it under 170`);
  return { meta, body };
}

function render(body: string): { html: string; toc: { id: string; text: string }[] } {
  const toc: { id: string; text: string }[] = [];
  const used = new Set<string>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline: (t: Tokens.Heading["tokens"]) => string } }, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        let id = slugify(inner) || "section";
        while (used.has(id)) id += "-x";
        used.add(id);
        if (depth === 2) toc.push({ id, text: plain(inner) });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      link(this: { parser: { parseInline: (t: Tokens.Link["tokens"]) => string } }, { href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href);
        const t = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
        return `<a href="${href}"${t}${external ? ' rel="noopener"' : ""}>${text}</a>`;
      },
    },
  });
  // Tables scroll sideways on narrow screens instead of widening the page.
  const html = (marked.parse(body, { async: false }) as string).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return { html, toc };
}

function inline(md: string): string {
  return new Marked({ gfm: true }).parseInline(md, { async: false }) as string;
}

function files(): string[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
      .map((f) => join(DIR, f));
  } catch {
    return [];
  }
}

export function blog(): Plugin {
  return {
    name: "doyourpdf-blog",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const metas = files().map((f) => {
        this.addWatchFile(f);
        return parseMeta(f, readFileSync(f, "utf8")).meta;
      });
      metas.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
      return `export default ${JSON.stringify(metas)};`;
    },
    transform(src, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(DIR) || !file.endsWith(".md")) return null;
      const { meta, body } = parseMeta(file, src);
      const { html, toc } = render(body);
      const faqHtml = meta.faq.map((f) => ({ q: f.q, a: inline(f.a) }));
      return {
        code: `export const meta = ${JSON.stringify(meta)};\nexport const html = ${JSON.stringify(html)};\nexport const toc = ${JSON.stringify(toc)};\nexport const faqHtml = ${JSON.stringify(faqHtml)};\n`,
        map: null,
      };
    },
  };
}
