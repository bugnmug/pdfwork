import { createFileRoute } from "@tanstack/react-router";
import { authorOf, POSTS } from "@/lib/blog/posts";
import { BRAND } from "@/lib/brand";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rfc822 = (iso: string) => new Date(`${iso}T06:00:00Z`).toUTCString();

/** /blog/rss.xml: the guides as an RSS feed, for feed readers and crawlers that watch feeds. */
export const Route = createFileRoute("/blog/rss.xml")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        const items = POSTS.map(
          (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${origin}/blog/${p.slug}</link>
      <guid isPermaLink="true">${origin}/blog/${p.slug}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <dc:creator>${esc(authorOf(p.author).name)}</dc:creator>
      <description>${esc(p.description)}</description>
${p.tags.map((t) => `      <category>${esc(t)}</category>`).join("\n")}
    </item>`,
        ).join("\n");
        const latest = POSTS.reduce((m, p) => (p.updated > m ? p.updated : m), "1970-01-01");
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(BRAND.name)} guides</title>
    <link>${origin}/blog</link>
    <atom:link href="${origin}/blog/rss.xml" rel="self" type="application/rss+xml"/>
    <description>${esc("Plain answers to everyday PDF problems in India, from the makers of " + BRAND.name + ".")}</description>
    <language>en-in</language>
    <lastBuildDate>${rfc822(latest)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
        return new Response(body, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
