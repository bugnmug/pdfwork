// End-to-end test of encrypted P2P share between two browsers.
// Needs: the peer server (node peer-server.mjs) and the dev server started with
//   VITE_PEER_HOST=127.0.0.1 VITE_PEER_PORT=9000 VITE_PEER_SECURE=false npm run dev
// Usage: node p2p.mjs [baseUrl]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { FX, launch } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const OUT = new URL("./out/p2p/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await launch();
const logs = [];
const failures = [];
const mk = async (label) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && logs.push(`${label}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`${label} pageerror: ${e.message}`));
  return page;
};

const send = await mk("sender");
await send.goto(`${base}/p2p-share`, { waitUntil: "networkidle" });
await send.setInputFiles("input[type=file]", [`${FX}heavy.pdf`, `${FX}photo.jpg`]);
await send.fill("input[type=password]", "hunter22");
await send.click("button:has-text('Start sharing')");
await send.waitForSelector("text=Share code", { timeout: 20000 });
const code = (await send.textContent("p.font-mono")).trim();
console.log("share code", code);

const recv = await mk("receiver");
await recv.goto(`${base}/p2p-share#${code}`, { waitUntil: "networkidle" });
await recv.waitForSelector("text=password-protected", { timeout: 20000 });
await recv.fill("input[type=password]", "wrong");
await recv.click("button:has-text('Unlock and receive')");
await recv.waitForSelector("text=isn't right", { timeout: 20000 });
console.log("wrong password rejected");
await recv.fill("input[type=password]", "hunter22");
await recv.click("button:has-text('Unlock and receive')");
await recv.waitForSelector("text=Received", { timeout: 60000 });

for (const name of ["heavy.pdf", "photo.jpg"]) {
  const [dl] = await Promise.all([recv.waitForEvent("download"), recv.click(`button[aria-label='Download ${name}']`)]);
  const out = OUT + name;
  await dl.saveAs(out);
  const same = createHash("sha256").update(readFileSync(FX + name)).digest("hex") === createHash("sha256").update(readFileSync(out)).digest("hex");
  console.log(name, same ? "identical" : `DIFFERENT (sent ${readFileSync(FX + name).length} bytes, received ${readFileSync(out).length})`);
  if (!same) failures.push(`${name} differs after transfer`);
}
await send.waitForSelector("text=Sent!", { timeout: 20000 });
console.log("sender meter:", await send.textContent("header button[aria-label^='Your files sent to servers']"));
for (const l of logs) console.log("  ", l.slice(0, 200));
await browser.close();
console.log(failures.length ? `FAIL: ${failures.join("; ")}` : "P2P share passed");
process.exit(failures.length ? 1 : 0);
