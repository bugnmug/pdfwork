/**
 * A photo of a signature on paper turned into ink on a transparent background.
 *
 * Phone photos are rarely evenly lit: the paper is bright under the light and grey in the
 * shadow of the phone or a hand. So the paper's brightness is estimated around every pixel
 * (the brightest values nearby, smoothed), and a pixel counts as ink when it is clearly darker
 * than the paper around it, not darker than one fixed level. Dust and paper specks away from
 * the signature are dropped, so the trimmed signature is just the signature.
 */

/** RGBA pixels, as in ImageData. */
export type Pixels = { data: Uint8ClampedArray; width: number; height: number };

/**
 * Makes the paper transparent in place. `strength` (0.5 to 0.95): how much darker than the paper
 * around it a pixel must be to count as ink (0.78: at most 78% as bright). `recolor`: an ink
 * colour ("#rrggbb") to paint the strokes in, or null to keep their own.
 */
export function cleanSignature(img: Pixels, strength: number, recolor: string | null): void {
  const { data: px, width: W, height: H } = img;
  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;

  // The paper around each pixel: the brightest value in each block (thin strokes vanish), the
  // brightest of the blocks around (wide strokes too), smoothed, then read back per pixel.
  const f = Math.max(4, Math.round(Math.max(W, H) / 220));
  const bw = Math.ceil(W / f);
  const bh = Math.ceil(H / f);
  const block = new Float32Array(bw * bh);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = ((y / f) | 0) * bw + ((x / f) | 0);
      if (lum[y * W + x] > block[k]) block[k] = lum[y * W + x];
    }
  const filter = (src: Float32Array, r: number, op: "max" | "mean") => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        let v = 0;
        let c = 0;
        for (let d = -r; d <= r; d++) {
          const xx = Math.min(bw - 1, Math.max(0, x + d));
          const s = src[y * bw + xx];
          if (op === "max") v = Math.max(v, s);
          else v += s;
          c++;
        }
        tmp[y * bw + x] = op === "max" ? v : v / c;
      }
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        let v = 0;
        let c = 0;
        for (let d = -r; d <= r; d++) {
          const yy = Math.min(bh - 1, Math.max(0, y + d));
          const s = tmp[yy * bw + x];
          if (op === "max") v = Math.max(v, s);
          else v += s;
          c++;
        }
        out[y * bw + x] = op === "max" ? v : v / c;
      }
    return out;
  };
  const paperMap = filter(filter(block, 3, "max"), 2, "mean");
  const paperAt = (x: number, y: number) => {
    // Bilinear between block centres.
    const gx = Math.min(bw - 1, Math.max(0, x / f - 0.5));
    const gy = Math.min(bh - 1, Math.max(0, y / f - 0.5));
    const x0 = gx | 0;
    const y0 = gy | 0;
    const x1 = Math.min(bw - 1, x0 + 1);
    const y1 = Math.min(bh - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    const a = paperMap[y0 * bw + x0] * (1 - tx) + paperMap[y0 * bw + x1] * tx;
    const b = paperMap[y1 * bw + x0] * (1 - tx) + paperMap[y1 * bw + x1] * tx;
    return a * (1 - ty) + b * ty;
  };

  // Ink: clearly darker than the paper around it, with a soft edge.
  const alpha = new Uint8Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const paper = Math.max(1, paperAt(x, y));
      const r = lum[i] / paper;
      if (r < strength) alpha[i] = Math.round(255 * Math.min(1, (strength - r) / (strength * 0.25)));
    }

  // Specks: small blots away from the signature. Pieces of ink are found (connected pixels);
  // the big ones are the signature; small ones far outside its box are dropped (an i's dot or a
  // full stop next to the name stays).
  const label = new Int32Array(n).fill(-1);
  const pieces: { area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (alpha[s] < 96 || label[s] >= 0) continue;
    const id = pieces.length;
    const p = { area: 0, x0: W, y0: H, x1: 0, y1: 0 };
    let top = 0;
    stack[top++] = s;
    label[s] = id;
    while (top) {
      const i = stack[--top];
      const x = i % W;
      const y = (i / W) | 0;
      p.area++;
      if (x < p.x0) p.x0 = x;
      if (x > p.x1) p.x1 = x;
      if (y < p.y0) p.y0 = y;
      if (y > p.y1) p.y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j >= 0 && label[j] < 0 && alpha[j] >= 96) {
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    pieces.push(p);
  }
  const biggest = pieces.reduce((m, p) => Math.max(m, p.area), 0);
  const main = pieces.filter((p) => p.area >= biggest * 0.04);
  if (main.length) {
    const box = { x0: Math.min(...main.map((p) => p.x0)), y0: Math.min(...main.map((p) => p.y0)), x1: Math.max(...main.map((p) => p.x1)), y1: Math.max(...main.map((p) => p.y1)) };
    const mx = (box.x1 - box.x0) * 0.08 + 6;
    const my = (box.y1 - box.y0) * 0.15 + 6;
    const drop = pieces.map((p) => p.area < biggest * 0.04 && (p.x1 < box.x0 - mx || p.x0 > box.x1 + mx || p.y1 < box.y0 - my || p.y0 > box.y1 + my));
    for (let i = 0; i < n; i++) {
      // Faint pixels belong to the piece next to them; only pieces themselves are dropped.
      if (label[i] >= 0 && drop[label[i]]) alpha[i] = 0;
    }
    // Faint fringes around dropped specks (below the piece threshold) go with them.
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (alpha[i] && alpha[i] < 96 && label[i] < 0) {
          let near = false;
          for (const j of [i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1]) if (alpha[j] >= 96) near = true;
          if (!near && (x < box.x0 - mx || x > box.x1 + mx || y < box.y0 - my || y > box.y1 + my)) alpha[i] = 0;
        }
      }
  }

  const rgb = recolor ? [parseInt(recolor.slice(1, 3), 16), parseInt(recolor.slice(3, 5), 16), parseInt(recolor.slice(5, 7), 16)] : null;
  for (let i = 0; i < n; i++) {
    px[i * 4 + 3] = alpha[i];
    if (rgb && alpha[i]) {
      px[i * 4] = rgb[0];
      px[i * 4 + 1] = rgb[1];
      px[i * 4 + 2] = rgb[2];
    }
  }
}
