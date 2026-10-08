import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { AuthorBox, Byline, PostBody, PostCard, ToolCallout } from "@/components/article";
import { Page } from "@/components/shell";
import { loadPost, POST_BY_SLUG, relatedPosts } from "@/lib/blog/posts";
import { BRAND } from "@/lib/brand";
import { article, breadcrumbs, faqPage, pageHead } from "@/lib/seo";

export const Route = createFileRoute("/blog/$post")({
  beforeLoad: ({ params }) => {
    if (!POST_BY_SLUG[params.post]) throw notFound();
  },
  loader: async ({ params }) => {
    const mod = await loadPost(params.post);
    if (!mod) throw notFound();
    return { meta: mod.meta, html: mod.html, toc: mod.toc, faq: mod.faqHtml };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const p = loaderData.meta;
    return pageHead({
      title: `${p.seoTitle ?? p.title} | ${BRAND.name}`,
      description: p.description,
      path: `/blog/${p.slug}`,
      type: "article",
      extra: [
        { property: "article:published_time", content: p.date },
        { property: "article:modified_time", content: p.updated },
        article(p),
        breadcrumbs([
          { name: BRAND.name, path: "/" },
          { name: "Guides", path: "/blog" },
          { name: p.title, path: `/blog/${p.slug}` },
        ]),
        ...(p.faq.length ? [faqPage(p.faq)] : []),
      ],
    });
  },
  component: PostPage,
});

function PostPage() {
  const { meta: post, html, toc, faq } = Route.useLoaderData();
  const related = relatedPosts(post);
  const inline = new Set([...html.matchAll(/<!--\s*tool:([a-z0-9-]+)\s*-->/g)].map((m) => m[1]));
  const more = post.tools.filter((t) => !inline.has(t));
  // Questions go before the list of sources, which closes the article.
  const cut = html.indexOf('<h2 id="sources">');
  const body = cut >= 0 ? html.slice(0, cut) : html;
  const sources = cut >= 0 ? html.slice(cut) : "";
  const contents = faq.length ? [...toc.filter((t) => t.id !== "sources"), { id: "faq", text: "Questions people ask" }, ...toc.filter((t) => t.id === "sources")] : toc;
  return (
    <Page className="pt-6 sm:pt-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[13px] text-ink-3">
        <Link to="/" className="hover:text-ink">
          All tools
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <Link to="/blog" className="hover:text-ink">
          Guides
        </Link>
      </nav>
      <article className="mx-auto mt-6 max-w-3xl">
        <header>
          {post.tags.length ? <p className="text-xs font-semibold tracking-wide text-carbon uppercase">{post.tags.join(" · ")}</p> : null}
          <h1 className="mt-2 text-[30px] leading-tight font-bold tracking-tight sm:text-[40px]">{post.title}</h1>
          <p className="mt-4 text-lg leading-relaxed text-ink-2">{post.description}</p>
          <div className="mt-4">
            <Byline post={post} />
          </div>
        </header>
        {contents.length > 2 ? (
          <nav aria-label="On this page" className="mt-8 rounded-lg border border-line bg-paper p-5">
            <p className="text-sm font-semibold">On this page</p>
            <ol className="mt-2 grid gap-1.5 text-sm">
              {contents.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="text-ink-2 hover:text-carbon">
                    {t.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="mt-8">
          <PostBody html={body} />
        </div>
        {faq.length ? (
          <section id="faq" className="prose-article mt-12 scroll-mt-24">
            <h2>Questions people ask</h2>
            {faq.map((f) => (
              <div key={f.q}>
                <h3>{f.q}</h3>
                <p dangerouslySetInnerHTML={{ __html: f.a }} />
              </div>
            ))}
          </section>
        ) : null}
        {sources ? (
          <div className="mt-12">
            <PostBody html={sources} />
          </div>
        ) : null}
        {more.length ? (
          <section className="mt-12">
            <h2 className="text-xl font-semibold">Tools in this guide</h2>
            {more.map((t) => (
              <ToolCallout key={t} slug={t} className="my-3" />
            ))}
          </section>
        ) : null}
        <AuthorBox post={post} />
      </article>
      {related.length ? (
        <section className="mx-auto mt-16 max-w-5xl border-t border-line pt-10">
          <h2 className="text-xl font-semibold">More guides</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((p) => (
              <li key={p.slug}>
                <PostCard post={p} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}
