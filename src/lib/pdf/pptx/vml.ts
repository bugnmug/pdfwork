/**
 * Legacy VML drawings, where PowerPoint keeps the preview pictures of ActiveX controls (a
 * Flash movie's poster frame) and of OLE objects saved by older versions. VML isn't always
 * well-formed XML (Office wraps parts of it in <![if ...]> blocks), so it is read as text.
 */
import type { Package } from "../ooxml";

/** A shape's box on the slide (points) and the picture it shows. */
export type VmlPic = { x: number; y: number; w: number; h: number; target: string | null };

const UNITS: Record<string, number> = { pt: 1, in: 72, px: 0.75, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, emu: 1 / 12700 };
const cache = new WeakMap<Package, Map<string, Promise<Map<string, VmlPic>>>>();

function length(v: string | undefined): number | undefined {
  const m = /^\s*(-?[\d.]+)\s*([a-z]*)\s*$/i.exec(v ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return n * (UNITS[m[2].toLowerCase()] ?? 0.75);
}

const attrOf = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
};

/** Every shape of a VML part by its id (o:spid, else id), with its box and picture. */
export function vmlPictures(pkg: Package, path: string): Promise<Map<string, VmlPic>> {
  let per = cache.get(pkg);
  if (!per) cache.set(pkg, (per = new Map()));
  let job = per.get(path);
  if (!job) {
    job = (async () => {
      const out = new Map<string, VmlPic>();
      const text = await pkg.text(path);
      if (!text) return out;
      const rels = await pkg.rels(path);
      for (const m of text.matchAll(/<v:(shape|rect|image|roundrect)\b([^>]*?)(\/>|>([\s\S]*?)<\/v:\1>)/gi)) {
        const attrs = m[2];
        const id = attrOf(attrs, "o:spid") ?? attrOf(attrs, "id");
        if (!id) continue;
        const style: Record<string, string> = {};
        for (const kv of (attrOf(attrs, "style") ?? "").split(";")) {
          const i = kv.indexOf(":");
          if (i > 0) style[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
        }
        const x = length(style.left ?? style["margin-left"]);
        const y = length(style.top ?? style["margin-top"]);
        const w = length(style.width);
        const h = length(style.height);
        if (x === undefined || y === undefined || !w || !h) continue;
        const img = /<v:imagedata\b([^>]*)>/i.exec(m[4] ?? "") ?? (m[1].toLowerCase() === "image" ? [m[0], attrs] : null);
        const relId = img ? (attrOf(img[1], "o:relid") ?? attrOf(img[1], "r:id") ?? attrOf(img[1], "src")) : undefined;
        const rel = relId ? rels.get(relId) : undefined;
        out.set(id, { x, y, w, h, target: rel && !rel.external ? rel.target : null });
      }
      return out;
    })().catch(() => new Map());
    per.set(path, job);
  }
  return job;
}

/** The VML id an ActiveX control or OLE object refers to (spid "2053" is shape "_x0000_s2053"). */
export const vmlId = (spid: string) => (/^\d+$/.test(spid) ? `_x0000_s${spid}` : spid);
