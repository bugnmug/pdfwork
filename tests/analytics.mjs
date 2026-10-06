// Visit counting: only on the live address, never anything after "#" (share codes), and the
// privacy meter keeps it apart from "your files". Needs a production build served under the
// live host name, which this script maps to 127.0.0.1:
//   SITE_URL=https://www.doyourpdf.com npm run build && PORT=8082 node .output/server/index.mjs
//   node analytics.mjs [http://www.doyourpdf.com:8082] [http://127.0.0.1:8082]
import { launch } from "./lib.mjs";

const [, , live = "http://www.doyourpdf.com:8082", local = "http://127.0.0.1:8082"] = process.argv;
const host = new URL(live).hostname;
// Stand-in for Plausible's script: the same queue/init contract, a POST per page view.
const TRACKER = `(function () {
  var o = (window.plausible && window.plausible.o) || {};
  function send(n) {
    var p = { n: n, u: location.href, d: "${host.replace(/^www\./, "")}", r: document.referrer || null };
    if (typeof o.transformRequest === "function") p = o.transformRequest(p);
    fetch("https://plausible.io/api/event", { method: "POST", headers: { "Content-Type": "text/plain" }, keepalive: true, body: JSON.stringify(p) });
  }
  send("pageview");
  var push = history.pushState;
  history.pushState = function () { push.apply(this, arguments); send("pageview"); };
})();`;

const results = [];
const check = (ok, note) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${note}`);
};
const browser = await launch([`--host-resolver-rules=MAP ${host} 127.0.0.1`]);

async function open(base, path) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const events = [];
  let loads = 0;
  await ctx.route("https://plausible.io/js/**", (r) => (loads++, r.fulfill({ status: 200, contentType: "application/javascript", body: TRACKER })));
  await ctx.route("https://plausible.io/api/event", (r) => (events.push(JSON.parse(r.request().postData() || "{}")), r.fulfill({ status: 202, body: "ok" })));
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(800);
  return { ctx, page, events, loads: () => loads };
}
const meter = (page) => page.locator('header [aria-label^="Your files sent to servers"]').first().getAttribute("aria-label");

{
  const s = await open(local, "/");
  check(s.loads() === 0 && s.events.length === 0, "no visit counting off the live address");
  await s.ctx.close();
}
{
  const s = await open(live, "/p2p-share#k7m2qa");
  check(s.loads() === 1, "visit counter loads on the live address");
  check(s.events.length === 1 && !s.events[0].u.includes("#"), `share code not sent (${s.events[0]?.u})`);
  check(/servers: 0 B\. Visit count: \d+ B\./.test((await meter(s.page)) ?? ""), `meter keeps it apart: ${await meter(s.page)}`);
  await s.page.goto(live + "/", { waitUntil: "networkidle" });
  await s.page.locator('a[href="/merge-pdf"]').first().click();
  await s.page.waitForURL("**/merge-pdf");
  await s.page.waitForTimeout(500);
  check(s.events.some((e) => e.u.endsWith("/merge-pdf")), "in-app page changes are counted");
  await s.page.locator('header [aria-label^="Your files sent to servers"]').first().click();
  check((await s.page.locator("text=/Visit count ·/").count()) >= 1, "meter lists the visit count by name");
  await s.ctx.close();
}
await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
