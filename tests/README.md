# Tests

Browser tests that run the real tools in Chromium and check every output with independent tools
(qpdf, Poppler, PyMuPDF, LibreOffice). They live outside the app's `package.json`, so deploys never
install them.

## One-time setup

System tools: Node.js 20+, Python 3 with `pymupdf pillow python-docx python-pptx openpyxl`,
`qpdf`, `poppler-utils` (pdftotext, pdfinfo, pdfimages) and LibreOffice (`soffice`).

```bash
cd tests
npm install                    # playwright-core, plus the PeerJS server for the P2P test
python3 make-fixtures.py       # writes sample PDFs, Office files and images to tests/fixtures/
                               # (engine.mjs also prints the pages in tests/html/ to PDF there)
```

Chromium: set `CHROMIUM_PATH` to a Chromium or Chrome binary, or have Playwright's browsers
installed where `PLAYWRIGHT_BROWSERS_PATH` points (playwright-core 1.56 expects chromium-1194).

## Running

Start the app first (`npm run dev` in the project root), then from `tests/`:

| Command | What it checks | Needs |
| --- | --- | --- |
| `node engine.mjs` | 104 cases across every file tool: merge, split, compress, OCR, conversions, security, redaction, business documents, plus rendering with the tab in the background, rebuilding styled tables in Word, Excel and Markdown, and rebuilding designed documents in Word (a report with cards and callouts, a resume, a two-column CV, an exam paper, an invoice, a contract and a letter, from the pages in `html/`). Each output is opened and verified. Pass a regex as the third argument to run some, e.g. `node engine.mjs http://127.0.0.1:8080 out/engine "merge\|split"` | dev server (it imports source modules) |
| `node smoke.mjs [url]` | Uses five tools through their real pages, downloads the results, checks them, and confirms the privacy meter still reads 0 B | any build: dev, `npm run preview` (port 8081) or a deployed site |
| `node pages.mjs [url]` | Loads all 77 pages at phone and desktop widths; fails on errors or sideways scrolling | any build |
| `node analytics.mjs` | Visit counting runs only on the live address, never sends anything after `#` (P2P share codes), and the privacy meter keeps it apart from your files | a production build served under the live name: `SITE_URL=https://www.doyourpdf.com npm run build`, then `PORT=8082 node .output/server/index.mjs` |
| `node p2p.mjs` | Encrypted transfer between two browsers: wrong password refused, files arrive byte-identical | `node peer-server.mjs`, and the dev server started with `VITE_PEER_HOST=127.0.0.1 VITE_PEER_PORT=9000 VITE_PEER_SECURE=false` |

Each script exits non-zero on failure. Outputs are saved under `tests/out/` for inspection.

## Adding a case

Add an entry to `CASES` in `cases.mjs`: the tool `slug`, input `files` from `fixtures/`, any
`options`, and a `check` that inspects the saved outputs. `expectError: true` marks cases that
must be refused (a wrong password, an impossible page range).
