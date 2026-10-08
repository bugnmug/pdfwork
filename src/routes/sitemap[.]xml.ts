import { createFileRoute } from "@tanstack/react-router";
import { POSTS } from "@/lib/blog/posts";
import { BRAND } from "@/lib/brand";
import { TOOLS } from "@/lib/tools/catalog";

/**
 * /sitemap.xml: every page search engines should know about. Guides carry their real
 * last-changed date (search engines distrust a date that changes on every deploy, so pages
 * without a known date carry none).
 */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        const latest = POSTS.reduce((m, p) => (p.updated > m ? p.updated : m), "");
        const entries: { path: string; lastmod?: string }[] = [
          { path: "/" },
          { path: "/blog", lastmod: latest || undefined },
          ...POSTS.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.updated })),
          ...TOOLS.map((t) => ({ path: `/${t.slug}` })),
          { path: "/about" },
          { path: "/privacy" },
        ];
        const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
          .map((e) => `  <url><loc>${origin}${e.path}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`)
          .join("\n")}\n</urlset>\n`;
        return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
