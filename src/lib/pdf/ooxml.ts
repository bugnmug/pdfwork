/**
 * Shared Office Open XML plumbing: the zip package and its relationships,
 * small XML helpers, the theme (colours and fonts) and DrawingML colours.
 */
import JSZip from "jszip";

export type El = Element;

export const kids = (el: El | null | undefined, name: string): El[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
export const kid = (el: El | null | undefined, name: string): El | null => {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
};
export const path = (el: El | null | undefined, ...names: string[]): El | null => names.reduce<El | null>((cur, n) => kid(cur, n), el ?? null);
/** An attribute by local name, whatever its namespace prefix (w:val, r:id...). */
export function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null;
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}
export const num = (v: string | null | undefined, d = 0): number => {
  if (v == null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
/** On/off values: absent means `d`; "0", "false", "off" mean false. */
export const onOff = (el: El | null | undefined, d = false): boolean | undefined => {
  if (!el) return undefined;
  const v = attr(el, "val");
  if (v == null) return true;
  return !(v === "0" || v === "false" || v === "off" || v === "none") || d;
};

export const EMU_PER_PT = 12700;
export const twip = (v: string | null | undefined, d = 0) => num(v, d * 20) / 20;
export const emu = (v: string | null | undefined, d = 0) => num(v, d * EMU_PER_PT) / EMU_PER_PT;

export type Rel = { target: string; type: string; external: boolean };
export type Part = { path: string; doc: Document; rels: Map<string, Rel> };

export function resolvePath(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export class Package {
  private cache = new Map<string, Promise<Part | null>>();
  constructor(public zip: JSZip) {}
  static async open(bytes: Uint8Array): Promise<Package> {
    return new Package(await JSZip.loadAsync(bytes));
  }
  has(p: string) {
    return !!this.zip.file(p);
  }
  async text(p: string): Promise<string | null> {
    const f = this.zip.file(p) ?? this.zip.file(decodeURIComponent(p));
    return f ? f.async("string") : null;
  }
  async xml(p: string): Promise<Document | null> {
    const t = await this.text(p);
    if (t == null) return null;
    const doc = new DOMParser().parseFromString(t, "application/xml");
    return doc.getElementsByTagName("parsererror").length ? null : doc;
  }
  part(p: string): Promise<Part | null> {
    let c = this.cache.get(p);
    if (!c) {
      c = (async () => {
        const doc = await this.xml(p);
        if (!doc) return null;
        return { path: p, doc, rels: await this.rels(p) };
      })();
      this.cache.set(p, c);
    }
    return c;
  }
  async rels(p: string): Promise<Map<string, Rel>> {
    const rels = new Map<string, Rel>();
    const relsDoc = await this.xml(p.replace(/([^/]+)$/, "_rels/$1.rels"));
    if (!relsDoc) return rels;
    for (const r of Array.from(relsDoc.getElementsByTagName("Relationship"))) {
      const external = r.getAttribute("TargetMode") === "External";
      const target = r.getAttribute("Target") || "";
      rels.set(r.getAttribute("Id") || "", { target: external ? target : resolvePath(p, target), type: r.getAttribute("Type") || "", external });
    }
    return rels;
  }
  async bytes(p: string): Promise<Uint8Array | null> {
    const f = this.zip.file(p) ?? this.zip.file(decodeURIComponent(p));
    return f ? f.async("uint8array") : null;
  }
  /** The main document part, from the package relationships. */
  async mainPart(type: RegExp): Promise<string | null> {
    const root = await this.rels("");
    for (const r of root.values()) if (type.test(r.type)) return r.target.replace(/^\//, "");
    return null;
  }
}

/* ---------------------------------------------------------------- theme */

export type ThemeFonts = { latin: string; ea: string; cs: string; scripts: Record<string, string> };
export type Theme = { colors: Record<string, string>; major: ThemeFonts; minor: ThemeFonts };

export const DEFAULT_THEME_COLORS: Record<string, string> = {
  dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5",
  accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72",
};

export function readTheme(doc: Document | null): Theme {
  const colors = { ...DEFAULT_THEME_COLORS };
  const fonts = (name: string): ThemeFonts => {
    const el = doc?.getElementsByTagNameNS("*", name)[0];
    const scripts: Record<string, string> = {};
    for (const f of kids(el, "font")) scripts[f.getAttribute("script") ?? ""] = f.getAttribute("typeface") ?? "";
    return {
      latin: kid(el, "latin")?.getAttribute("typeface") ?? "",
      ea: kid(el, "ea")?.getAttribute("typeface") ?? "",
      cs: kid(el, "cs")?.getAttribute("typeface") ?? "",
      scripts,
    };
  };
  if (doc) {
    const scheme = doc.getElementsByTagNameNS("*", "clrScheme")[0];
    for (const c of Array.from(scheme?.children ?? [])) {
      const srgb = kid(c, "srgbClr")?.getAttribute("val");
      const sys = kid(c, "sysClr")?.getAttribute("lastClr");
      if (srgb || sys) colors[c.localName] = (srgb || sys)!;
    }
  }
  return { colors, major: fonts("majorFont"), minor: fonts("minorFont") };
}

/* -------------------------------------------------------------- colours */

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const hexOf = (r: number, g: number, b: number) => [r, g, b].map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
export const rgbOf = (hex: string): [number, number, number] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255 || 0) as [number, number, number];

const PRESET: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080",
  orange: "FFA500", purple: "800080", darkBlue: "00008B", darkRed: "8B0000", darkGreen: "006400", lightGray: "D3D3D3", silver: "C0C0C0",
  navy: "000080", teal: "008080", maroon: "800000", olive: "808000", cyan: "00FFFF", magenta: "FF00FF", ltGray: "C0C0C0", dkGray: "808080",
};

/**
 * A DrawingML colour element's parent (solidFill, a:fgClr...) to hex and alpha,
 * applying lumMod/lumOff/tint/shade/alpha the way Office does.
 */
export function drawingColor(el: El | null, theme: Theme, map: Record<string, string> = {}, phClr?: string): { hex: string; alpha: number } | null {
  if (!el) return null;
  const node = ["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr", "hslClr"].map((n) => kid(el, n)).find(Boolean) ?? null;
  if (!node) return null;
  let hex = "000000";
  if (node.localName === "srgbClr") hex = node.getAttribute("val") || hex;
  else if (node.localName === "sysClr") hex = node.getAttribute("lastClr") || (node.getAttribute("val") === "window" ? "FFFFFF" : "000000");
  else if (node.localName === "prstClr") hex = PRESET[node.getAttribute("val") || ""] ?? "000000";
  else if (node.localName === "schemeClr") {
    let v = node.getAttribute("val") || "tx1";
    if (v === "phClr" && phClr) hex = phClr;
    else {
      v = map[v] ?? ({ tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2" } as Record<string, string>)[v] ?? v;
      hex = theme.colors[v] ?? "000000";
    }
  } else if (node.localName === "scrgbClr") {
    const f = (k: string) => num(node.getAttribute(k)) / 100000;
    hex = hexOf(f("r"), f("g"), f("b"));
  } else if (node.localName === "hslClr") {
    const [r, g, b] = hslToRgb(num(node.getAttribute("hue")) / 21600000, num(node.getAttribute("sat")) / 100000, num(node.getAttribute("lum")) / 100000);
    hex = hexOf(r, g, b);
  }
  let [r, g, b] = rgbOf(hex);
  let alpha = 1;
  for (const mod of Array.from(node.children)) {
    const v = num(mod.getAttribute("val")) / 100000;
    switch (mod.localName) {
      case "alpha":
        alpha = v;
        break;
      case "lumMod":
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, s, clamp01(mod.localName === "lumMod" ? l * v : l + v));
        break;
      }
      case "tint":
        [r, g, b] = [r, g, b].map((x) => x + (1 - x) * (1 - v));
        break;
      case "shade":
        [r, g, b] = [r, g, b].map((x) => x * v);
        break;
      case "satMod": {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, clamp01(s * v), l);
        break;
      }
      case "gray": {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        [r, g, b] = [y, y, y];
        break;
      }
      case "inv":
        [r, g, b] = [1 - r, 1 - g, 1 - b];
        break;
    }
  }
  return { hex: hexOf(r, g, b), alpha };
}

/** Word's own theme colour adjustments (w:color themeTint/themeShade), done on luminance. */
export function wordThemeColor(hex: string, tint?: string | null, shade?: string | null): string {
  let [r, g, b] = rgbOf(hex);
  if (shade) {
    const s = parseInt(shade, 16) / 255;
    const [h, sat, l] = rgbToHsl(r, g, b);
    [r, g, b] = hslToRgb(h, sat, l * s);
  } else if (tint) {
    const t = parseInt(tint, 16) / 255;
    const [h, sat, l] = rgbToHsl(r, g, b);
    [r, g, b] = hslToRgb(h, sat, l * t + (1 - t));
  }
  return hexOf(r, g, b);
}
