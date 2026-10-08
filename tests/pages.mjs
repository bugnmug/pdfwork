// Loads every page at phone and desktop widths; fails on errors or sideways scrolling.
// Usage: node pages.mjs [baseUrl]
import { readdirSync, readFileSync } from "node:fs";
import { launch } from "./lib.mjs";
const base = process.argv[2] ?? "http://127.0.0.1:8080";
const src = readFileSync(new URL("../src/lib/tools/catalog.ts", import.meta.url), "utf8");
const slugs = [...src.matchAll(/slug: "([a-z0-9-]+)"/g)].map((m) => m[1]);
const posts = readdirSync(new URL("../src/content/blog/", import.meta.url)).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => `blog/${f.slice(0, -3)}`);
const paths = ["", "privacy", "about", "blog", ...posts, ...slugs];
const browser = await launch();
const problems = [];
for (const [label, vp] of [["mobile", { width: 375, height: 800, isMobile: true, hasTouch: true }], ["desktop", { width: 1280, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  const page = await ctx.newPage();
  let errs = [];
  page.on("console", (m) => (m.type() === "error") && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  for (const s of paths) {
    errs = [];
    const res = await page.goto(`${base}/${s}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    const status = res?.status();
    if (status !== 200 || sw > cw + 1 || errs.length) problems.push(`${label} /${s}: status ${status}, width ${sw}/${cw}${errs.length ? ", errors: " + errs.slice(0, 2).join(" | ") : ""}`);
    // What search engines read: one h1, a title and description, and structured data that parses.
    const seo = await page.evaluate(() => ({
      h1: document.querySelectorAll("h1").length,
      title: document.title,
      desc: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent ?? ""),
    }));
    const bad = [];
    if (seo.h1 !== 1) bad.push(`${seo.h1} h1`);
    if (!seo.title) bad.push("no title");
    if (seo.desc.length < 50) bad.push(`description ${seo.desc.length} chars`);
    for (const j of seo.ld) {
      try {
        JSON.parse(j);
      } catch {
        bad.push("JSON-LD does not parse");
      }
    }
    if (label === "desktop" && bad.length) problems.push(`/${s}: ${bad.join(", ")}`);
  }
  await ctx.close();
}
console.log(`checked ${paths.length} pages x2`);
console.log(problems.join("\n") || "no problems");
await browser.close();
process.exit(problems.length ? 1 : 0);
