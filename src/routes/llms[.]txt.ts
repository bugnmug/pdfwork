import { createFileRoute } from "@tanstack/react-router";
import { POSTS } from "@/lib/blog/posts";
import { BRAND } from "@/lib/brand";
import { CATEGORIES, TOOLS } from "@/lib/tools/catalog";

/**
 * /llms.txt: a plain summary of the site and links to every tool and guide, in the format
 * proposed at llmstxt.org, for AI assistants and agents that read it.
 */
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = BRAND.url || new URL(request.url).origin;
        const lines = [
          `# ${BRAND.name}`,
          "",
          `> ${BRAND.name} (${origin.replace(/^https?:\/\//, "")}) is a free set of ${TOOLS.length} PDF tools that run entirely in the web browser. Files are processed on the user's own phone or computer and are never uploaded. There is no sign-up, no task limit and no watermark. It is built in India and includes tools for Indian needs such as GST invoices and redacting Aadhaar and PAN numbers.`,
          "",
          "Key facts:",
          "",
          "- Price: free for every tool. No account, no daily or hourly limits, nothing stamped on files.",
          "- Privacy: PDFs are opened and processed inside the browser with JavaScript and WebAssembly, so documents never reach a server. A meter on every page counts the bytes of the user's files sent anywhere; it should read 0 B.",
          "- Works in any modern browser on Android, iPhone, Windows, Mac and Linux. Most tools keep working offline once loaded.",
          "- The few features that use the network say so: optional AI answers in Chat with PDF and the Summarizer (only the question and relevant passages are sent), and P2P File Share and the whiteboard, which connect two browsers.",
          "",
          ...CATEGORIES.flatMap((c) => [`## ${c.name}`, "", ...TOOLS.filter((t) => t.category === c.id).map((t) => `- [${t.name}](${origin}/${t.slug}): ${t.blurb}`), ""]),
          "## Guides",
          "",
          ...POSTS.map((p) => `- [${p.title}](${origin}/blog/${p.slug}): ${p.description}`),
          "",
          "## About",
          "",
          `- [About ${BRAND.name}](${origin}/about): who makes it and how it works`,
          `- [How privacy works](${origin}/privacy): exactly what uses the network and what is stored`,
          "",
        ];
        return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
      },
    },
  },
});
