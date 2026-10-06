// Copies the engines that run in the browser (OCR, PDF rendering data) from
// node_modules into public/vendor so the site serves them itself. Nothing is
// fetched from a third-party CDN at runtime, which keeps the "files never leave
// your device" promise honest and lets the tools work offline once loaded.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

await buildPdfWorker();

console.log("[copy-assets] engines copied to public/vendor");

/**
 * The PDF.js worker, with three changes to how it extracts text, then minified.
 *
 * 1. ActualText. PDF writers (Chrome among them) wrap glyphs whose meaning the font
 *    can't express, such as typographic quotes, ligatures and case-sensitive
 *    punctuation, in a marked-content span that states the real text. PDF.js ignores
 *    it and returns stand-in characters (U+02BC for an apostrophe, private-use codes
 *    for a hyphen). Here the span's text replaces its glyphs.
 * 2. Letter-spacing. Many writers (Chrome included) emit no space characters and
 *    leave gaps instead, which PDF.js turns into spaces. In tracked-out labels every
 *    letter has a gap, so they came back as "C A R E E R". Each inferred space is now
 *    a marker (U+0091) plus the gap's width in thousandths of the font size, encoded
 *    as one private-use character, so pageText() in src/lib/pdf/pdfjs.ts can tell
 *    letter-spacing from word breaks. Real space characters are untouched.
 * 3. Colour. Each text item reports its fill colour, so conversions can keep it.
 *
 * PDF.js is pinned to an exact version in package.json; if an upgrade moves the code,
 * this step fails instead of shipping an unpatched worker.
 */
async function buildPdfWorker() {
  const src = join(nm, "pdfjs-dist/legacy/build/pdf.worker.mjs");
  const dest = join(out, "pdfjs", "pdf.worker.mjs");
  const self = fileURLToPath(import.meta.url);
  if (existsSync(dest) && statSync(dest).mtimeMs > Math.max(statSync(src).mtimeMs, statSync(self).mtimeMs)) return;
  let code = readFileSync(src, "utf8");
  const patch = (name, from, to) => {
    const n = code.split(from).length - 1;
    if (n !== 1) throw new Error(`[copy-assets] PDF.js worker patch "${name}" matched ${n} places; PDF.js changed, update scripts/copy-assets.mjs`);
    code = code.replace(from, to);
  };
  patch(
    "actual-text stack",
    "    let markedContentLevel = 0;\n    let textMarkedContentLevel = null;\n",
    "    let markedContentLevel = 0;\n    let textMarkedContentLevel = null;\n    const actualTexts = [];\n",
  );
  patch(
    "BMC",
    "          case OPS.beginMarkedContent:\n            flushTextContentItem();\n",
    "          case OPS.beginMarkedContent:\n            flushTextContentItem();\n            actualTexts.push(null);\n",
  );
  patch(
    "BDC",
    "          case OPS.beginMarkedContentProps:\n            flushTextContentItem();\n",
    `          case OPS.beginMarkedContentProps:
            flushTextContentItem();
            {
              let props = args[1];
              let actual = null;
              try {
                if (props instanceof Name) props = resources.get("Properties")?.get(props.name);
                const t = props instanceof Dict ? props.get("ActualText") : null;
                if (typeof t === "string") actual = { text: stringToPDFString(t), used: false };
              } catch {}
              actualTexts.push(actual);
            }
`,
  );
  patch(
    "EMC",
    "          case OPS.endMarkedContent:\n            flushTextContentItem();\n",
    "          case OPS.endMarkedContent:\n            flushTextContentItem();\n            actualTexts.pop();\n",
  );
  patch(
    "glyph text",
    "        const glyphUnicode = glyph.unicode;\n        if (saveLastChar(glyphUnicode)) {\n",
    `        let glyphUnicode = glyph.unicode;
        for (let k = actualTexts.length - 1; k >= 0; k--) {
          const a = actualTexts[k];
          if (a) {
            glyphUnicode = a.used ? "" : a.text;
            a.used = true;
            break;
          }
        }
        if (saveLastChar(glyphUnicode)) {
`,
  );
  patch(
    "fake space marker",
    '        if (textContentItem.initialized) {\n          resetLastChars();\n          textContentItem.str.push(" ");\n',
    // The gap's width (thousandths of the font size), then where in the item it starts
    // (hundredths of a unit of the item's width, as two 12-bit characters): text that ran
    // together across a narrow gap (table cells) can be cut there exactly.
    '        if (textContentItem.initialized) {\n          resetLastChars();\n          const dypOff = Math.min(16777215, Math.round(Math.abs(textContentItem.totalWidth + textContentItem.width * textContentItem.textAdvanceScale) * 100));\n          textContentItem.str.push("\\u0091" + String.fromCharCode(0xe000 + Math.min(4095, Math.round(Math.abs(width / textContentItem.spaceInFlowMin) * SPACE_IN_FLOW_MIN_FACTOR * 1000))) + "\\u0092" + String.fromCharCode(0xe000 + (dypOff >> 12)) + String.fromCharCode(0xe000 + (dypOff & 4095)));\n',
  );
  // 3. Text colour: track the fill colour and report it on each item, starting a new
  //    item where the colour changes. Colours in spaces that can't be read without
  //    rendering (spot colours, patterns) are reported as "?".
  patch(
    "fill colour helpers",
    "class TextState {\n",
    `function dypFillComponents(cs, resources, xref, depth = 0) {
  if (!(cs instanceof Name) || depth > 3) return 0;
  const name = cs.name;
  if (name === "DeviceGray" || name === "G" || name === "CalGray") return 1;
  if (name === "DeviceRGB" || name === "RGB" || name === "CalRGB") return 3;
  if (name === "DeviceCMYK" || name === "CMYK") return 4;
  const v = resources instanceof Dict ? resources.get("ColorSpace")?.get(name) : null;
  if (v instanceof Name) return dypFillComponents(v, null, xref, depth + 1);
  if (Array.isArray(v) && v[0] instanceof Name) {
    if (v[0].name === "ICCBased") {
      const n = xref.fetchIfRef(v[1])?.dict?.get("N");
      return n === 1 || n === 3 || n === 4 ? n : 0;
    }
    if (v[0].name === "CalRGB") return 3;
    if (v[0].name === "CalGray") return 1;
  }
  return 0;
}
function dypHex(n, k) {
  let r, g, b;
  if (k === 1) r = g = b = n[0];
  else if (k === 3) [r, g, b] = n;
  else {
    r = (1 - n[0]) * (1 - n[3]);
    g = (1 - n[1]) * (1 - n[3]);
    b = (1 - n[2]) * (1 - n[3]);
  }
  const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
class TextState {
`,
  );
  patch(
    "fill colour operators",
    "          case OPS.setTextRise:\n            textState.textRise = args[0];\n            break;\n",
    `          case OPS.setTextRise:
            textState.textRise = args[0];
            break;
          case OPS.setFillColorSpace:
          case OPS.setFillGray:
          case OPS.setFillRGBColor:
          case OPS.setFillCMYKColor:
          case OPS.setFillColor:
          case OPS.setFillColorN:
            {
              let color = "?";
              try {
                const n = args.filter((a) => typeof a === "number");
                let k = textState.fillComponents ?? 1;
                if (fn === OPS.setFillColorSpace) {
                  k = dypFillComponents(args[0], resources, xref);
                  color = k ? "#000000" : "?";
                } else if (fn === OPS.setFillGray) k = 1;
                else if (fn === OPS.setFillRGBColor) k = 3;
                else if (fn === OPS.setFillCMYKColor) k = 4;
                if (fn !== OPS.setFillColorSpace) color = k && n.length === k ? dypHex(n, k) : "?";
                textState.fillComponents = k;
              } catch {}
              if (color !== (textState.fillColor ?? "#000000")) flushTextContentItem();
              textState.fillColor = color;
            }
            break;
`,
  );
  patch(
    "item colour",
    "      textContentItem.fontName = loadedName;\n      const trm = textContentItem.transform = getCurrentTextTransform();\n",
    "      textContentItem.fontName = loadedName;\n      textContentItem.color = textState.fillColor ?? \"#000000\";\n      const trm = textContentItem.transform = getCurrentTextTransform();\n",
  );
  patch(
    "item colour out",
    "        fontName: textChunk.fontName,\n        hasEOL: textChunk.hasEOL\n      };\n    }\n    async function handleSetFont",
    "        fontName: textChunk.fontName,\n        color: textChunk.color,\n        hasEOL: textChunk.hasEOL\n      };\n    }\n    async function handleSetFont",
  );
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = dest.replace(/\.mjs$/, ".patched.mjs");
  writeFileSync(tmp, code);
  const { build } = await import("rolldown");
  await build({ input: tmp, logLevel: "silent", output: { file: dest, format: "esm", minify: true } });
  rmSync(tmp);
}
