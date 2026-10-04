/** Business documents generated from forms: GST invoice, POS bill, GST working paper, resume. */
import { BRAND } from "@/lib/brand";
import { embedImage, hexToRgb, newDoc, pdfOut, saveDoc, safeFileName, type OutFile, type PDFPage, type RGB } from "./core";
import { FontSet, type TextStyle } from "./fonts";

export const STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
  "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

export function stateFromGstin(gstin: string): string | null {
  const code = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(code) && STATES[code] ? code : null;
}

export function validGstin(g: string): boolean {
  const s = g.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(s[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === s[14];
}

/* ------------------------------------------------------------ numbers */

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function two(n: number) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}
function three(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? two(r) : ""].filter(Boolean).join(" ");
}
/** 123456.5 → "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only" */
export function rupeesInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount) + 1e-9);
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  const words = (n: number): string => {
    if (n === 0) return "Zero";
    const crore = Math.floor(n / 1e7);
    const lakh = Math.floor((n % 1e7) / 1e5);
    const thousand = Math.floor((n % 1e5) / 1e3);
    const rest = n % 1000;
    return [crore ? `${crore >= 100 ? words(crore) : two(crore)} Crore` : "", lakh ? `${two(lakh)} Lakh` : "", thousand ? `${two(thousand)} Thousand` : "", rest ? three(rest) : ""].filter(Boolean).join(" ");
  };
  return `${amount < 0 ? "Minus " : ""}${words(rupees)} Rupee${rupees === 1 ? "" : "s"}${paise ? ` and ${two(paise)} Paise` : ""} Only`;
}

/** Indian digit grouping: 1234567.8 → "12,34,567.80" */
export function inr(n: number, symbol = false): string {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${symbol ? "₹" : ""}${rest ? rest + "," : ""}${last3}.${dec}`;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ------------------------------------------------------------- drawing */

type Pen = { fonts: FontSet; page: PDFPage; H: number };

async function txt(p: Pen, s: string, x: number, top: number, size: number, style: TextStyle = {}, color: RGB = hexToRgb("#111111"), align: "left" | "right" | "center" = "left", width = 0) {
  if (!s) return;
  let dx = x;
  if (align !== "left") {
    const w = await p.fonts.width(s, size, style);
    dx = align === "right" ? x + width - w : x + (width - w) / 2;
  }
  await p.fonts.draw(p.page, s, { x: dx, y: p.H - top - size * 0.82, size, style, color });
}

async function wrapped(p: Pen, s: string, x: number, top: number, width: number, size: number, style: TextStyle = {}, color?: RGB, lh = 1.3): Promise<number> {
  const lines = await p.fonts.wrap(s, size, width, style);
  for (let i = 0; i < lines.length; i++) await txt(p, lines[i], x, top + i * size * lh, size, style, color);
  return lines.length * size * lh;
}

function rect(p: Pen, x: number, top: number, w: number, h: number, o: { fill?: RGB; border?: RGB; bw?: number } = {}) {
  p.page.drawRectangle({ x, y: p.H - top - h, width: w, height: h, color: o.fill, borderColor: o.border, borderWidth: o.border ? (o.bw ?? 0.6) : 0 });
}

function hline(p: Pen, x1: number, x2: number, top: number, color = hexToRgb("#cfcfcf"), t = 0.6) {
  p.page.drawLine({ start: { x: x1, y: p.H - top }, end: { x: x2, y: p.H - top }, thickness: t, color });
}

async function qrPng(text: string): Promise<Uint8Array> {
  const QR = await import("qrcode");
  const url = await QR.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: "M" });
  const bin = atob(url.split(",")[1]);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* --------------------------------------------------------- GST invoice */

export type InvoiceItem = { desc: string; hsn: string; qty: number; unit: string; rate: number; discount: number; gst: number };
export type Invoice = {
  title?: string;
  copy?: string;
  number: string;
  date: string;
  dueDate?: string;
  seller: { name: string; address: string; gstin: string; state: string; phone?: string; email?: string; pan?: string };
  buyer: { name: string; address: string; gstin: string; state: string; phone?: string };
  shipTo?: string;
  placeOfSupply: string; // state code
  reverseCharge?: boolean;
  items: InvoiceItem[];
  notes?: string;
  terms?: string;
  bank?: { name?: string; account?: string; ifsc?: string; branch?: string; holder?: string };
  upi?: string;
  logo?: { bytes: Uint8Array; mime: string };
  signature?: { bytes: Uint8Array; mime: string };
  accent?: string;
};

export type InvoiceTotals = {
  rows: (InvoiceItem & { taxable: number; cgst: number; sgst: number; igst: number; total: number })[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  roundOff: number;
  total: number;
  interstate: boolean;
  hsn: { hsn: string; gst: number; taxable: number; cgst: number; sgst: number; igst: number }[];
};

export function computeInvoice(inv: Invoice): InvoiceTotals {
  const sellerState = inv.seller.state || stateFromGstin(inv.seller.gstin) || "";
  const pos = inv.placeOfSupply || inv.buyer.state || stateFromGstin(inv.buyer.gstin) || sellerState;
  const interstate = !!sellerState && !!pos && sellerState !== pos;
  const rows = inv.items
    .filter((i) => i.desc.trim() || i.rate)
    .map((i) => {
      const gross = (Number(i.qty) || 0) * (Number(i.rate) || 0);
      const taxable = r2(gross * (1 - (Number(i.discount) || 0) / 100));
      const tax = r2((taxable * (Number(i.gst) || 0)) / 100);
      const cgst = interstate ? 0 : r2(tax / 2);
      const sgst = interstate ? 0 : r2(tax - cgst);
      const igst = interstate ? tax : 0;
      return { ...i, taxable, cgst, sgst, igst, total: r2(taxable + tax) };
    });
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst") => r2(rows.reduce((s, r) => s + r[k], 0));
  const exact = sum("taxable") + sum("cgst") + sum("sgst") + sum("igst");
  const total = Math.round(exact);
  const hsnMap = new Map<string, InvoiceTotals["hsn"][number]>();
  for (const r of rows) {
    const key = `${r.hsn || "-"}|${r.gst}`;
    const h = hsnMap.get(key) ?? { hsn: r.hsn || "-", gst: r.gst, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    h.taxable = r2(h.taxable + r.taxable);
    h.cgst = r2(h.cgst + r.cgst);
    h.sgst = r2(h.sgst + r.sgst);
    h.igst = r2(h.igst + r.igst);
    hsnMap.set(key, h);
  }
  return { rows, taxable: sum("taxable"), cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), roundOff: r2(total - exact), total, interstate, hsn: [...hsnMap.values()] };
}

export async function gstInvoicePdf(inv: Invoice): Promise<OutFile> {
  if (!inv.seller.name.trim()) throw new Error("Enter the seller (your business) name.");
  if (!inv.buyer.name.trim()) throw new Error("Enter the buyer name.");
  const t = computeInvoice(inv);
  if (!t.rows.length) throw new Error("Add at least one line item.");
  const doc = await newDoc();
  const fonts = new FontSet(doc);
  await fonts.prepare({}, { bold: true });
  const W = 595.28;
  const H = 841.89;
  const M = 36;
  const accent = hexToRgb(inv.accent || "#1f3a5f");
  const muted = hexToRgb("#555555");
  const line = hexToRgb("#d6d6d6");
  let page = doc.addPage([W, H]);
  let p: Pen = { fonts, page, H };
  let y = M;

  // Header
  let textLeft = M;
  if (inv.logo) {
    try {
      const img = await embedImage(doc, inv.logo.bytes, inv.logo.mime);
      const h = 46;
      const w = Math.min(120, (img.width / img.height) * h);
      page.drawImage(img, { x: M, y: H - y - h, width: w, height: h });
      textLeft = M + w + 12;
    } catch {
      /* ignore bad logo */
    }
  }
  await txt(p, inv.seller.name, textLeft, y, 15, { bold: true }, accent);
  let sy = y + 19;
  sy += await wrapped(p, inv.seller.address, textLeft, sy, 250, 8.5, {}, muted, 1.25);
  const sellerMeta = [inv.seller.gstin && `GSTIN: ${inv.seller.gstin.toUpperCase()}`, inv.seller.pan && `PAN: ${inv.seller.pan.toUpperCase()}`, inv.seller.state && `State: ${STATES[inv.seller.state] ?? inv.seller.state} (${inv.seller.state})`, [inv.seller.phone, inv.seller.email].filter(Boolean).join(" · ")].filter(Boolean) as string[];
  for (const m of sellerMeta) {
    await txt(p, m, textLeft, sy, 8.5, {}, muted);
    sy += 11;
  }
  await txt(p, inv.title || "TAX INVOICE", W - M - 220, y, 16, { bold: true }, accent, "right", 220);
  if (inv.copy) await txt(p, inv.copy, W - M - 220, y + 20, 7.5, { italic: true }, muted, "right", 220);
  const meta: [string, string][] = [["Invoice No.", inv.number || "—"], ["Invoice Date", fmtDate(inv.date)], ...(inv.dueDate ? ([["Due Date", fmtDate(inv.dueDate)]] as [string, string][]) : []), ["Place of Supply", `${STATES[inv.placeOfSupply] ?? (inv.placeOfSupply || "—")}${inv.placeOfSupply ? ` (${inv.placeOfSupply})` : ""}`], ["Reverse Charge", inv.reverseCharge ? "Yes" : "No"]];
  let my = y + 34;
  for (const [k, v] of meta) {
    await txt(p, k, W - M - 220, my, 8.5, {}, muted);
    await txt(p, v, W - M - 130, my, 8.5, { bold: true }, undefined, "right", 130);
    my += 12;
  }
  y = Math.max(sy, my) + 10;
  hline(p, M, W - M, y, accent, 1.2);
  y += 10;

  // Parties
  const colW = (W - M * 2 - 16) / 2;
  const party = async (x: number, label: string, b: { name: string; address: string; gstin: string; state: string; phone?: string }) => {
    await txt(p, label, x, y, 7.5, { bold: true }, accent);
    let yy = y + 12;
    await txt(p, b.name, x, yy, 10, { bold: true });
    yy += 14;
    yy += await wrapped(p, b.address, x, yy, colW, 8.5, {}, muted, 1.25);
    if (b.gstin) {
      await txt(p, `GSTIN: ${b.gstin.toUpperCase()}`, x, yy, 8.5);
      yy += 11;
    }
    if (b.state) {
      await txt(p, `State: ${STATES[b.state] ?? b.state} (${b.state})`, x, yy, 8.5, {}, muted);
      yy += 11;
    }
    if (b.phone) {
      await txt(p, b.phone, x, yy, 8.5, {}, muted);
      yy += 11;
    }
    return yy;
  };
  const yA = await party(M, "BILL TO", inv.buyer);
  const yB = inv.shipTo ? await party(M + colW + 16, "SHIP TO", { name: inv.buyer.name, address: inv.shipTo, gstin: "", state: inv.placeOfSupply }) : yA;
  y = Math.max(yA, yB) + 10;

  // Items table
  const cols = t.interstate
    ? [{ k: "#", w: 18 }, { k: "Item / Service", w: 0 }, { k: "HSN/SAC", w: 50 }, { k: "Qty", w: 44 }, { k: "Rate", w: 58 }, { k: "Disc %", w: 34 }, { k: "Taxable", w: 64 }, { k: "IGST", w: 58 }, { k: "Amount", w: 66 }]
    : [{ k: "#", w: 18 }, { k: "Item / Service", w: 0 }, { k: "HSN/SAC", w: 46 }, { k: "Qty", w: 40 }, { k: "Rate", w: 54 }, { k: "Disc %", w: 30 }, { k: "Taxable", w: 60 }, { k: "CGST", w: 48 }, { k: "SGST", w: 48 }, { k: "Amount", w: 62 }];
  const fixed = cols.reduce((s, c) => s + c.w, 0);
  cols[1].w = W - M * 2 - fixed;
  const xs = cols.reduce<number[]>((a, c, i) => (a.push(i ? a[i - 1] + cols[i - 1].w : M), a), []);
  const header = async () => {
    rect(p, M, y, W - M * 2, 18, { fill: accent });
    for (let i = 0; i < cols.length; i++) await txt(p, cols[i].k, xs[i] + 3, y + 5, 7.5, { bold: true }, hexToRgb("#ffffff"), i >= 3 ? "right" : "left", cols[i].w - 6);
    y += 18;
  };
  await header();
  for (let r = 0; r < t.rows.length; r++) {
    const it = t.rows[r];
    const descLines = await fonts.wrap(it.desc || "—", 8.5, cols[1].w - 6, {});
    const rowH = Math.max(24, descLines.length * 11 + 8 + 10);
    if (y + rowH > H - 230) {
      await txt(p, "Continued on next page…", M, H - M - 10, 8, { italic: true }, muted);
      page = doc.addPage([W, H]);
      p = { fonts, page, H };
      y = M;
      await header();
    }
    if (r % 2 === 1) rect(p, M, y, W - M * 2, rowH, { fill: hexToRgb("#f6f7f9") });
    const cells = t.interstate
      ? [String(r + 1), "", it.hsn, `${fmtQty(it.qty)} ${it.unit || ""}`.trim(), inr(it.rate), it.discount ? String(it.discount) : "", inr(it.taxable), inr(it.igst), inr(it.total)]
      : [String(r + 1), "", it.hsn, `${fmtQty(it.qty)} ${it.unit || ""}`.trim(), inr(it.rate), it.discount ? String(it.discount) : "", inr(it.taxable), inr(it.cgst), inr(it.sgst), inr(it.total)];
    for (let i = 0; i < cols.length; i++) {
      if (i === 1) {
        for (let k = 0; k < descLines.length; k++) await txt(p, descLines[k], xs[1] + 3, y + 5 + k * 11, 8.5);
        await txt(p, `GST ${it.gst}%`, xs[1] + 3, y + 5 + descLines.length * 11, 7, {}, muted);
      } else await txt(p, cells[i], xs[i] + 3, y + 5, 8.5, i === cols.length - 1 ? { bold: true } : {}, undefined, i >= 3 ? "right" : "left", cols[i].w - 6);
    }
    if (!t.interstate) {
      await txt(p, `${it.gst / 2}%`, xs[7] + 3, y + 15, 6.5, {}, muted, "right", cols[7].w - 6);
      await txt(p, `${it.gst / 2}%`, xs[8] + 3, y + 15, 6.5, {}, muted, "right", cols[8].w - 6);
    } else await txt(p, `${it.gst}%`, xs[7] + 3, y + 15, 6.5, {}, muted, "right", cols[7].w - 6);
    y += rowH;
    hline(p, M, W - M, y, line);
  }
  y += 10;

  // Totals block (right) and amount in words / HSN summary (left)
  const totals: [string, string, boolean?][] = [["Taxable value", inr(t.taxable)], ...(t.interstate ? ([["IGST", inr(t.igst)]] as [string, string][]) : ([["CGST", inr(t.cgst)], ["SGST / UTGST", inr(t.sgst)]] as [string, string][])), ...(t.roundOff ? ([["Round off", inr(t.roundOff)]] as [string, string][]) : []), ["Total", inr(t.total, true), true]];
  const tw = 200;
  let ty = y;
  for (const [k, v, strong] of totals) {
    if (strong) {
      rect(p, W - M - tw, ty - 3, tw, 20, { fill: accent });
      await txt(p, k, W - M - tw + 6, ty + 2, 10, { bold: true }, hexToRgb("#ffffff"));
      await txt(p, v, W - M - tw, ty + 2, 11, { bold: true }, hexToRgb("#ffffff"), "right", tw - 6);
      ty += 22;
    } else {
      await txt(p, k, W - M - tw + 6, ty, 8.5, {}, muted);
      await txt(p, v, W - M - tw, ty, 8.5, {}, undefined, "right", tw - 6);
      ty += 13;
    }
  }
  let ly = y;
  await txt(p, "Amount in words", M, ly, 7.5, { bold: true }, accent);
  ly += 11;
  ly += await wrapped(p, rupeesInWords(t.total), M, ly, W - M * 2 - tw - 20, 8.5, { italic: true }, undefined, 1.3);
  ly += 6;
  // HSN summary
  await txt(p, "HSN / SAC summary", M, ly, 7.5, { bold: true }, accent);
  ly += 11;
  const hcols = t.interstate ? ["HSN/SAC", "GST %", "Taxable", "IGST"] : ["HSN/SAC", "GST %", "Taxable", "CGST", "SGST"];
  const hw = (W - M * 2 - tw - 20) / hcols.length;
  for (let i = 0; i < hcols.length; i++) await txt(p, hcols[i], M + i * hw, ly, 7, { bold: true }, muted, i >= 2 ? "right" : "left", hw - 4);
  ly += 10;
  for (const h of t.hsn) {
    const vals = t.interstate ? [h.hsn, `${h.gst}%`, inr(h.taxable), inr(h.igst)] : [h.hsn, `${h.gst}%`, inr(h.taxable), inr(h.cgst), inr(h.sgst)];
    for (let i = 0; i < vals.length; i++) await txt(p, vals[i], M + i * hw, ly, 7.5, {}, undefined, i >= 2 ? "right" : "left", hw - 4);
    ly += 10;
  }
  y = Math.max(ty, ly) + 14;

  // Bank, UPI QR, notes, signature
  if (y > H - 170) {
    page = doc.addPage([W, H]);
    p = { fonts, page, H };
    y = M;
  }
  hline(p, M, W - M, y, line);
  y += 10;
  const bottomTop = y;
  let bx = M;
  if (inv.upi?.trim()) {
    try {
      const upiUrl = `upi://pay?pa=${encodeURIComponent(inv.upi.trim())}&pn=${encodeURIComponent(inv.seller.name)}&am=${t.total.toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Invoice ${inv.number}`)}`;
      const qr = await doc.embedPng(await qrPng(upiUrl));
      page.drawImage(qr, { x: M, y: H - y - 74, width: 74, height: 74 });
      await txt(p, "Scan to pay (UPI)", M, y + 76, 7, {}, muted);
      await txt(p, inv.upi.trim(), M, y + 85, 7, { bold: true });
      bx = M + 88;
    } catch {
      /* QR failed: skip */
    }
  }
  let by = bottomTop;
  if (inv.bank && Object.values(inv.bank).some((v) => v?.trim())) {
    await txt(p, "Bank details", bx, by, 7.5, { bold: true }, accent);
    by += 11;
    for (const [k, v] of [["Account name", inv.bank.holder], ["Bank", inv.bank.name], ["A/c no.", inv.bank.account], ["IFSC", inv.bank.ifsc], ["Branch", inv.bank.branch]] as [string, string | undefined][]) {
      if (!v?.trim()) continue;
      await txt(p, `${k}: ${v}`, bx, by, 8);
      by += 10.5;
    }
  }
  const notesX = Math.max(bx + 170, W / 2 - 20);
  let ny = bottomTop;
  if (inv.notes?.trim()) {
    await txt(p, "Notes", notesX, ny, 7.5, { bold: true }, accent);
    ny += 11;
    ny += await wrapped(p, inv.notes, notesX, ny, W - M - notesX - 130, 8, {}, muted);
  }
  if (inv.terms?.trim()) {
    ny += 4;
    await txt(p, "Terms", notesX, ny, 7.5, { bold: true }, accent);
    ny += 11;
    ny += await wrapped(p, inv.terms, notesX, ny, W - M - notesX - 130, 8, {}, muted);
  }
  const sigX = W - M - 120;
  await txt(p, `For ${inv.seller.name}`, sigX, bottomTop, 8, { bold: true }, undefined, "right", 120);
  if (inv.signature) {
    try {
      const s = await embedImage(doc, inv.signature.bytes, inv.signature.mime);
      const h = 36;
      const w = Math.min(110, (s.width / s.height) * h);
      page.drawImage(s, { x: W - M - w, y: H - bottomTop - 14 - h, width: w, height: h });
    } catch {
      /* ignore */
    }
  }
  await txt(p, "Authorised Signatory", sigX, bottomTop + 58, 8, {}, muted, "right", 120);
  await txt(p, "This is a computer-generated invoice.", M, H - M + 6, 7, { italic: true }, muted);
  doc.setTitle(`Invoice ${inv.number}`);
  doc.setAuthor(inv.seller.name);
  return pdfOut(`invoice-${safeFileName(inv.number || "draft")}.pdf`, await saveDoc(doc), `Total ${inr(t.total, true)}`);
}

function fmtDate(d: string) {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2));

/* ----------------------------------------------------------- POS bill */

export type PosBill = {
  shop: string;
  address: string;
  gstin?: string;
  phone?: string;
  billNo: string;
  cashier?: string;
  customer?: string;
  items: { name: string; qty: number; rate: number }[];
  discount?: number; // flat amount
  gstRate?: number; // %
  gstInclusive?: boolean;
  payment: string;
  upi?: string;
  footer?: string;
  width?: 58 | 80;
};

export async function posBillPdf(b: PosBill): Promise<OutFile> {
  const items = b.items.filter((i) => i.name.trim() && i.qty);
  if (!items.length) throw new Error("Add at least one item.");
  const doc = await newDoc();
  const fonts = new FontSet(doc);
  const W = (b.width === 58 ? 58 : 80) * (72 / 25.4);
  const M = 8;
  const inner = W - M * 2;
  const mono: TextStyle = { family: "mono" };
  const size = b.width === 58 ? 7 : 8;
  const charW = await fonts.width("0", size, mono);
  const cols = Math.floor(inner / charW);
  const subtotal = r2(items.reduce((s, i) => s + i.qty * i.rate, 0));
  const discount = r2(Math.min(subtotal, b.discount ?? 0));
  const rate = b.gstRate ?? 0;
  const base = subtotal - discount;
  const tax = b.gstInclusive ? r2(base - base / (1 + rate / 100)) : r2((base * rate) / 100);
  const total = Math.round(b.gstInclusive ? base : base + tax);
  const lines: { text: string; style?: TextStyle; size?: number; align?: "center" | "left" }[] = [];
  const center = (s: string, st: TextStyle = {}, sz = size) => lines.push({ text: s, style: st, size: sz, align: "center" });
  const lr = (l: string, r: string, st: TextStyle = mono) => {
    const room = cols - r.length - 1;
    lines.push({ text: l.slice(0, Math.max(1, room)).padEnd(room) + " " + r, style: st });
  };
  const rule = () => lines.push({ text: "-".repeat(cols), style: mono });
  center(b.shop || "Shop", { bold: true }, size + 4);
  for (const l of (b.address || "").split("\n").filter(Boolean)) center(l, {}, size);
  if (b.phone) center(`Ph: ${b.phone}`);
  if (b.gstin) center(`GSTIN: ${b.gstin.toUpperCase()}`);
  center(rate ? "TAX INVOICE" : "BILL OF SUPPLY", { bold: true });
  rule();
  const now = new Date();
  lr(`Bill: ${b.billNo || "-"}`, now.toLocaleDateString("en-IN"));
  lr(b.cashier ? `Cashier: ${b.cashier}` : "", now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
  if (b.customer) lr(`Customer: ${b.customer}`, "");
  rule();
  lr("Item", "Amount");
  rule();
  for (const it of items) {
    const amt = inr(it.qty * it.rate);
    lines.push({ text: it.name.slice(0, cols), style: mono });
    lr(`  ${fmtQty(it.qty)} x ${inr(it.rate)}`, amt);
  }
  rule();
  lr("Subtotal", inr(subtotal));
  if (discount) lr("Discount", `-${inr(discount)}`);
  if (rate) {
    lr(`CGST @${rate / 2}%${b.gstInclusive ? " (incl.)" : ""}`, inr(r2(tax / 2)));
    lr(`SGST @${rate / 2}%${b.gstInclusive ? " (incl.)" : ""}`, inr(r2(tax - r2(tax / 2))));
  }
  rule();
  lines.push({ text: `TOTAL ${inr(total, true)}`, style: { bold: true }, size: size + 5, align: "center" });
  rule();
  lr(`Paid by: ${b.payment || "Cash"}`, `${items.reduce((s, i) => s + i.qty, 0)} items`);
  const qr = b.upi?.trim() ? await doc.embedPng(await qrPng(`upi://pay?pa=${encodeURIComponent(b.upi.trim())}&pn=${encodeURIComponent(b.shop)}&am=${total.toFixed(2)}&cu=INR`)) : null;
  const footer = (b.footer || "Thank you! Visit again.").split("\n");
  const lh = (l: (typeof lines)[number]) => (l.size ?? size) * 1.35;
  const H = M * 2 + lines.reduce((s, l) => s + lh(l), 0) + (qr ? inner * 0.55 + 20 : 0) + footer.length * size * 1.4 + 10;
  const page = doc.addPage([W, H]);
  let y = M;
  for (const l of lines) {
    const s = l.size ?? size;
    const w = await fonts.width(l.text, s, l.style ?? {});
    const x = l.align === "center" ? (W - w) / 2 : M;
    await fonts.draw(page, l.text, { x, y: H - y - s, size: s, style: l.style, color: hexToRgb("#000000") });
    y += lh(l);
  }
  if (qr) {
    const q = inner * 0.55;
    page.drawImage(qr, { x: (W - q) / 2, y: H - y - q - 4, width: q, height: q });
    y += q + 8;
    const cap = "Scan & pay via UPI";
    const w = await fonts.width(cap, size);
    await fonts.draw(page, cap, { x: (W - w) / 2, y: H - y - size, size, color: hexToRgb("#000000") });
    y += size * 1.6;
  }
  for (const f of footer) {
    const w = await fonts.width(f, size, { italic: true });
    await fonts.draw(page, f, { x: (W - w) / 2, y: H - y - size, size, style: { italic: true }, color: hexToRgb("#000000") });
    y += size * 1.4;
  }
  return pdfOut(`bill-${safeFileName(b.billNo || "receipt")}.pdf`, await saveDoc(doc), `Total ${inr(total, true)}`);
}

/* -------------------------------------------------- GST working paper */

export type GstRow = { type: "B2B" | "B2C"; inv: string; date: string; party: string; gstin: string; pos: string; taxable: number; rate: number; interstate: boolean };

export function gstSummary(rows: GstRow[]) {
  const calc = rows.map((r) => {
    const tax = r2((r.taxable * r.rate) / 100);
    return { ...r, igst: r.interstate ? tax : 0, cgst: r.interstate ? 0 : r2(tax / 2), sgst: r.interstate ? 0 : r2(tax - r2(tax / 2)) };
  });
  const byRate = new Map<number, { taxable: number; igst: number; cgst: number; sgst: number; count: number }>();
  for (const r of calc) {
    const k = byRate.get(r.rate) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, count: 0 };
    k.taxable = r2(k.taxable + r.taxable);
    k.igst = r2(k.igst + r.igst);
    k.cgst = r2(k.cgst + r.cgst);
    k.sgst = r2(k.sgst + r.sgst);
    k.count++;
    byRate.set(r.rate, k);
  }
  const tot = calc.reduce((a, r) => ({ taxable: a.taxable + r.taxable, igst: a.igst + r.igst, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
  return { calc, byRate: [...byRate.entries()].sort((a, b) => a[0] - b[0]), totals: { taxable: r2(tot.taxable), igst: r2(tot.igst), cgst: r2(tot.cgst), sgst: r2(tot.sgst) } };
}

export async function gstWorkingPaperPdf(rows: GstRow[], o: { business?: string; gstin?: string; period?: string } = {}): Promise<OutFile> {
  const valid = rows.filter((r) => r.inv.trim() || r.taxable);
  if (!valid.length) throw new Error("Add at least one invoice row.");
  const s = gstSummary(valid);
  const { renderHtml } = await import("./layout");
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const head = `<h1>GST working paper${o.period ? ` · ${esc(o.period)}` : ""}</h1><p>${esc(o.business ?? "")}${o.gstin ? ` · GSTIN ${esc(o.gstin)}` : ""}</p><p style="color:#666">Prepared with ${BRAND.name}. A working paper to help you prepare GSTR-1/3B, not a filed return. Check against the GST portal before filing.</p>`;
  const summary = `<h2>Summary by tax rate</h2><table><thead><tr><th>Rate</th><th>Invoices</th><th>Taxable</th><th>IGST</th><th>CGST</th><th>SGST</th><th>Total tax</th></tr></thead><tbody>${s.byRate.map(([rate, v]) => `<tr><td>${rate}%</td><td style="text-align:right">${v.count}</td><td style="text-align:right">${inr(v.taxable)}</td><td style="text-align:right">${inr(v.igst)}</td><td style="text-align:right">${inr(v.cgst)}</td><td style="text-align:right">${inr(v.sgst)}</td><td style="text-align:right">${inr(v.igst + v.cgst + v.sgst)}</td></tr>`).join("")}<tr><td><b>Total</b></td><td style="text-align:right"><b>${valid.length}</b></td><td style="text-align:right"><b>${inr(s.totals.taxable)}</b></td><td style="text-align:right"><b>${inr(s.totals.igst)}</b></td><td style="text-align:right"><b>${inr(s.totals.cgst)}</b></td><td style="text-align:right"><b>${inr(s.totals.sgst)}</b></td><td style="text-align:right"><b>${inr(s.totals.igst + s.totals.cgst + s.totals.sgst)}</b></td></tr></tbody></table>`;
  const section = (type: "B2B" | "B2C") => {
    const list = s.calc.filter((r) => r.type === type);
    if (!list.length) return "";
    return `<h2>${type === "B2B" ? "B2B invoices (GSTR-1 Table 4)" : "B2C supplies (GSTR-1 Tables 5 & 7)"}</h2><table><thead><tr><th>Invoice</th><th>Date</th><th>Party</th>${type === "B2B" ? "<th>GSTIN</th>" : ""}<th>POS</th><th>Rate</th><th>Taxable</th><th>IGST</th><th>CGST</th><th>SGST</th></tr></thead><tbody>${list.map((r) => `<tr><td>${esc(r.inv)}</td><td>${esc(r.date)}</td><td>${esc(r.party)}</td>${type === "B2B" ? `<td>${esc(r.gstin.toUpperCase())}</td>` : ""}<td>${esc(r.pos)}</td><td>${r.rate}%</td><td style="text-align:right">${inr(r.taxable)}</td><td style="text-align:right">${inr(r.igst)}</td><td style="text-align:right">${inr(r.cgst)}</td><td style="text-align:right">${inr(r.sgst)}</td></tr>`).join("")}</tbody></table>`;
  };
  const pdf = await renderHtml(head + summary + section("B2B") + section("B2C"), { pageSize: [841.89, 595.28], margin: 36, baseSize: 8.5, pageNumbers: true, title: "GST working paper" });
  return pdfOut(`gst-working-paper${o.period ? "-" + safeFileName(o.period) : ""}.pdf`, pdf, `Tax ${inr(s.totals.igst + s.totals.cgst + s.totals.sgst, true)} on ${inr(s.totals.taxable, true)}`);
}

export function gstCsv(rows: GstRow[]): OutFile {
  const s = gstSummary(rows.filter((r) => r.inv.trim() || r.taxable));
  const head = ["Type", "Invoice", "Date", "Party", "GSTIN", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST"];
  const q = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = s.calc.map((r) => [r.type, r.inv, r.date, r.party, r.gstin.toUpperCase(), r.pos, r.rate, r.taxable.toFixed(2), r.igst.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2)].map(q).join(","));
  return { filename: "gst-working-paper.csv", bytes: new TextEncoder().encode("﻿" + [head.join(","), ...body].join("\r\n")), mime: "text/csv" };
}

/* ---------------------------------------------------------------- resume */

export type Resume = {
  name: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  links: string;
  summary: string;
  experience: { role: string; org: string; start: string; end: string; points: string }[];
  education: { degree: string; school: string; year: string; detail: string }[];
  skills: string;
  extras: { heading: string; body: string }[];
  template: "classic" | "modern";
  accent?: string;
};

export async function resumePdf(r: Resume): Promise<OutFile> {
  if (!r.name.trim()) throw new Error("Enter your name.");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const accent = r.accent || "#1f3a5f";
  const contact = [r.email, r.phone, r.location, ...r.links.split(/[\n,]+/).map((x) => x.trim())].filter(Boolean);
  const bullets = (s: string) => {
    const items = s.split("\n").map((x) => x.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
    return items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  };
  const exp = r.experience
    .filter((e) => e.role.trim() || e.org.trim())
    .map((e) => `<p style="margin:0"><b>${esc(e.role)}</b>${e.org ? ` · ${esc(e.org)}` : ""}<span style="color:#666">${e.start || e.end ? ` · ${esc(e.start)}${e.end ? ` – ${esc(e.end)}` : ""}` : ""}</span></p>${bullets(e.points)}`)
    .join("");
  const edu = r.education
    .filter((e) => e.degree.trim() || e.school.trim())
    .map((e) => `<p><b>${esc(e.degree)}</b>${e.school ? ` · ${esc(e.school)}` : ""}${e.year ? ` <span style="color:#666">· ${esc(e.year)}</span>` : ""}${e.detail ? `<br><span style="color:#444">${esc(e.detail)}</span>` : ""}</p>`)
    .join("");
  const h = (t: string) => (r.template === "modern" ? `<h3 style="color:${accent}">${esc(t.toUpperCase())}</h3>` : `<h2 style="color:${accent}">${esc(t)}</h2><hr>`);
  const html = [
    r.template === "modern"
      ? `<h1 style="color:${accent}">${esc(r.name)}</h1><p><b>${esc(r.title)}</b></p><p style="color:#555">${contact.map(esc).join("  ·  ")}</p>`
      : `<h1 style="text-align:center">${esc(r.name)}</h1><p style="text-align:center;color:${accent}"><b>${esc(r.title)}</b></p><p style="text-align:center;color:#555">${contact.map(esc).join("  ·  ")}</p>`,
    r.summary.trim() ? `${h("Summary")}<p>${esc(r.summary)}</p>` : "",
    exp ? `${h("Experience")}${exp}` : "",
    edu ? `${h("Education")}${edu}` : "",
    r.skills.trim() ? `${h("Skills")}<p>${r.skills.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map(esc).join("  ·  ")}</p>` : "",
    ...r.extras.filter((x) => x.heading.trim() && x.body.trim()).map((x) => `${h(x.heading)}${bullets(x.body) || `<p>${esc(x.body)}</p>`}`),
  ].join("");
  const { renderHtml } = await import("./layout");
  const pdf = await renderHtml(html, { pageSize: [595.28, 841.89], margin: { top: 46, right: 50, bottom: 46, left: 50 }, baseSize: 9.8, lineHeight: 1.32, family: r.template === "modern" ? "sans" : "serif", title: `${r.name} resume`, author: r.name, bookmarks: false });
  return pdfOut(`${safeFileName(r.name)}-resume.pdf`, pdf);
}
