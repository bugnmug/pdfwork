/**
 * Excel to PDF, printed the way Excel prints: each visible sheet's print area
 * (or used range) on its paper size, orientation, margins and scale, with print
 * titles, page breaks, headers and footers, the cells' own fonts, fills,
 * borders and number formats, Excel tables and conditional formats, pictures,
 * charts and shapes. Runs entirely in the browser.
 */
import { newDoc, saveDoc, tick, type ProgressFn } from "../core";
import { setOutline, type OutlineEntry } from "../outline";
import { drawHF, parseHF } from "./hf";
import { readXlsx } from "./read";
import { SheetPrinter, addLinks } from "./sheet";
import { TextKit } from "../textkit";

export type XlsxResult = { pdf: Uint8Array; pages: number; sheets: number; warnings: string[] };

export async function xlsxToPdfBytes(bytes: Uint8Array, name: string, opts: { sheets?: "all" | "first" } = {}, onProgress?: ProgressFn): Promise<XlsxResult> {
  onProgress?.(0.05, "Reading the workbook");
  const wb = await readXlsx(bytes);
  const visible = wb.sheets.filter((s) => s.state === "visible");
  const chosen = opts.sheets === "first" ? visible.slice(0, 1) : visible;
  const doc = await newDoc();
  doc.setTitle(wb.title || name.replace(/\.[^.]+$/, ""));
  if (wb.author) doc.setAuthor(wb.author);
  const kit = new TextKit(doc);
  onProgress?.(0.15, "Laying out the sheets");
  const printers: SheetPrinter[] = [];
  for (const sheet of chosen) {
    const p = new SheetPrinter(wb, sheet, kit, doc);
    if (await p.prepare()) printers.push(p);
    await tick();
  }
  if (!printers.length) throw new Error("The workbook has nothing to print: its sheets are empty.");
  const total = printers.reduce((t, p) => t + p.pages.length, 0);
  const date = new Date();
  const outline: OutlineEntry[] = [];
  let pageNo = 0;
  for (const p of printers) {
    const st = p.sheet.setup;
    const hf = p.sheet.hf;
    const base = { ...wb.defaultFont };
    const hfScale = hf.scaleWithDoc ? p.scale : 1;
    outline.push({ title: p.sheet.name, pageIndex: pageNo });
    for (let i = 0; i < p.pages.length; i++) {
      pageNo++;
      if (pageNo % 5 === 0) {
        onProgress?.(0.15 + (0.8 * pageNo) / total, `Drawing page ${pageNo} of ${total}`);
        await tick();
      }
      const page = doc.addPage([st.paperW, st.paperH]);
      const links = await p.paint(page, p.pages[i]);
      addLinks(doc, page, links);
      const num = st.firstPageNumber != null ? st.firstPageNumber + i : pageNo;
      const first = i === 0 && hf.differentFirst;
      const even = !first && hf.differentOddEven && num % 2 === 0;
      const headerSrc = first ? hf.firstHeader : even ? hf.evenHeader : hf.oddHeader;
      const footerSrc = first ? hf.firstFooter : even ? hf.evenFooter : hf.oddFooter;
      const ctx = { page: num, pages: total, file: name, sheet: p.sheet.name, date };
      const area = { left: st.margins.left, right: st.margins.right };
      if (headerSrc) await drawHF(page, parseHF(headerSrc, base, wb.theme), ctx, kit, { ...area, edge: st.margins.header }, true, hfScale);
      if (footerSrc) await drawHF(page, parseHF(footerSrc, base, wb.theme), ctx, kit, { ...area, edge: st.margins.footer }, false, hfScale);
    }
  }
  // One bookmark per sheet, when there is more than one.
  if (outline.length > 1) setOutline(doc, outline, true);
  onProgress?.(0.97, "Saving");
  const pdf = await saveDoc(doc);
  return { pdf, pages: total, sheets: printers.length, warnings: [...wb.warnings] };
}
