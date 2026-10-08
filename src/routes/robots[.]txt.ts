import { createFileRoute } from "@tanstack/react-router";
import { BRAND } from "@/lib/brand";

/**
 * Everyone may crawl everything. Search engines and AI answer engines (ChatGPT, Claude,
 * Perplexity, Gemini, Copilot) are named on purpose: being in their indexes is how the site
 * gets found and recommended.
 */
const AGENTS = ["Googlebot", "Bingbot", "OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot", "Applebot-Extended", "DuckDuckBot", "Meta-ExternalAgent", "CCBot"];

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        const body = [
          "# Search engines and AI assistants are welcome to read and cite every page.",
          ...AGENTS.flatMap((a) => [`User-agent: ${a}`, "Allow: /", ""]),
          "User-agent: *",
          "Allow: /",
          "",
          `Sitemap: ${origin}/sitemap.xml`,
          "",
        ].join("\n");
        return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
