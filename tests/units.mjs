// Small checks of library functions that have no tool of their own, run in Chromium against the
// dev server (they import source modules). Usage: node units.mjs [baseUrl]
import { launch } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:8080";
const browser = await launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base + "/", { waitUntil: "networkidle", timeout: 120000 });

const results = await page.evaluate(async () => {
  const out = [];
  const check = (name, ok, note = "") => out.push({ name, ok: !!ok, note });

  // A signature photographed on paper lit from one side: the shadowed paper must not turn into
  // ink, the strokes must, and dust far from the signature must go (sigclean.ts).
  {
    const { cleanSignature } = await import("/src/lib/sigclean.ts");
    const W = 1200;
    const H = 700;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "rgb(236,236,240)");
    g.addColorStop(1, "rgb(110,110,118)");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.strokeStyle = "rgb(30,40,90)";
    x.lineWidth = 6;
    x.beginPath();
    for (let i = 0; i <= 120; i++) x.lineTo(250 + i * 5, 350 + 80 * Math.sin(i / 8));
    x.stroke();
    x.fillStyle = "rgb(80,80,85)";
    for (const [sx, sy] of [[60, 60], [1100, 80], [90, 640]]) x.fillRect(sx, sy, 4, 4);
    const d = x.getImageData(0, 0, W, H);
    cleanSignature(d, 0.85, "#1e3a8a");
    const a = (px, py) => d.data[(py * W + px) * 4 + 3];
    let shadowInk = 0;
    for (let py = H - 120; py < H; py += 3) for (let px = W - 200; px < W; px += 3) if (a(px, py) > 8) shadowInk++;
    let strokeInk = 0;
    for (let i = 10; i <= 110; i += 10) if (a(Math.round(250 + i * 5), Math.round(350 + 80 * Math.sin(i / 8))) > 128) strokeInk++;
    const specks = [[62, 62], [1102, 82], [92, 642]].filter(([px, py]) => a(px, py) > 8).length;
    check("signature photo: shadowed paper stays paper", shadowInk === 0, `${shadowInk} ink samples in the shadow`);
    check("signature photo: strokes kept", strokeInk === 11, `${strokeInk}/11 stroke samples`);
    check("signature photo: dust dropped", specks === 0, `${specks} specks left`);
  }

  // Faces with the widths of a document's font, by the font's name in the PDF (fonts.ts).
  {
    const { matchFace } = await import("/src/lib/pdf/fonts.ts");
    const want = { "ABCDEF+ArialMT": "msans", "Helvetica-Bold": "msans", LiberationSans: "msans", TimesNewRomanPSMT: "mserif", "Calibri-Bold": "carlito", Cambria: "caladea", Georgia: "gelasio", CourierNewPSMT: "mmono", DYPMetricSans: "msans", ArialNarrow: undefined, Inter: undefined };
    const wrong = Object.entries(want).filter(([n, f]) => matchFace(n) !== f);
    check("font faces matched by name", !wrong.length, wrong.map(([n]) => `${n}: ${matchFace(n)}`).join(", "));
  }
  return out;
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
}
if (errors.length) console.log("page errors:\n" + errors.join("\n"));
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
