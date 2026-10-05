import { createFileRoute } from "@tanstack/react-router";
import { BRAND } from "@/lib/brand";
import { TOOLS } from "@/lib/tools/catalog";

/** /sitemap.xml: every tool page, so search engines can find them. */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        const paths = ["/", "/privacy", ...TOOLS.map((t) => `/${t.slug}`)];
        const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n")}\n</urlset>\n`;
        return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
