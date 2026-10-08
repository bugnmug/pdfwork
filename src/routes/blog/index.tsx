import { createFileRoute, Link } from "@tanstack/react-router";
import { PostCard } from "@/components/article";
import { Page } from "@/components/shell";
import { POSTS } from "@/lib/blog/posts";
import { BRAND } from "@/lib/brand";
import { breadcrumbs, ld, pageHead, abs } from "@/lib/seo";

const TITLE = `PDF guides for India: passwords, Aadhaar, GST and more | ${BRAND.name}`;
const DESCRIPTION = "Plain answers to everyday PDF problems in India: the password for your e-Aadhaar or bank statement, masking Aadhaar, Hindi OCR, GST invoices, and staying private.";

export const Route = createFileRoute("/blog/")({
  head: () =>
    pageHead({
      title: TITLE,
      description: DESCRIPTION,
      path: "/blog",
      extra: [
        breadcrumbs([
          { name: BRAND.name, path: "/" },
          { name: "Guides", path: "/blog" },
        ]),
        ld({
          "@type": "Blog",
          name: `${BRAND.name} guides`,
          url: abs("/blog"),
          description: DESCRIPTION,
          blogPost: POSTS.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: abs(`/blog/${p.slug}`), datePublished: p.date, dateModified: p.updated })),
        }),
      ],
    }),
  component: BlogIndex,
});

/** Sections of the guide index, in this order; any other first tag follows. */
const ORDER = ["Passwords", "Aadhaar", "Privacy", "Comparisons", "GST", "Hindi"];

function BlogIndex() {
  const firsts = [...new Set(POSTS.map((p) => p.tags[0] ?? "More"))];
  const tags = [...ORDER.filter((t) => firsts.includes(t)), ...firsts.filter((t) => !ORDER.includes(t))];
  return (
    <Page className="pt-10 sm:pt-14">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3">
        <Link to="/" className="hover:text-ink">
          All tools
        </Link>{" "}
        / Guides
      </nav>
      <h1 className="mt-3 text-4xl font-bold tracking-tight">Guides</h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-2">
        Straight answers to the PDF problems people in India run into: locked statements, Aadhaar copies, GST invoices, Hindi scans. Every guide links its sources, and every tool it mentions runs on your own device.
      </p>
      {tags.map((tag) => (
        <section key={tag} className="mt-12">
          <h2 className="text-xl font-bold tracking-tight">{tag}</h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {POSTS.filter((p) => (p.tags[0] ?? "More") === tag).map((p) => (
              <li key={p.slug}>
                <PostCard post={p} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="mt-14 text-sm text-ink-3">
        New guides also appear in the{" "}
        <a href="/blog/rss.xml" className="text-carbon hover:underline">
          RSS feed
        </a>
        .
      </p>
    </Page>
  );
}
