import { BRAND } from "@/lib/brand";
import { hexToRgb, newDoc, saveDoc } from "./core";
import { FontSet } from "./fonts";
import { setOutline } from "./outline";

/** A three-page demo document for “Try a sample”, with text, a table, PII and bookmarks. */
export async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await newDoc();
  const fonts = new FontSet(doc);
  const W = 595.28;
  const H = 841.89;
  const ink = hexToRgb("#1a1a1a");
  const accent = hexToRgb("#b42318");
  const muted = hexToRgb("#5a5a5a");
  const page1 = doc.addPage([W, H]);
  page1.drawRectangle({ x: 0, y: H - 90, width: W, height: 90, color: accent });
  await fonts.draw(page1, `${BRAND.name} sample document`, { x: 48, y: H - 52, size: 22, style: { bold: true }, color: hexToRgb("#ffffff") });
  await fonts.draw(page1, "Private by design · processed on your device", { x: 48, y: H - 74, size: 10, color: hexToRgb("#ffe9e6") });
  let y = H - 130;
  const para = async (text: string, size = 11, style = {}, color = ink) => {
    for (const line of await fonts.wrap(text, size, W - 96, style)) {
      await fonts.draw(page1, line, { x: 48, y, size, style, color });
      y -= size * 1.45;
    }
    y -= 8;
  };
  await para("Try any tool on this file: compress it, sign it, split it, redact it, chat with it, and more.");
  await para("Overview", 15, { bold: true });
  await para("This quarter the team shipped three releases, signed two enterprise customers and cut average response time from nine hours to four. Revenue grew 18% to ₹2,45,00,000 while costs stayed flat.");
  await para("Contact details (fake, for the privacy scanner)", 15, { bold: true });
  await para("Email: ada.lovelace@example.com · Phone: +91 81234 50987");
  await para("PAN: ABCPE1234F · GSTIN: 27ABCPE1234F1Z5 · IFSC: HDFC0001234");
  await para("Card on file: 4111 1111 1111 1111 · UPI: ada@okhdfcbank");
  await para("हिंदी में भी: यह दस्तावेज़ आपके डिवाइस पर ही रहता है।", 12);
  const page2 = doc.addPage([W, H]);
  await fonts.draw(page2, "Invoice summary", { x: 48, y: H - 80, size: 18, style: { bold: true }, color: accent });
  const cols = [48, 260, 340, 440];
  const rows = [
    ["Item", "Qty", "Rate", "Amount"],
    ["Consulting hours", "12", "1,500.00", "18,000.00"],
    ["Cloud hosting", "1", "4,200.50", "4,200.50"],
    ["Support plan", "3", "999.00", "2,997.00"],
    ["Total", "", "", "25,197.50"],
  ];
  for (let r = 0; r < rows.length; r++) {
    const ry = H - 120 - r * 22;
    if (r === 0) page2.drawRectangle({ x: 44, y: ry - 6, width: W - 88, height: 20, color: hexToRgb("#f1f1f1") });
    for (let c = 0; c < cols.length; c++) {
      await fonts.draw(page2, rows[r][c], { x: cols[c], y: ry, size: 11, style: { bold: r === 0 || r === rows.length - 1 }, color: ink });
    }
  }
  await fonts.draw(page2, "Amounts in Indian rupees (₹).", { x: 48, y: H - 250, size: 10, color: muted });
  const page3 = doc.addPage([W, H]);
  await fonts.draw(page3, "Appendix", { x: 48, y: H - 80, size: 18, style: { bold: true }, color: accent });
  await fonts.draw(page3, "Rotate me, drop me, watermark me. I exist only inside this browser tab.", { x: 48, y: H - 110, size: 11, color: ink });
  for (const [i, p] of [page1, page2, page3].entries()) {
    const label = `Page ${i + 1} of 3`;
    const w = await fonts.width(label, 9);
    await fonts.draw(p, label, { x: (W - w) / 2, y: 30, size: 9, color: muted });
  }
  setOutline(doc, [
    { title: "Overview", pageIndex: 0 },
    { title: "Invoice summary", pageIndex: 1 },
    { title: "Appendix", pageIndex: 2 },
  ]);
  doc.setTitle(`${BRAND.name} sample`);
  doc.setAuthor(BRAND.name);
  return saveDoc(doc);
}
