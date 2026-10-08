import { Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Fragment } from "react";
import { IconTile } from "@/components/icons";
import { authorOf, formatDate } from "@/lib/blog/posts";
import type { PostMeta } from "@/lib/blog/types";
import { TOOL_BY_SLUG } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";

/** A call-out that opens a tool, placed in a post with `<!-- tool:slug -->`. */
export function ToolCallout({ slug, className }: { slug: string; className?: string }) {
  const tool = TOOL_BY_SLUG[slug];
  if (!tool) return null;
  return (
    <Link
      to="/$slug"
      params={{ slug: tool.slug }}
      className={cn("not-prose group my-7 flex items-center gap-4 rounded-lg border border-line bg-paper p-4 no-underline transition-colors hover:border-carbon/60", className)}
    >
      <IconTile name={tool.icon} category={tool.category} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-ink group-hover:text-carbon">{tool.name}</span>
        <span className="mt-0.5 block text-sm text-ink-2">{tool.blurb}</span>
        <span className="mt-1 flex items-center gap-1 text-xs text-ok">
          <ShieldCheck className="size-3.5" aria-hidden /> Free, works on your device, nothing uploaded
        </span>
      </span>
      <ArrowRight className="size-5 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-carbon" aria-hidden />
    </Link>
  );
}

const MARK = /<!--\s*tool:([a-z0-9-]+)\s*-->/g;

/** The post's HTML, with tool call-outs where the Markdown asked for them. */
export function PostBody({ html }: { html: string }) {
  const parts: { html?: string; tool?: string }[] = [];
  let last = 0;
  for (const m of html.matchAll(MARK)) {
    parts.push({ html: html.slice(last, m.index) });
    parts.push({ tool: m[1] });
    last = m.index! + m[0].length;
  }
  parts.push({ html: html.slice(last) });
  return (
    <div className="prose-article">
      {parts.map((p, i) => (
        <Fragment key={i}>{p.tool ? <ToolCallout slug={p.tool} /> : p.html?.trim() ? <div dangerouslySetInnerHTML={{ __html: p.html }} /> : null}</Fragment>
      ))}
    </div>
  );
}

export function Byline({ post }: { post: PostMeta }) {
  const a = authorOf(post.author);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-3">
      <Link to="/about" className="font-medium text-ink hover:text-carbon">
        {a.name}
      </Link>
      <span aria-hidden>·</span>
      <span>{a.role}</span>
      <span aria-hidden>·</span>
      <time dateTime={post.updated}>{post.updated !== post.date ? `Updated ${formatDate(post.updated)}` : formatDate(post.date)}</time>
      <span aria-hidden>·</span>
      <span>{post.readingMinutes} min read</span>
    </p>
  );
}

export function AuthorBox({ post }: { post: PostMeta }) {
  const a = authorOf(post.author);
  return (
    <aside className="mt-12 flex gap-4 rounded-lg border border-line bg-paper p-5">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-carbon-soft text-lg font-bold text-carbon">{a.name[0]}</span>
      <div>
        <p className="font-semibold">
          Written by {a.name}, {a.role.replace(/^Founder, /, "founder of ")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">{a.bio}</p>
        <p className="mt-2 text-xs text-ink-3">
          Published {formatDate(post.date)}; facts last checked {formatDate(post.updated)}. Banks and government sites change their rules now and then, so the sources are linked for you to check.
        </p>
      </div>
    </aside>
  );
}

export function PostCard({ post, className }: { post: PostMeta; className?: string }) {
  return (
    <Link
      to="/blog/$post"
      params={{ post: post.slug }}
      className={cn("group flex h-full flex-col rounded-lg border border-line bg-paper p-5 transition-[border-color,box-shadow] hover:border-ink-3/60 hover:shadow-panel", className)}
    >
      {post.tags.length ? <span className="text-xs font-semibold tracking-wide text-carbon uppercase">{post.tags[0]}</span> : null}
      <span className="mt-1.5 block text-[17px] leading-snug font-semibold text-ink group-hover:text-carbon">{post.title}</span>
      <span className="mt-2 block flex-1 text-sm leading-relaxed text-ink-2">{post.description}</span>
      <span className="mt-4 block text-xs text-ink-3">
        {formatDate(post.updated)} · {post.readingMinutes} min read
      </span>
    </Link>
  );
}
