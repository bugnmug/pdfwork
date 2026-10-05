import { createFileRoute } from "@tanstack/react-router";
import { BRAND } from "@/lib/brand";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
