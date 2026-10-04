import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

// Nitro packages the server for deployment. It auto-detects the host
// (Vercel, Netlify, Cloudflare, plain Node); set NITRO_PRESET to force one.
export default defineConfig(({ command, isPreview }) => ({
  server: { host: "0.0.0.0", port: 8080 },
  preview: { host: "127.0.0.1", port: 8081 },
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
