// Copies the engines that run in the browser (OCR, PDF rendering data) from
// node_modules into public/vendor so the site serves them itself. Nothing is
// fetched from a third-party CDN at runtime, which keeps the "files never leave
// your device" promise honest and lets the tools work offline once loaded.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "vendor");

function copy(from, to, filter) {
  const src = join(nm, from);
  if (!existsSync(src)) throw new Error(`[copy-assets] missing ${src}. Run npm install first.`);
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(src, join(out, to), { recursive: true, filter });
}

// Tesseract OCR: worker, LSTM-only WebAssembly cores (plain, SIMD, relaxed SIMD), language data.
copy("tesseract.js/dist/worker.min.js", "tesseract/worker.min.js");
mkdirSync(join(out, "tesseract", "core"), { recursive: true });
for (const f of readdirSync(join(nm, "tesseract.js-core"))) {
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.wasm\.js$/.test(f)) {
    copy(join("tesseract.js-core", f), join("tesseract", "core", f));
  }
}
for (const lang of ["eng", "hin"]) {
  copy(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, `tesseract/lang/${lang}.traineddata.gz`);
}

// PDF.js data files: character maps (CJK text), standard font metrics, image decoders.
copy("pdfjs-dist/cmaps", "pdfjs/cmaps");
copy("pdfjs-dist/standard_fonts", "pdfjs/standard_fonts");
copy("pdfjs-dist/wasm", "pdfjs/wasm", (p) => !/LICENSE/.test(p) || true);
copy("pdfjs-dist/iccs", "pdfjs/iccs");

console.log("[copy-assets] engines copied to public/vendor");
