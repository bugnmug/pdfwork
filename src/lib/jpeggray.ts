/**
 * A baseline JPEG encoder for one-channel (grey) images. Browsers only write colour JPEGs, so a
 * grey photo saved through a canvas carries three channels; this writes the single channel a
 * PDF's DeviceGray picture needs, at about two thirds of the size.
 */

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
// prettier-ignore
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** Huffman codes from a table's code-length counts and values: [code, length] per value. */
function huffman(bits: number[], vals: number[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) out.set(vals[k++], [code++, len]);
    code <<= 1;
  }
  return out;
}

const DC = huffman(DC_BITS, DC_VALS);
const AC = huffman(AC_BITS, AC_VALS);
const COS = Array.from({ length: 64 }, (_, i) => Math.cos(((2 * (i >> 3) + 1) * (i & 7) * Math.PI) / 16));

/** Encodes 8-bit grey pixels (width × height, row by row). `quality`: 1 to 100. */
export function encodeGrayJpeg(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, quality = 85): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const table = STD_LUMA.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
  const out: number[] = [];
  const word = (v: number) => out.push((v >> 8) & 255, v & 255);
  const marker = (m: number, body: number[]) => {
    out.push(0xff, m);
    word(body.length + 2);
    out.push(...body);
  };
  out.push(0xff, 0xd8);
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  marker(0xdb, [0, ...ZIGZAG.map((n) => table[n])]);
  marker(0xc0, [8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 1, 1, 0x11, 0]);
  marker(0xc4, [0x00, ...DC_BITS, ...DC_VALS]);
  marker(0xc4, [0x10, ...AC_BITS, ...AC_VALS]);
  marker(0xda, [1, 1, 0x00, 0, 63, 0]);

  // Entropy-coded data, with 0xFF bytes stuffed.
  let acc = 0;
  let nbits = 0;
  const put = (code: number, len: number) => {
    acc = (acc << len) | (code & ((1 << len) - 1));
    nbits += len;
    while (nbits >= 8) {
      const b = (acc >> (nbits - 8)) & 255;
      out.push(b);
      if (b === 0xff) out.push(0);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  const category = (v: number) => {
    let a = Math.abs(v);
    let n = 0;
    while (a) {
      n++;
      a >>= 1;
    }
    return n;
  };
  const bitsOf = (v: number, n: number) => (v < 0 ? v + (1 << n) - 1 : v);
  const block = new Float64Array(64);
  const rows = new Float64Array(64);
  const coef = new Int32Array(64);
  let prevDc = 0;
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const sx = Math.min(width - 1, bx + x);
          const sy = Math.min(height - 1, by + y);
          block[y * 8 + x] = gray[sy * width + sx] - 128;
        }
      // Forward DCT (rows, then columns), then quantisation.
      for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u];
          rows[y * 8 + u] = s;
        }
      for (let v = 0; v < 8; v++)
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let y = 0; y < 8; y++) s += rows[y * 8 + u] * COS[y * 8 + v];
          const c = (u ? 1 : Math.SQRT1_2) * (v ? 1 : Math.SQRT1_2) * 0.25 * s;
          coef[v * 8 + u] = Math.round(c / table[v * 8 + u]);
        }
      const dc = coef[0] - prevDc;
      prevDc = coef[0];
      const dn = category(dc);
      const [dcode, dlen] = DC.get(dn)!;
      put(dcode, dlen);
      if (dn) put(bitsOf(dc, dn), dn);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = coef[ZIGZAG[k]];
        if (!v) {
          run++;
          continue;
        }
        while (run > 15) {
          const [c, l] = AC.get(0xf0)!;
          put(c, l);
          run -= 16;
        }
        const n = category(v);
        const [c, l] = AC.get((run << 4) | n)!;
        put(c, l);
        put(bitsOf(v, n), n);
        run = 0;
      }
      if (run) {
        const [c, l] = AC.get(0)!;
        put(c, l);
      }
    }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}
