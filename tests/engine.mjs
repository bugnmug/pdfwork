// Drive every tool's runTool() inside a real Chromium against the dev server,
// save outputs, and validate them with qpdf / pdftotext / LibreOffice / python.
// Usage: node engine.mjs [baseUrl] [outDir] [caseFilterRegex]  (needs the dev server: npm run dev)
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, extname, basename } from "node:path";
import { CASES } from "./cases.mjs";
import { FX, launch } from "./lib.mjs";

const [, , base = "http://127.0.0.1:8080", outDir = new URL("./out/engine/", import.meta.url).pathname, filter = ""] = process.argv;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".epub": "application/epub+zip",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
};

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function pdfText(path, password) {
  const args = password ? ["-upw", password, "-layout", path, "-"] : ["-layout", path, "-"];
  return sh("pdftotext", args).out;
}

function pdfPages(path) {
  const m = sh("pdfinfo", [path]).out.match(/Pages:\s+(\d+)/);
  return m ? Number(m[1]) : -1;
}

function officeText(path) {
  const dir = join(outDir, "_lo");
  mkdirSync(dir, { recursive: true });
  const r = sh("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, path], { timeout: 120000 });
  const pdf = join(dir, basename(path).replace(/\.[^.]+$/, ".pdf"));
  if (!existsSync(pdf)) return { ok: false, text: "", note: "LibreOffice could not open it: " + r.out.slice(0, 200) };
  return { ok: true, text: pdfText(pdf), pages: pdfPages(pdf) };
}

function extraFiles(c) {
  const out = {};
  for (const v of Object.values(c.options || {})) {
    if (v && typeof v === "object" && v.__file) out[v.__file] = { name: v.__file, type: MIME[extname(v.__file)] || "application/octet-stream", b64: readFileSync(join(FX, v.__file)).toString("base64") };
  }
  return out;
}

const browser = await launch(["--use-fake-ui-for-media-stream"]);
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(base + "/", { waitUntil: "networkidle", timeout: 120000 });

const results = [];
const re = filter ? new RegExp(filter) : null;
for (const c of CASES) {
  if (re && !re.test(c.id)) continue;
  const files = (c.files || []).map((f) => ({
    name: f,
    type: MIME[extname(f)] || "application/octet-stream",
    b64: readFileSync(join(FX, f)).toString("base64"),
  }));
  const t0 = Date.now();
  let res;
  try {
    res = await page.evaluate(
      async ({ slug, files, options, passwords, extra, runPath, catPath }) => {
        const run = await import(runPath);
        const cat = await import(catPath);
        const toFile = (f) => {
          const bin = atob(f.b64);
          const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          return new File([u], f.name, { type: f.type });
        };
        const b64 = (u8) => {
          let s = "";
          const chunk = 0x8000;
          for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
          return btoa(s);
        };
        try {
          const tool = cat.TOOL_BY_SLUG[slug];
          if (!tool) return { ok: false, error: "no such tool: " + slug };
          const opts = { ...(cat.defaultsOf ? cat.defaultsOf(tool.options) : {}), ...options };
          for (const [k, v] of Object.entries(opts)) if (v && typeof v === "object" && v.__file) opts[k] = toFile(extra[v.__file]);
          const out = await run.runTool(tool, { files: files.map(toFile), options: opts, passwords });
          return { ok: true, out: out.map((o) => ({ filename: o.filename, mime: o.mime, b64: b64(o.bytes) })) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      { slug: c.slug, files, options: c.options || {}, passwords: c.passwords || {}, extra: extraFiles(c), runPath: "/src/lib/pdf/run.ts", catPath: "/src/lib/tools/catalog.ts" },
    );
  } catch (e) {
    res = { ok: false, error: "evaluate crashed: " + String(e).slice(0, 300) };
  }
  const ms = Date.now() - t0;
  const caseDir = join(outDir, c.id);
  mkdirSync(caseDir, { recursive: true });
  const saved = [];
  if (res.ok) {
    for (const o of res.out) {
      const p = join(caseDir, o.filename.replace(/\//g, "_"));
      writeFileSync(p, Buffer.from(o.b64, "base64"));
      saved.push({ path: p, mime: o.mime, filename: o.filename, size: Buffer.from(o.b64, "base64").length });
    }
  }
  let verdict = { pass: res.ok, notes: res.ok ? [] : [res.error] };
  if (c.expectError) verdict = res.ok ? { pass: false, notes: ["✗ should have refused"] } : { pass: true, notes: ["refused: " + res.error] };
  else if (res.ok && c.check) {
    try {
      const helpers = { sh, pdfText, pdfPages, officeText, FX, readFileSync, existsSync, join };
      const v = await c.check(saved, helpers);
      verdict = { pass: v.pass, notes: v.notes || [] };
    } catch (e) {
      verdict = { pass: false, notes: ["check crashed: " + String(e).slice(0, 300)] };
    }
  }
  results.push({ id: c.id, slug: c.slug, ms, ...verdict, outputs: saved.map((s) => `${s.filename} (${s.size}b)`) });
  console.log(`${verdict.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(30)} ${String(ms).padStart(6)}ms  ${verdict.notes.join(" | ").slice(0, 300)}`);
}
writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, consoleErrors }, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed. Page errors: ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join("\n"));
await browser.close();
process.exit(passed === results.length && !consoleErrors.length ? 0 : 1);
