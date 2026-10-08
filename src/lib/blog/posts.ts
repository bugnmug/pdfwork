import posts from "virtual:blog-posts";
import type { PostMeta, PostModule } from "./types";

/** Every post's front matter, newest first. */
export const POSTS: PostMeta[] = posts;
export const POST_BY_SLUG: Record<string, PostMeta> = Object.fromEntries(POSTS.map((p) => [p.slug, p]));

const modules = import.meta.glob<PostModule>(["/src/content/blog/*.md", "!/src/content/blog/_*.md"]);

/** A post's rendered HTML and table of contents, loaded on demand. */
export async function loadPost(slug: string): Promise<PostModule | null> {
  const load = modules[`/src/content/blog/${slug}.md`];
  return load ? await load() : null;
}

/** Posts that use a tool, for the "guides" list on its page; posts mainly about it come first. */
export function postsForTool(slug: string): PostMeta[] {
  return POSTS.filter((p) => p.tools.includes(slug)).sort((a, b) => a.tools.indexOf(slug) - b.tools.indexOf(slug));
}

/** Other posts worth reading next: shared tools or tags first, then the newest. */
export function relatedPosts(post: PostMeta, n = 3): PostMeta[] {
  const score = (p: PostMeta) => p.tools.filter((t) => post.tools.includes(t)).length * 2 + p.tags.filter((t) => post.tags.includes(t)).length;
  return POSTS.filter((p) => p.slug !== post.slug)
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s || b.p.date.localeCompare(a.p.date))
    .slice(0, n)
    .map((x) => x.p);
}

export const AUTHORS: Record<string, { name: string; role: string; bio: string }> = {
  harsh: {
    name: "Harsh",
    role: "Founder, DoYourPDF",
    bio: "Harsh started DoYourPDF so that Aadhaar cards, bank statements and contracts never have to be uploaded to a stranger's server just to be unlocked, compressed or signed.",
  },
};

export function authorOf(key: string) {
  return AUTHORS[key] ?? AUTHORS.harsh;
}

/** "8 Oct 2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}
