// UI-level smoke test against a production build: drive real tool pages, download outputs, verify them.
// Usage: node smoke.mjs [baseUrl]  (any build: dev, npm run preview, or a deployed site)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FX, launch } from "./lib.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8081";
const OUT = new URL("./out/smoke/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + "bom.csv", "\uFEFF" + readFileSync(FX + "sample.csv", "utf8"));

const info = (p) => {
  const out = execFileSync("python3", ["-c", "import pymupdf,sys;d=pymupdf.open(sys.argv[1]);print(d.page_count);print(' '.join(x.get_text() for x in d).replace('\\n',' '))", p]).toString();
  const [pages, ...rest] = out.split("\n");
  return { pages: Number(pages), text: rest.join(" ").replace(/\s+/g, " ") };
};

const browser = await launch();
let failed = 0;

async function run(name, slug, files, press, check) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  const notes = [];
  try {
    await page.goto(`${BASE}/${slug}`, { waitUntil: "networkidle", timeout: 60000 });
    await page.locator('input[type="file"]').first().setInputFiles(files);
    await page.getByRole("button", { name: press }).first().click({ timeout: 60000 });
    const perFile = page.getByRole("button", { name: /^Download .+\.pdf$/i }).first();
    const big = page.getByRole("button", { name: /^Download PDF$/ }).first();
    await Promise.race([perFile.waitFor({ timeout: 120000 }), big.waitFor({ timeout: 120000 })]);
    const btn = (await perFile.count()) ? perFile : big;
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), btn.click()]);
    const f = `${OUT}${name}-${dl.suggestedFilename()}`;
    await dl.saveAs(f);
    notes.push(...check(info(f)));
    const meter = await page.locator('[aria-label^="Your files sent to servers"]').first().getAttribute("aria-label");
    notes.push(/: 0 B\./.test(meter ?? "") ? "meter 0 B" : `✗ meter: ${meter}`);
  } catch (e) {
    notes.push("✗ " + e.message.split("\n")[0]);
    await page.screenshot({ path: `${OUT}${name}-FAILED.png` }).catch(() => {});
  }
  for (const e of errors) notes.push("✗ " + e.slice(0, 200));
  const pass = notes.every((n) => !n.startsWith("✗"));
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${notes.join("; ")}`);
  await ctx.close();
}

const want = (t, needles, not = []) => [
  ...needles.map((n) => (t.text.toLowerCase().includes(n.toLowerCase()) ? null : `✗ missing "${n}"`)),
  ...not.map((n) => (t.text.includes(n) ? `✗ still has "${n}"` : null)),
].filter(Boolean);

await run("merge", "merge-pdf", [FX + "text.pdf", FX + "cmp-a.pdf"], "Merge PDFs", (t) => [t.pages === 5 ? "5 pages" : `✗ ${t.pages} pages`, ...want(t, ["Quarterly Operations", "Alpha clause"])]);
await run("csv-bom", "csv-to-pdf", [OUT + "bom.csv"], "Convert to PDF", (t) => [`${t.pages} page(s)`, ...want(t, ["Sharma, Priya", 'Said "hello"']), t.text.includes("﻿") || /ï»¿/.test(t.text) ? "✗ BOM leaked" : "no BOM"]);
await run("markdown", "markdown-to-pdf", [FX + "sample.md"], "Convert to PDF", (t) => [`${t.pages} page(s)`, ...want(t, ["Release Notes", "₹499", "nested item"])]);
await run("auto-redact", "auto-redact", [FX + "text.pdf"], /^Redact selected/, (t) => [`${t.pages} pages`, ...want(t, ["Quarterly", "Consulting hours"], ["priya.sharma@example.com", "ABCDE1234F", "4111 1111 1111 1111", "27ABCDE1234F1Z5"])]);
await run("ocr", "ocr-pdf", [FX + "scan.pdf"], /^Make searchable|^Run OCR|^OCR|^Convert|^Recognize/i, (t) => [`${t.pages} page(s)`, t.text.trim().length > 40 ? `text ${t.text.trim().length} chars` : "✗ no OCR text"]);

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
