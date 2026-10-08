/**
 * Structured data (schema.org JSON-LD) and shared head tags. Search engines and AI answer
 * engines read these to understand what a page is: a free web app, an article and its author,
 * questions and answers, where the page sits in the site.
 */
import { authorOf } from "@/lib/blog/posts";
import type { PostMeta } from "@/lib/blog/types";
import { BRAND } from "@/lib/brand";
import type { Tool } from "@/lib/tools/catalog";

export const abs = (path: string) => `${BRAND.url}${path}`;

/** A head `meta` entry TanStack renders as <script type="application/ld+json">. */
export const ld = (data: Record<string, unknown>) => ({ "script:ld+json": { "@context": "https://schema.org", ...data } });

const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export const ORG_ID = abs("/#organization");

export function organization() {
  return ld({
    "@type": "Organization",
    "@id": ORG_ID,
    name: BRAND.name,
    url: abs("/"),
    logo: abs("/favicon.svg"),
    description: BRAND.description,
    founder: { "@type": "Person", name: "Harsh", url: abs("/about") },
  });
}

export function website() {
  return ld({
    "@type": "WebSite",
    "@id": abs("/#website"),
    name: BRAND.name,
    url: abs("/"),
    description: BRAND.description,
    inLanguage: "en-IN",
    publisher: { "@id": ORG_ID },
  });
}

export function webApp(tool: Tool) {
  return ld({
    "@type": "WebApplication",
    name: `${tool.name} by ${BRAND.name}`,
    url: abs(`/${tool.slug}`),
    description: `${tool.blurb} ${tool.long}`,
    applicationCategory: tool.category === "business" ? "BusinessApplication" : "UtilitiesApplication",
    operatingSystem: "Any device with a modern web browser",
    browserRequirements: "Requires JavaScript. Files are processed inside the browser and are not uploaded.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "INR" },
    publisher: { "@id": ORG_ID },
  });
}

export function breadcrumbs(items: { name: string; path: string }[]) {
  return ld({
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: abs(it.path) })),
  });
}

export function faqPage(faq: { q: string; a: string }[]) {
  return ld({
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({ "@type": "Question", name: plain(f.q), acceptedAnswer: { "@type": "Answer", text: plain(f.a) } })),
  });
}

export function article(post: PostMeta) {
  const author = authorOf(post.author);
  return ld({
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.updated,
    inLanguage: "en-IN",
    wordCount: post.words,
    keywords: post.tags.join(", "),
    image: abs("/og.jpg"),
    mainEntityOfPage: abs(`/blog/${post.slug}`),
    author: { "@type": "Person", name: author.name, jobTitle: author.role, url: abs("/about") },
    publisher: { "@id": ORG_ID, "@type": "Organization", name: BRAND.name, logo: { "@type": "ImageObject", url: abs("/favicon.svg") } },
  });
}

/** Title, description, canonical and share-card tags for one page. */
export function pageHead(o: { title: string; description: string; path: string; type?: "website" | "article"; extra?: Record<string, unknown>[] }) {
  return {
    meta: [
      { title: o.title },
      { name: "description", content: o.description },
      { property: "og:title", content: o.title },
      { property: "og:description", content: o.description },
      { property: "og:type", content: o.type ?? "website" },
      ...(BRAND.url ? [{ property: "og:url", content: abs(o.path) }] : []),
      { name: "twitter:title", content: o.title },
      { name: "twitter:description", content: o.description },
      ...(o.extra ?? []),
    ],
    links: BRAND.url ? [{ rel: "canonical", href: abs(o.path) }] : [],
  };
}
