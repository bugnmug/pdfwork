/** A blog post's front matter plus what the build works out (see scripts/vite-blog.ts). */
export type Faq = { q: string; a: string };

export type PostMeta = {
  slug: string;
  title: string;
  /** Shorter title for the browser tab and search results; defaults to `title`. */
  seoTitle?: string;
  description: string;
  /** ISO dates, YYYY-MM-DD. */
  date: string;
  updated: string;
  author: string;
  tags: string[];
  /** Slugs of the tools the post uses; they get cards on the post and link back from the tool pages. */
  tools: string[];
  faq: Faq[];
  readingMinutes: number;
  words: number;
};

export type TocEntry = { id: string; text: string };

export type PostModule = {
  meta: PostMeta;
  html: string;
  toc: TocEntry[];
  /** FAQ answers rendered from Markdown. */
  faqHtml: Faq[];
};
