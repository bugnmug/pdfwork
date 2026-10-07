import { PDFHexString, PDFName, PDFNumber, type PDFDict, type PDFRef } from "@cantoo/pdf-lib";
import type { PDFDocument } from "./core";

/** `top`: where on the page the entry goes, in points up from the bottom (the page top when left out). */
export type OutlineEntry = { title: string; pageIndex: number; top?: number; children?: OutlineEntry[] };

/** Write a bookmark tree (replaces any existing outline). */
export function setOutline(doc: PDFDocument, entries: OutlineEntry[], open = true) {
  if (!entries.length) return;
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!pages.length) return;
  const rootRef = ctx.nextRef();

  const build = (list: OutlineEntry[], parent: PDFRef): { first: PDFRef; last: PDFRef; visible: number } => {
    const refs = list.map(() => ctx.nextRef());
    let visible = 0;
    list.forEach((e, i) => {
      const page = pages[Math.min(Math.max(0, e.pageIndex), pages.length - 1)];
      const dict = ctx.obj({
        Title: PDFHexString.fromText(e.title.slice(0, 300)),
        Parent: parent,
        Dest: [page.ref, "XYZ", null, e.top ?? null, null],
      }) as PDFDict;
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
      visible += 1;
      if (e.children?.length) {
        const sub = build(e.children, refs[i]);
        dict.set(PDFName.of("First"), sub.first);
        dict.set(PDFName.of("Last"), sub.last);
        dict.set(PDFName.of("Count"), PDFNumber.of(open ? sub.visible : -sub.visible));
        if (open) visible += sub.visible;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };

  const top = build(entries, rootRef);
  ctx.assign(
    rootRef,
    ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: PDFNumber.of(top.visible) }),
  );
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

/** Turn a flat (title, page, level) list into a tree. */
export function treeFromFlat(flat: { title: string; page: number; level: number }[], pageOffset = 0): OutlineEntry[] {
  const root: OutlineEntry[] = [];
  const stack: { level: number; entry: OutlineEntry }[] = [];
  for (const f of flat) {
    if (f.page < 1) continue;
    const entry: OutlineEntry = { title: f.title, pageIndex: f.page - 1 + pageOffset };
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop();
    if (stack.length) (stack[stack.length - 1].entry.children ??= []).push(entry);
    else root.push(entry);
    stack.push({ level: f.level, entry });
  }
  return root;
}
