/**
 * A small .pptx writer for slides rebuilt from PDF pages: a background (a picture of the page
 * without its text, or a plain colour), editable text boxes with styled runs, bullets, line
 * spacing and rotation, pictures, links and speaker notes. Sizes are in points.
 */
import { zipSync, strToU8 } from "fflate";

const EMU = 12700;
const emu = (pt: number) => Math.round(pt * EMU);

export type PRun = {
  text: string;
  /** Points. */
  size: number;
  face?: string;
  bold?: boolean;
  italic?: boolean;
  /** RRGGBB. */
  color?: string;
  /** Extra space after each character, points (letter-spaced labels). */
  spc?: number;
  /** Raised (superscript) or lowered, percent of the line. */
  baseline?: number;
  underline?: boolean;
  strike?: boolean;
  /** Web address the text links to. */
  link?: string;
  /** Starts a new line inside the paragraph (a line break the author set). */
  br?: boolean;
};

export type PBullet = {
  /** The bullet character, or a numbering scheme (arabicPeriod, alphaLcParenR, romanUcPeriod, ...). */
  char?: string;
  auto?: string;
  startAt?: number;
  face?: string;
  color?: string;
  /** Size of the bullet against the text, percent. */
  sizePct?: number;
};

export type PPara = {
  runs: PRun[];
  align?: "l" | "ctr" | "r" | "just";
  /** Line spacing: a multiple of the single line (1.2 times the size), or exact points. */
  spacing?: { pct: number } | { pts: number };
  /** Space above the paragraph, points. */
  before?: number;
  /** Indent of the text from the box's left edge, and of the first line from that (negative: hangs out), points. */
  marL?: number;
  indent?: number;
  bullet?: PBullet;
  /** Size of the paragraph mark (an empty paragraph keeps its height), points. */
  endSize?: number;
};

export type PText = {
  kind: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise degrees, about the box's centre. */
  rot?: number;
  /** Wrap lines at the box's width (false: each line runs as long as its text). */
  wrap: boolean;
  anchor?: "t" | "ctr" | "b";
  paras: PPara[];
  name?: string;
};

/** A picture: where it shows, and (`crop`) the share of the image cut off each side. */
export type PPic = { kind: "pic"; x: number; y: number; w: number; h: number; media: number; name?: string; crop?: { l: number; t: number; r: number; b: number } };

export type PSlide = {
  /** A plain colour (RRGGBB) or a picture (index into media) behind everything, filling the slide. */
  background?: { color: string } | { media: number };
  items: (PText | PPic)[];
  notes?: string;
};

export type PMedia = { bytes: Uint8Array; ext: "png" | "jpeg" };

export type PDeck = {
  /** Slide size, points. */
  width: number;
  height: number;
  slides: PSlide[];
  media: PMedia[];
  title?: string;
  /** Theme fonts: headings and body (what new text on these slides starts in). */
  fonts?: { major: string; minor: string };
};

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument";

const xml = (s: string) =>
  s
    // Characters XML can't hold: controls, non-characters and (read by code point) unpaired surrogates.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/[\uD800-\uDFFF]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const hex = (c?: string) => (c && /^#?[0-9a-f]{6}$/i.test(c) ? c.replace("#", "").toUpperCase() : undefined);
const fill = (c?: string) => (hex(c) ? `<a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill>` : "");
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const LVL = (n: number, extra = "") => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">${extra}<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;

/** Run properties: size, weight, colour, face, letter-spacing, raised text, link. */
function rPr(r: PRun, tag: "a:rPr" | "a:endParaRPr", link?: string): string {
  const size = Math.round(Math.min(4000, Math.max(1, r.size)) * 100);
  let a = ` sz="${size}"`;
  if (r.bold) a += ' b="1"';
  if (r.italic) a += ' i="1"';
  if (r.underline) a += ' u="sng"';
  if (r.strike) a += ' strike="sngStrike"';
  if (r.spc) a += ` spc="${Math.round(Math.max(-400, Math.min(1584, r.spc)) * 100)}"`;
  if (r.baseline) a += ` baseline="${Math.round(r.baseline * 1000)}"`;
  a += ' dirty="0"';
  const face = r.face ? xml(r.face) : "";
  // A link keeps the text's own colour (PowerPoint would use the theme's link colour otherwise).
  const click = link
    ? hex(r.color)
      ? `<a:hlinkClick r:id="${link}"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"><ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/></a:ext></a:extLst></a:hlinkClick>`
      : `<a:hlinkClick r:id="${link}"/>`
    : "";
  const kids = fill(r.color) + (face ? `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>` : "") + click;
  return kids ? `<${tag}${a}>${kids}</${tag}>` : `<${tag}${a}/>`;
}

function pPr(p: PPara): string {
  let a = ` marL="${emu(Math.max(0, p.marL ?? 0))}" indent="${emu(p.indent ?? 0)}"`;
  if (p.align && p.align !== "l") a += ` algn="${p.align}"`;
  let k = "";
  const sp = p.spacing;
  if (sp && "pct" in sp) k += `<a:lnSpc><a:spcPct val="${Math.round(Math.max(0.1, Math.min(13, sp.pct)) * 100000)}"/></a:lnSpc>`;
  else if (sp) k += `<a:lnSpc><a:spcPts val="${Math.round(Math.max(0, Math.min(1584, sp.pts)) * 100)}"/></a:lnSpc>`;
  k += `<a:spcBef><a:spcPts val="${Math.round(Math.max(0, Math.min(1584, p.before ?? 0)) * 100)}"/></a:spcBef>`;
  const b = p.bullet;
  if (b && (b.char || b.auto)) {
    if (hex(b.color)) k += `<a:buClr><a:srgbClr val="${hex(b.color)}"/></a:buClr>`;
    k += `<a:buSzPct val="${Math.round(Math.max(25, Math.min(400, b.sizePct ?? 100)) * 1000)}"/>`;
    if (b.face) k += `<a:buFont typeface="${xml(b.face)}"/>`;
    k += b.auto ? `<a:buAutoNum type="${b.auto}"${b.startAt && b.startAt > 1 ? ` startAt="${Math.min(32767, b.startAt)}"` : ""}/>` : `<a:buChar char="${xml(b.char!)}"/>`;
  } else k += "<a:buNone/>";
  return `<a:pPr${a}>${k}</a:pPr>`;
}

/** Writes a deck; returns the .pptx bytes. */
export function writePptx(deck: PDeck): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, s: string) => (files[path] = strToU8(s));
  const W = Math.min(51206400, Math.max(914400, emu(deck.width)));
  const H = Math.min(51206400, Math.max(914400, emu(deck.height)));
  const n = deck.slides.length;
  const notes = deck.slides.map((s) => !!s.notes?.trim());
  const anyNotes = notes.some(Boolean);
  const exts = new Set(deck.media.map((m) => m.ext));
  deck.media.forEach((m, i) => (files[`ppt/media/image${i + 1}.${m.ext}`] = m.bytes));

  deck.slides.forEach((s, si) => {
    const rels: string[] = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    const relOf = new Map<string, string>();
    const rel = (type: string, target: string, external = false) => {
      const key = `${type} ${target}`;
      let id = relOf.get(key);
      if (!id) {
        id = `rId${rels.length + 1}`;
        relOf.set(key, id);
        rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ""}/>`);
      }
      return id;
    };
    const image = (m: number) => rel("image", `../media/image${m + 1}.${deck.media[m].ext}`);
    let bg = "";
    if (s.background && "media" in s.background) bg = `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${image(s.background.media)}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    else if (s.background && hex(s.background.color)) bg = `<p:bg><p:bgPr>${fill(s.background.color)}<a:effectLst/></p:bgPr></p:bg>`;
    let id = 2;
    const shapes = s.items.map((it) => {
      const sid = id++;
      const rot = it.kind === "text" && it.rot ? ` rot="${Math.round((((it.rot % 360) + 360) % 360) * 60000)}"` : "";
      const xfrm = `<a:xfrm${rot}><a:off x="${emu(it.x)}" y="${emu(it.y)}"/><a:ext cx="${Math.max(1, emu(it.w))}" cy="${Math.max(1, emu(it.h))}"/></a:xfrm>`;
      if (it.kind === "pic") {
        const c = it.crop;
        const pc = (v: number) => Math.round(Math.max(0, Math.min(0.99, v)) * 100000);
        const src = c ? `<a:srcRect l="${pc(c.l)}" t="${pc(c.t)}" r="${pc(c.r)}" b="${pc(c.b)}"/>` : "";
        return `<p:pic><p:nvPicPr><p:cNvPr id="${sid}" name="${xml(it.name ?? `Picture ${sid - 1}`)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${image(it.media)}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
      }
      const paras = it.paras
        .map((p) => {
          const runs = p.runs
            .map((r) => {
              const link = r.link && /^(https?:|mailto:)/i.test(r.link) ? rel("hyperlink", r.link, true) : undefined;
              const t = r.text ? `<a:r>${rPr(r, "a:rPr", link)}<a:t>${xml(r.text)}</a:t></a:r>` : "";
              return (r.br ? `<a:br>${rPr({ ...r, text: "" }, "a:rPr")}</a:br>` : "") + t;
            })
            .join("");
          const last = p.runs[p.runs.length - 1];
          return `<a:p>${pPr(p)}${runs}${rPr({ text: "", size: p.endSize ?? last?.size ?? 18, face: last?.face, color: last?.color }, "a:endParaRPr")}</a:p>`;
        })
        .join("");
      const body = `<a:bodyPr wrap="${it.wrap ? "square" : "none"}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${it.anchor ?? "t"}"/>`;
      return `<p:sp><p:nvSpPr><p:cNvPr id="${sid}" name="${xml(it.name ?? `TextBox ${sid - 1}`)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody>${body}<a:lstStyle/>${paras || "<a:p><a:endParaRPr dirty=\"0\"/></a:p>"}</p:txBody></p:sp>`;
    });
    if (notes[si]) rels.push(`<Relationship Id="rId${rels.length + 1}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${si + 1}.xml"/>`);
    put(`ppt/slides/slide${si + 1}.xml`, `${HEAD}<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GROUP}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    put(`ppt/slides/_rels/slide${si + 1}.xml.rels`, `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
    if (notes[si]) {
      const paras = s
        .notes!.split(/\r?\n/)
        .map((l) => (l ? `<a:p><a:r><a:rPr dirty="0"/><a:t>${xml(l)}</a:t></a:r></a:p>` : "<a:p><a:endParaRPr dirty=\"0\"/></a:p>"))
        .join("");
      put(
        `ppt/notesSlides/notesSlide${si + 1}.xml`,
        `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}` +
          '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
          `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>` +
          "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
      );
      put(
        `ppt/notesSlides/_rels/notesSlide${si + 1}.xml.rels`,
        `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${si + 1}.xml"/></Relationships>`,
      );
    }
  });

  // Presentation: master, slides, then the shared parts.
  const pres: string[] = [`<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  for (let i = 0; i < n; i++) pres.push(`<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`);
  const rid = (k: number) => `rId${n + 2 + k}`;
  pres.push(
    `<Relationship Id="${rid(0)}" Type="${REL}/theme" Target="theme/theme1.xml"/>`,
    `<Relationship Id="${rid(1)}" Type="${REL}/presProps" Target="presProps.xml"/>`,
    `<Relationship Id="${rid(2)}" Type="${REL}/viewProps" Target="viewProps.xml"/>`,
    `<Relationship Id="${rid(3)}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>`,
  );
  if (anyNotes) pres.push(`<Relationship Id="${rid(4)}" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
  put(
    "ppt/presentation.xml",
    `${HEAD}<p:presentation ${NS} saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      (anyNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${rid(4)}"/></p:notesMasterIdLst>` : "") +
      `<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => LVL(l)).join("")}</p:defaultTextStyle>` +
      "</p:presentation>",
  );
  put("ppt/_rels/presentation.xml.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pres.join("")}</Relationships>`);
  put("ppt/presProps.xml", `${HEAD}<p:presentationPr ${NS}/>`);
  put("ppt/viewProps.xml", `${HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put("ppt/tableStyles.xml", `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  const theme = themeXml(deck.fonts);
  put("ppt/theme/theme1.xml", theme);
  put(
    "ppt/slideMasters/slideMaster1.xml",
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>` +
      `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
      `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${LVL(1)}</p:otherStyle></p:txStyles></p:sldMaster>`,
  );
  put("ppt/slideMasters/_rels/slideMaster1.xml.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`);
  put("ppt/slideLayouts/slideLayout1.xml", `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  if (anyNotes) {
    put("ppt/theme/theme2.xml", theme);
    put(
      "ppt/notesMasters/notesMaster1.xml",
      `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}` +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>' +
        `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/>` +
        '<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>',
    );
    put("ppt/notesMasters/_rels/notesMaster1.xml.rels", `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/></Relationships>`);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put(
    "docProps/core.xml",
    `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      (deck.title ? `<dc:title>${xml(deck.title)}</dc:title>` : "") +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  put("docProps/app.xml", `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DoYourPDF</Application><PresentationFormat>Custom</PresentationFormat><Slides>${n}</Slides><Notes>${notes.filter(Boolean).length}</Notes></Properties>`);
  put(
    "_rels/.rels",
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
      "</Relationships>",
  );
  const over = (part: string, type: string) => `<Override PartName="/${part}" ContentType="${type}"/>`;
  put(
    "[Content_Types].xml",
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      (exts.has("jpeg") ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : "") +
      (exts.has("png") ? '<Default Extension="png" ContentType="image/png"/>' : "") +
      over("ppt/presentation.xml", `${CT}.presentationml.presentation.main+xml`) +
      over("ppt/slideMasters/slideMaster1.xml", `${CT}.presentationml.slideMaster+xml`) +
      over("ppt/slideLayouts/slideLayout1.xml", `${CT}.presentationml.slideLayout+xml`) +
      deck.slides.map((_, i) => over(`ppt/slides/slide${i + 1}.xml`, `${CT}.presentationml.slide+xml`)).join("") +
      deck.slides.map((_, i) => (notes[i] ? over(`ppt/notesSlides/notesSlide${i + 1}.xml`, `${CT}.presentationml.notesSlide+xml`) : "")).join("") +
      (anyNotes ? over("ppt/notesMasters/notesMaster1.xml", `${CT}.presentationml.notesMaster+xml`) + over("ppt/theme/theme2.xml", `${CT}.theme+xml`) : "") +
      over("ppt/theme/theme1.xml", `${CT}.theme+xml`) +
      over("ppt/presProps.xml", `${CT}.presentationml.presProps+xml`) +
      over("ppt/viewProps.xml", `${CT}.presentationml.viewProps+xml`) +
      over("ppt/tableStyles.xml", `${CT}.presentationml.tableStyles+xml`) +
      over("docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml") +
      over("docProps/app.xml", `${CT}.extended-properties+xml`) +
      "</Types>",
  );
  // [Content_Types].xml first, as Office expects; pictures are already compressed.
  const ordered: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { "[Content_Types].xml": files["[Content_Types].xml"] };
  for (const [k, v] of Object.entries(files)) if (k !== "[Content_Types].xml") ordered[k] = k.startsWith("ppt/media/") ? [v, { level: 0 }] : v;
  return zipSync(ordered, { level: 6 });
}

/** The Office theme, with the deck's own faces as its heading and body fonts. */
function themeXml(fonts?: { major: string; minor: string }): string {
  const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const face = (f: string) => `<a:latin typeface="${xml(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return (
    `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>` +
    '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    `<a:fontScheme name="Office"><a:majorFont>${face(fonts?.major || "Calibri Light")}</a:majorFont><a:minorFont>${face(fonts?.minor || "Calibri")}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Office"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>` +
    "</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
  );
}
