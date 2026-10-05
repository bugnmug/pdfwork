import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

// The public address of the site, used for share cards, canonical links and the sitemap.
// SITE_URL wins when set; otherwise the production address the host reports at build time
// (Vercel: VERCEL_PROJECT_PRODUCTION_URL, Netlify: URL). Empty means relative URLs.
function siteUrl(): string {
  const env = process.env;
  const raw =
    env.SITE_URL ||
    (env.NETLIFY === "true" ? env.URL : "") ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return (raw ?? "").trim().replace(/\/+$/, "");
}

// Nitro packages the server for deployment. It auto-detects the host
// (Vercel, Netlify, Cloudflare, plain Node); set NITRO_PRESET to force one.
export default defineConfig(({ command, isPreview }) => ({
  server: { host: "0.0.0.0", port: 8080 },
  preview: { host: "127.0.0.1", port: 8081 },
  define: { __SITE_URL__: JSON.stringify(siteUrl()) },
  resolve: { tsconfigPaths: true },
  worker: { format: "es" },
  optimizeDeps: {
    // Pre-bundle the heavy engines so the dev server never reloads mid-task.
    include: [
      "@cantoo/pdf-lib",
      "@cantoo/fontkit",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "mammoth",
      "xlsx",
      "docx",
      "diff",
      "jszip",
      "pptxgenjs",
      "tesseract.js",
      "qrcode",
      "peerjs",
      "marked",
      "fflate",
    ],
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview ? [nitro()] : []),
    viteReact(),
  ],
}));
