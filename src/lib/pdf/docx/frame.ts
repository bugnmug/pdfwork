/**
 * A hidden same-origin iframe where the browser lays the document out, with
 * our own fonts registered so the widths it measures are the widths we draw.
 */
import { fontBytes } from "../fonts";
import { FACE_STYLES, cssFamily, type Face } from "./fonts";
import { pt } from "./units";

const CSS = `
html,body{margin:0;padding:0;background:#fff}
body{font-kerning:none;font-variant-ligatures:none;font-feature-settings:"liga" 0,"clig" 0,"calt" 0;font-synthesis:weight style;text-rendering:geometricPrecision;-webkit-text-size-adjust:none;text-size-adjust:none;color:#000}
.root{position:absolute;left:0;display:flow-root}
div.p{margin:0;padding:0;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;tab-size:4}
.flow{display:flow-root}
.tb{display:inline-block;width:0;height:0;vertical-align:baseline}
.bm,.a{display:inline-block;width:0;height:0}
table.t{border-collapse:collapse;border-spacing:0}
td.c{box-sizing:border-box;word-wrap:break-word}
`;

export class Frame {
  iframe!: HTMLIFrameElement;
  doc!: Document;
  win!: Window & typeof globalThis;
  private nextY = 0;
  private loaded = new Set<string>();

  static async create(): Promise<Frame> {
    const f = new Frame();
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.cssText = "position:fixed;left:-40000px;top:0;width:3000px;height:2000px;border:0;visibility:hidden;pointer-events:none";
    document.body.appendChild(iframe);
    f.iframe = iframe;
    f.win = iframe.contentWindow as Window & typeof globalThis;
    f.doc = iframe.contentDocument!;
    f.doc.open();
    f.doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body></body></html>`);
    f.doc.close();
    return f;
  }

  /** Register the faces the document needs ("carlito/b" ...), plus each family's regular face. */
  async loadFaces(keys: Iterable<string>) {
    const wanted = new Set<string>();
    for (const k of keys) {
      const [face, style] = k.split("/") as [Face, "r" | "b" | "i" | "bi"];
      if (!FACE_STYLES[face]) continue;
      wanted.add(`${face}/r`);
      if (FACE_STYLES[face].includes(style)) wanted.add(`${face}/${style}`);
    }
    const FontFaceCtor = this.win.FontFace;
    await Promise.all(
      [...wanted].filter((k) => !this.loaded.has(k)).map(async (k) => {
        const [face, style] = k.split("/") as [Face, string];
        const bytes = await fontBytes(k);
        const ff = new FontFaceCtor(cssFamily(face), bytes.slice().buffer, { weight: style.includes("b") ? "700" : "400", style: style.includes("i") ? "italic" : "normal" });
        await ff.load();
        this.doc.fonts.add(ff);
        this.loaded.add(k);
      }),
    );
    await this.doc.fonts.ready;
  }

  /** Lay out a block of HTML at a width (points); returns its root element. */
  add(html: string, widthPt: number, cls = "root"): HTMLElement {
    const el = this.doc.createElement("div");
    el.className = cls;
    el.style.width = pt(widthPt);
    el.style.top = `${this.nextY}px`;
    el.innerHTML = html;
    this.doc.body.appendChild(el);
    this.nextY += Math.ceil(el.getBoundingClientRect().height) + 200;
    return el;
  }

  /** Move later containers down if this one grew (tabs widened, fields changed). */
  restack() {
    let y = 0;
    for (const el of Array.from(this.doc.body.children) as HTMLElement[]) {
      el.style.top = `${y}px`;
      y += Math.ceil(el.getBoundingClientRect().height) + 200;
    }
    this.nextY = y;
  }

  destroy() {
    this.iframe.remove();
  }
}
