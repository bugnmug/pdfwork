/**
 * Outer shadows: the shape's silhouette, scaled, skewed and offset as the
 * effect says. Sharp shadows are vector; blurred ones are rendered once on a
 * canvas (the browser's own Gaussian blur) and placed as a soft picture.
 */
import type { PDFImage } from "@cantoo/pdf-lib";
import { canvasToBytes, type PDFDocument } from "../core";
import type { Geometry, Seg } from "../drawingml/geometry";
import { strokeStyle, type Frame, type Line, type Shadow } from "../drawingml/fill";
import { apply, then, translate, type Mat, type Pen } from "../drawingml/pen";

const cache = new WeakMap<PDFDocument, Map<string, Promise<PDFImage | null>>>();

function bbox(paths: Seg[][], m: Mat): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    const [px, py] = apply(m, x, y);
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  };
  for (const segs of paths)
    for (const s of segs) {
      if (s.t === "Z") continue;
      if (s.t === "C") {
        add(s.x1, s.y1);
        add(s.x2, s.y2);
      }
      add(s.x, s.y);
    }
  return [x0, y0, x1, y1];
}

/** Shadow placement: scale and skew about the alignment point, then the offset. */
function shadowMatrix(sh: Shadow, box: [number, number, number, number]): Mat {
  const [x0, y0, x1, y1] = box;
  const a = sh.algn;
  const ax = /l$/.test(a) && a !== "ctr" ? x0 : /r$/.test(a) ? x1 : (x0 + x1) / 2;
  const ay = /^t/.test(a) ? y0 : /^b/.test(a) ? y1 : (y0 + y1) / 2;
  const r = (sh.dir * Math.PI) / 180;
  const skew: Mat = [sh.sx, Math.tan((sh.ky * Math.PI) / 180) * sh.sy, Math.tan((sh.kx * Math.PI) / 180) * sh.sx, sh.sy, 0, 0];
  return then(then(then(translate(-ax, -ay), skew), translate(ax, ay)), translate(sh.dist * Math.cos(r), sh.dist * Math.sin(r)));
}

export async function paintShadow(pen: Pen, doc: PDFDocument, geo: Geometry, frame: Frame, sh: Shadow, filled: boolean, line: Line) {
  const paths = geo.paths.filter((p) => (filled ? p.fill !== "none" : p.stroke)).map((p) => p.segs);
  if (!paths.length || sh.color.alpha <= 0.01) return;
  const box = bbox(paths, frame.m);
  if (!Number.isFinite(box[0])) return;
  const sm = then(frame.m, shadowMatrix(sh, box));
  const lw = filled ? 0 : strokeStyle(line).width;
  if (sh.blur < 0.6) {
    pen.save();
    for (const segs of paths) {
      pen.path(segs, sm);
      if (filled) pen.fillWith(sh.color, true);
      else pen.strokeWith(sh.color, { width: lw, cap: "rnd", join: "round" });
    }
    pen.restore();
    return;
  }
  const sb = bbox(paths, sm);
  const pad = sh.blur * 2 + lw;
  const X0 = sb[0] - pad;
  const Y0 = sb[1] - pad;
  const W = sb[2] - sb[0] + pad * 2;
  const H = sb[3] - sb[1] + pad * 2;
  if (W <= 0 || H <= 0 || W > 20000 || H > 20000) return;
  // Blur hides detail: a few pixels per point is plenty.
  const k = Math.max(0.35, Math.min(2, 2400 / Math.max(W, H), 6 / Math.max(1, sh.blur)));
  const cw = Math.max(1, Math.ceil(W * k));
  const ch = Math.max(1, Math.ceil(H * k));
  const local = then(sm, [k, 0, 0, k, -X0 * k, -Y0 * k]);
  let d = "";
  for (const segs of paths)
    for (const s of segs) {
      if (s.t === "Z") d += "Z";
      else if (s.t === "C") {
        const p1 = apply(local, s.x1, s.y1);
        const p2 = apply(local, s.x2, s.y2);
        const p = apply(local, s.x, s.y);
        d += `C${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      } else {
        const p = apply(local, s.x, s.y);
        d += `${s.t}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      }
    }
  const key = `${cw}x${ch}|${sh.blur.toFixed(2)}|${sh.color.hex}${sh.color.alpha.toFixed(3)}|${filled ? "f" : "s" + lw}|${d}`;
  let per = cache.get(doc);
  if (!per) cache.set(doc, (per = new Map()));
  let job = per.get(key);
  if (!job) {
    job = (async () => {
      try {
        const c = document.createElement("canvas");
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        const off = cw + 50;
        const p2 = new Path2D(d);
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(sh.color.hex.slice(i, i + 2), 16));
        ctx.shadowColor = `rgba(${r},${g},${b},${sh.color.alpha})`;
        ctx.shadowBlur = sh.blur * k;
        ctx.shadowOffsetX = off;
        ctx.translate(-off, 0);
        if (filled) {
          ctx.fillStyle = "#000";
          ctx.fill(p2, "evenodd");
        } else {
          ctx.strokeStyle = "#000";
          ctx.lineWidth = lw * k;
          ctx.stroke(p2);
        }
        return await doc.embedPng(await canvasToBytes(c, "image/png"));
      } catch {
        return null;
      }
    })();
    per.set(key, job);
  }
  const img = await job;
  if (img) pen.image(img, [W, 0, 0, -H, X0, Y0 + H]);
}

/**
 * The shadow of a picture with transparent parts: cast by its visible pixels (an icon's
 * shape), not its rectangle. `place` is where the picture sits in its box.
 */
export async function paintPictureShadow(pen: Pen, doc: PDFDocument, mask: HTMLCanvasElement | null, place: { ix: number; iy: number; iw: number; ih: number }, clip: Seg[] | null, frame: Frame, sh: Shadow): Promise<boolean> {
  if (!mask || sh.color.alpha <= 0.01) return false;
  const corners = [
    [0, 0],
    [frame.w, 0],
    [frame.w, frame.h],
    [0, frame.h],
  ].map(([x, y]) => apply(frame.m, x, y));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const pad = sh.blur * 2 + 1;
  const X0 = Math.min(...xs) - pad;
  const Y0 = Math.min(...ys) - pad;
  const W = Math.max(...xs) - Math.min(...xs) + pad * 2;
  const H = Math.max(...ys) - Math.min(...ys) + pad * 2;
  if (W <= 0 || H <= 0 || W > 20000 || H > 20000) return false;
  const k = Math.max(0.5, Math.min(3, 1800 / Math.max(W, H)));
  const cw = Math.max(1, Math.ceil(W * k));
  const ch = Math.max(1, Math.ceil(H * k));
  try {
    // The picture's pixels where it shows, tinted with the shadow colour.
    const sil = document.createElement("canvas");
    sil.width = cw;
    sil.height = ch;
    const s = sil.getContext("2d");
    if (!s) return false;
    const m = frame.m;
    s.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * (m[4] - X0), k * (m[5] - Y0));
    if (clip) {
      let d = "";
      for (const q of clip) d += q.t === "Z" ? "Z" : q.t === "C" ? `C${q.x1} ${q.y1} ${q.x2} ${q.y2} ${q.x} ${q.y}` : `${q.t}${q.x} ${q.y}`;
      s.clip(new Path2D(d), "evenodd");
    }
    s.drawImage(mask, place.ix, place.iy, place.iw, place.ih);
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = "source-in";
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(sh.color.hex.slice(i, i + 2), 16));
    s.fillStyle = `rgb(${r},${g},${b})`;
    s.fillRect(0, 0, cw, ch);
    // Offset (and blurred) through the canvas's own shadow.
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const o = out.getContext("2d");
    if (!o) return false;
    const off = cw + 50;
    o.shadowColor = `rgba(${r},${g},${b},${sh.color.alpha})`;
    o.shadowBlur = sh.blur * k;
    o.shadowOffsetX = off;
    o.drawImage(sil, -off, 0);
    const img = await doc.embedPng(await canvasToBytes(out, "image/png"));
    const rad = (sh.dir * Math.PI) / 180;
    const dx = sh.dist * Math.cos(rad);
    const dy = sh.dist * Math.sin(rad);
    pen.image(img, [W, 0, 0, -H, X0 + dx, Y0 + dy + H]);
    return true;
  } catch {
    return false;
  }
}
