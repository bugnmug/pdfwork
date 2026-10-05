// Loads every page at phone and desktop widths; fails on errors or sideways scrolling.
// Usage: node pages.mjs [baseUrl]
import { readFileSync } from "node:fs";
import { launch } from "./lib.mjs";
const base = process.argv[2] ?? "http://127.0.0.1:8080";
const src = readFileSync(new URL("../src/lib/tools/catalog.ts", import.meta.url), "utf8");
const slugs = [...src.matchAll(/slug: "([a-z0-9-]+)"/g)].map((m) => m[1]);
const browser = await launch();
const problems = [];
for (const [label, vp] of [["mobile", { width: 375, height: 800, isMobile: true, hasTouch: true }], ["desktop", { width: 1280, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  const page = await ctx.newPage();
  let errs = [];
  page.on("console", (m) => (m.type() === "error") && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  for (const s of ["", "privacy", ...slugs]) {
    errs = [];
    const res = await page.goto(`${base}/${s}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    const status = res?.status();
    if (status !== 200 || sw > cw + 1 || errs.length) problems.push(`${label} /${s}: status ${status}, width ${sw}/${cw}${errs.length ? ", errors: " + errs.slice(0, 2).join(" | ") : ""}`);
  }
  await ctx.close();
}
console.log(`checked ${slugs.length + 2} pages x2`);
console.log(problems.join("\n") || "no problems");
await browser.close();
process.exit(problems.length ? 1 : 0);
