/**
 * Document-scanner image processing, all on the device: find the paper in a
 * photo, straighten it with a perspective warp, and clean it up.
 */
export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt]; // top-left, top-right, bottom-right, bottom-left
export type ScanFilter = "original" | "enhance" | "gray" | "bw";

export function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Load an image file into a canvas, honouring EXIF rotation, capped at maxSide pixels. */
export async function fileToCanvas(file: Blob, maxSide = 3000): Promise<HTMLCanvasElement> {
  let bmp: ImageBitmap | HTMLImageElement;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(file);
    bmp = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("This image format isn't supported by your browser. Try a JPG or PNG."));
      i.src = url;
    });
  }
  const w = "naturalWidth" in bmp ? bmp.naturalWidth : bmp.width;
  const h = "naturalHeight" in bmp ? bmp.naturalHeight : bmp.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = canvasOf(w * s, h * s);
  c.getContext("2d", { willReadFrequently: true })!.drawImage(bmp, 0, 0, c.width, c.height);
  if ("close" in bmp) bmp.close();
  return c;
}

const fullQuad = (w: number, h: number, inset = 0): Quad => [
  [w * inset, h * inset],
  [w * (1 - inset), h * inset],
  [w * (1 - inset), h * (1 - inset)],
  [w * inset, h * (1 - inset)],
];

function quadArea(q: Quad) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (z !== 0) {
      if (sign && Math.sign(z) !== sign) return false;
      sign = Math.sign(z);
    }
  }
  return true;
}

/**
 * Find the sheet of paper: threshold the (small) image with Otsu's method,
 * keep the largest bright region, and take its extreme points as corners.
 * Falls back to the whole frame when nothing convincing is found.
 */
export function detectQuad(src: HTMLCanvasElement): Quad {
  const W = src.width;
  const H = src.height;
  const s = Math.min(1, 360 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s));
  const h = Math.max(8, Math.round(H * s));
  const c = canvasOf(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  // 5x5 box blur to suppress text and texture.
  const b = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
            sum += g[yy * w + xx];
            n++;
          }
        }
      b[y * w + x] = sum / n;
    }
  // Otsu threshold.
  const hist = new Array(256).fill(0);
  for (const v of b) hist[Math.min(255, v | 0)]++;
  const total = w * h;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const bright = new Uint8Array(total);
  for (let i = 0; i < total; i++) bright[i] = b[i] > thr ? 1 : 0;
  // Largest 4-connected bright region.
  const label = new Int32Array(total);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 1;
  const stack: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!bright[i] || label[i]) continue;
    let size = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb)
        if (q >= 0 && bright[q] && !label[q]) {
          label[q] = next;
          stack.push(q);
        }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
    next++;
  }
  if (bestSize < total * 0.12) return fullQuad(W, H, 0.02);
  let tl: Pt = [0, 0];
  let tr: Pt = [0, 0];
  let br: Pt = [0, 0];
  let bl: Pt = [0, 0];
  let minS = Infinity;
  let maxS = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < total; i++) {
    if (label[i] !== bestLabel) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const sSum = x + y;
    const sDiff = x - y;
    if (sSum < minS) [minS, tl] = [sSum, [x, y]];
    if (sSum > maxS) [maxS, br] = [sSum, [x, y]];
    if (sDiff > maxD) [maxD, tr] = [sDiff, [x, y]];
    if (sDiff < minD) [minD, bl] = [sDiff, [x, y]];
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [Math.min(W, (x + 0.5) / s), Math.min(H, (y + 0.5) / s)] as Pt) as Quad;
  const area = quadArea(q) / (W * H);
  if (area < 0.15 || area > 0.995 || !isConvex(q)) return fullQuad(W, H, 0.02);
  return q;
}

export function fullFrame(src: HTMLCanvasElement): Quad {
  return fullQuad(src.width, src.height);
}

/** Solve the 3x3 homography that maps (0,0),(w,0),(w,h),(0,h) onto the quad. */
function homography(q: Quad, w: number, h: number): number[] {
  const src: Pt[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [B[col], B[piv]] = [B[piv], B[col]];
    const p = A[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / p;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      B[r] -= f * B[col];
    }
  }
  const x = B.map((v, i) => v / (A[i][i] || 1e-12));
  return [...x, 1];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Straighten the quad into a flat rectangle. */
export function warp(src: HTMLCanvasElement, q: Quad, maxSide = 2400): HTMLCanvasElement {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1.5, maxSide / Math.max(w, h));
  w = Math.max(8, Math.round(w * s));
  h = Math.max(8, Math.round(h * s));
  const H = homography(q, w, h);
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  const sd = sctx.getImageData(0, 0, src.width, src.height);
  const sp = sd.data;
  const SW = src.width;
  const SH = src.height;
  const out = canvasOf(w, h);
  const octx = out.getContext("2d", { willReadFrequently: true })!;
  const od = octx.createImageData(w, h);
  const op = od.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = H[6] * x + H[7] * y + H[8];
      let u = (H[0] * x + H[1] * y + H[2]) / den;
      let v = (H[3] * x + H[4] * y + H[5]) / den;
      u = Math.max(0, Math.min(SW - 1.001, u));
      v = Math.max(0, Math.min(SH - 1.001, v));
      const x0 = u | 0;
      const y0 = v | 0;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * SW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + SW * 4;
      const i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sp[i00 + c] + (sp[i10 + c] - sp[i00 + c]) * fx;
        const bot = sp[i01 + c] + (sp[i11 + c] - sp[i01 + c]) * fx;
        op[o + c] = top + (bot - top) * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export function rotate(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const r = ((deg % 360) + 360) % 360;
  if (!r) return src;
  const swap = r === 90 || r === 270;
  const out = canvasOf(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/** Clean-up filters. Works in place and returns the same canvas. */
export function applyFilter(c: HTMLCanvasElement, f: ScanFilter): HTMLCanvasElement {
  if (f === "original") return c;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const p = img.data;
  const n = c.width * c.height;
  if (f === "gray" || f === "enhance") {
    // Stretch levels between the 2nd and 98th percentile of brightness (removes the grey cast of photos).
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[(p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114) | 0]++;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.02; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
    const range = Math.max(30, hi - lo);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (f === "gray") {
        const l = p[o] * 0.299 + p[o + 1] * 0.587 + p[o + 2] * 0.114;
        const v = Math.max(0, Math.min(255, ((l - lo) / range) * 255));
        p[o] = p[o + 1] = p[o + 2] = v;
      } else {
        for (let k = 0; k < 3; k++) p[o + k] = Math.max(0, Math.min(255, ((p[o + k] - lo) / range) * 255));
      }
    }
  } else {
    // Adaptive threshold (Bradley): compare each pixel with the average of its neighbourhood,
    // so shadows and uneven light don't turn the page grey or black.
    const w = c.width;
    const h = c.height;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) gray[i] = p[i * 4] * 0.299 + p[i * 4 + 1] * 0.587 + p[i * 4 + 2] * 0.114;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let row = 0;
      for (let x = 1; x <= w; x++) {
        row += gray[(y - 1) * w + (x - 1)];
        integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
      }
    }
    const r = Math.max(8, Math.round(Math.max(w, h) / 40));
    const t = 0.13;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const count = (x1 - x0) * (y1 - y0);
        const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        const v = gray[y * w + x] * count < sum * (1 - t) ? 0 : 255;
        const o = (y * w + x) * 4;
        p[o] = p[o + 1] = p[o + 2] = v;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function process(src: HTMLCanvasElement, q: Quad, filter: ScanFilter, rotation: number, maxSide = 2400): HTMLCanvasElement {
  return applyFilter(rotate(warp(src, q, maxSide), rotation), filter);
}
