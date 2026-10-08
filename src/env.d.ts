/** Public site address, injected at build time by vite.config.ts ("" when unknown). */
declare const __SITE_URL__: string;

/** Every blog post's front matter, newest first (scripts/vite-blog.ts). */
declare module "virtual:blog-posts" {
  const posts: import("./lib/blog/types").PostMeta[];
  export default posts;
}

/** A blog post, rendered at build time (scripts/vite-blog.ts). */
declare module "*.md" {
  export const meta: import("./lib/blog/types").PostMeta;
  export const html: string;
  export const toc: import("./lib/blog/types").TocEntry[];
  export const faqHtml: import("./lib/blog/types").Faq[];
}
