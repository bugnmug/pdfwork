# SpitePDF

Every PDF tool. None of the uploading.

SpitePDF is a free suite of 75 PDF tools that run entirely in the browser. Files are opened, processed and saved on the user's own device; nothing is uploaded. A live meter in the header counts every byte the page sends to any server, so the claim can be checked rather than trusted.

## What's included

| Area | Tools |
| --- | --- |
| Organize | Merge, split (ranges, every N pages, each page), remove and extract pages, organize pages visually (drag, rotate, duplicate, blank pages, pages from other PDFs), rotate, alternate and mix, split by text, by bookmarks, by file size, split spreads in half, pages per sheet (N-up), crop (margins or automatic), resize to paper, flip, PDF to ZIP of pages |
| Optimize | Compress (DPI-aware image recompression, duplicate removal, extreme mode), repair, OCR to searchable PDF (English and Hindi), grayscale, PDF/A |
| Edit and sign | Full page editor (text, edit existing text, freehand, highlight, whiteout, shapes, arrows, images), sign (draw, type or upload with background removal; saved signatures), fill forms, watermark (text or image, tiled), page numbers, headers and footers, Bates numbering, stamps and seals, flatten, dark mode, metadata, PDF to handwriting |
| To PDF | Images, Word (.docx), Excel, PowerPoint (.pptx, with layout, shapes, pictures, tables and charts), HTML, Markdown, CSV, text, EPUB, camera scanner (edge detection, perspective correction, clean-up filters, optional OCR), text to handwriting, drawing pad, dictation |
| From PDF | Word (editable or exact look), Excel and CSV (column detection), PowerPoint, JPG/PNG/WebP, extract images at original quality, text, HTML, Markdown, EPUB, read aloud |
| Security | Password protection (AES-256 with permissions), unlock, true redaction (manual boxes and search), automatic PII redaction (Aadhaar with Verhoeff check, PAN, GSTIN, IFSC, UPI, cards with Luhn, IBAN, phone, email and more), privacy risk scanner, hidden-data removal, file fingerprints (SHA-256, SHA-1, MD5) with verification |
| AI and analysis | Chat with PDF and summaries with page references (on-device by default; optional server AI), compare two PDFs (word diff, visual diff, report) |
| Business | GST invoice (CGST/SGST or IGST from state codes, HSN summary, amount in words, UPI QR), thermal POS receipts, GST filing working paper (B2B/B2C by rate, CSV import and export), resume builder with live preview |
| Share and automate | P2P file share (WebRTC, optional end-to-end password encryption), collaborative whiteboard (live, multi-page, PDF import, PDF/PNG export), batch workflows (chain tools, save presets) |

Text in generated PDFs uses embedded Noto fonts with proper shaping, so ₹, Hindi (Devanagari) and common symbols render correctly.

## How privacy works

- Files are read with the File API and processed by JavaScript and WebAssembly in the tab: pdf-lib for writing, PDF.js for reading and rendering, Tesseract for OCR.
- Every engine, font and data file is served by the site itself (`public/vendor`, `public/fonts`). There are no CDN calls, no analytics and no trackers.
- `src/lib/netmeter.ts` wraps `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` and `RTCDataChannel` and adds up outgoing bytes. The header pill shows the total and a list of every request with a body.
- Optional features that do use the network say so in the interface: AI answers send only the question and the relevant passages; P2P share and the whiteboard use a connection broker, with data flowing directly between browsers.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # http://localhost:8080
```

`npm run dev` and `npm run build` first run `scripts/copy-assets.mjs`, which copies the OCR engine, OCR language data and PDF.js data files from `node_modules` into `public/vendor` (about 20 MB, not committed).

Other scripts:

```bash
npm run build      # production build into .output
npm run preview    # serve the production build on http://127.0.0.1:8081
npm run typecheck
npm run lint
```

## Deploying

The app is a TanStack Start project packaged by Nitro, which detects the host during the build. Each of these has been built and run locally with that host's output format.

- **Vercel** (recommended): import the repository and press Deploy. No settings to change.
- **Netlify**: import the repository; `netlify.toml` sets the build command, publish folder and Node version.
- **Cloudflare Workers**: build with `NITRO_PRESET=cloudflare_module npm run build` and deploy `.output` with Wrangler.
- **Any Node server**: `npm run build`, then `node .output/server/index.mjs` (listens on `PORT`, default 3000).

The public address used for share cards, canonical links and the sitemap is filled in at build time from the host (Vercel's production domain, Netlify's main URL). Elsewhere, set `SITE_URL=https://your.domain` when building. After adding a custom domain, redeploy once so the address updates.

Free plans compared for this app (each visitor downloads about 0.25 MB for the page, 1 to 2 MB the first time they use a tool, about 6 MB for OCR):

| | Vercel Hobby | Netlify Free |
| --- | --- | --- |
| Monthly downloads included | 100 GB | 300 credits; 20 per GB, so at most 15 GB |
| Deploys | free | 15 credits each |
| Commercial use (ads, selling) | not allowed; Pro is $20/month | allowed |
| When the limit is hit | site paused until the month resets | site paused until the month resets |

## Optional configuration

All of these are optional. Without them every tool still works, using the on-device engines.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables AI answers and AI summaries with Claude (default model `claude-haiku-4-5-20251001`). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | AI answers via OpenAI or a compatible provider; also enables MP3 export in PDF to Audio and recording transcription in Audio to PDF. |
| `XAI_API_KEY` | AI answers via xAI; also enables MP3 export. |
| `AI_MODEL`, `AI_TTS_MODEL`, `AI_STT_MODEL` | Override the chat, speech and transcription models. |
| `AI_DAILY_LIMIT` | Per-IP daily request cap for the AI endpoints (default 60, per server instance). |
| `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE` | Use your own [PeerJS server](https://github.com/peers/peerjs-server) for P2P share and the whiteboard instead of the public PeerJS broker. Set at build time. |

## Renaming

The product name, tagline and description live in `src/lib/brand.ts`. Page titles, the header, footer, share cards and the producer field of generated PDFs all read from it. Replace `public/favicon.svg` and `public/og.jpg` to match.

## Testing

`tests/` holds browser tests that run every tool in Chromium and verify the outputs with qpdf, Poppler, PyMuPDF and LibreOffice: 93 engine cases (including rendering with the tab in the background), a smoke test that also checks the privacy meter, a page sweep at phone and desktop widths, and an encrypted P2P transfer. See `tests/README.md` for setup.

## Project layout

```
src/
  routes/            pages: home, /$slug tool pages, /privacy, sitemap and robots
  tools/             interactive tool screens (editor, organizer, scanner, share, whiteboard…)
  components/        UI primitives, header and footer, drop zone, results, privacy meter
  lib/pdf/           the PDF engine: one module per job (pages, compress, ocr, redact, office…)
  lib/pdf/run.ts     maps every catalogue tool to the engine
  lib/tools/catalog.ts  the tool catalogue: names, descriptions, options, steps
  lib/ai/            on-device summarizer and search; optional server AI functions
scripts/copy-assets.mjs  copies browser engines into public/vendor
tests/               browser tests and fixture generator (separate package.json)
```

To add a tool that takes files and options, add an entry to `TOOLS` in `catalog.ts` and a case in `run.ts`; the generic workspace renders the upload area, options form, progress and results.

## Limitations

- Legacy `.doc`, `.xls` and `.ppt` binaries are not converted (Excel's `.xls` is supported); complex Word layouts such as text boxes and multi-column sections are simplified.
- Chinese, Japanese and Korean glyphs are not bundled for generated text, to keep downloads small. Existing CJK text in PDFs is unaffected.
- OCR ships English and Hindi data. More languages can be added in `scripts/copy-assets.mjs` and `src/lib/pdf/ocr.ts`.
- P2P share and the whiteboard need both devices online at the same time and rely on a broker and, when a direct route isn't possible, a TURN relay (the relay only sees encrypted traffic).
- Spreadsheet parsing uses SheetJS 0.18.5 from npm, which has published advisories for crafted files. Parsing happens in the user's own browser on files they chose; the SheetJS CDN build (0.20.x) can be swapped in to remove the advisories.

## Credits and licences

PDF.js (Apache-2.0), pdf-lib and fontkit forks by Cantoo (MIT), Tesseract.js (Apache-2.0), mammoth (BSD-2-Clause), SheetJS (Apache-2.0), docx (MIT), PptxGenJS (MIT), PeerJS (MIT), marked (MIT), jsdiff (BSD-3-Clause), Noto fonts, Caveat and Kalam (SIL Open Font License), DejaVu fonts (Bitstream Vera licence). Licence texts for bundled fonts are in `public/fonts`.
