/** EPUB → PDF: chapters in spine order, images, cover, bookmarks. */
import JSZip from "jszip";
import { paperSize, pdfOut, stem, type OutFile, type ProgressFn } from "./core";
import { renderHtml } from "./layout";

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp" };

function resolve(from: string, target: string) {
  const clean = decodeURIComponent(target.split("#")[0]);
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function epubToPdf(bytes: Uint8Array, name: string, o: { paper?: string; size?: number } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("This does not look like an EPUB file.");
  }
  if (zip.file("META-INF/encryption.xml")) {
    const enc = await zip.file("META-INF/encryption.xml")!.async("string");
    if (/EncryptedData/.test(enc) && !/fonts?\//i.test(enc)) throw new Error("This EPUB is DRM-protected, so its text cannot be read.");
  }
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1] ?? Object.keys(zip.files).find((f) => f.endsWith(".opf"));
  if (!opfPath) throw new Error("This EPUB has no package file. It may be damaged.");
  const opf = new DOMParser().parseFromString(await zip.file(opfPath)!.async("string"), "application/xml");
  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const it of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(it.getAttribute("id") || "", { href: resolve(opfPath, it.getAttribute("href") || ""), type: it.getAttribute("media-type") || "", props: it.getAttribute("properties") || "" });
  }
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"))
    .filter((r) => r.getAttribute("linear") !== "no")
    .map((r) => manifest.get(r.getAttribute("idref") || ""))
    .filter((m): m is NonNullable<typeof m> => !!m && /html|xml/.test(m.type));
  const title = opf.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || stem(name);
  const author = opf.getElementsByTagNameNS("*", "creator")[0]?.textContent?.trim() || "";
  const coverId = Array.from(opf.getElementsByTagNameNS("*", "meta")).find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
  const cover = [...manifest.values()].find((m) => m.props.includes("cover-image")) ?? (coverId ? manifest.get(coverId) : undefined);

  let html = "";
  if (cover && /image/.test(cover.type)) html += `<div style="text-align:center"><img src="${encodeURI(cover.href)}" alt="Cover"></div><div style="page-break-before:always"></div>`;
  html += `<h1 style="text-align:center">${escape(title)}</h1>${author ? `<p style="text-align:center">${escape(author)}</p>` : ""}`;
  for (let i = 0; i < spine.length; i++) {
    onProgress?.((i / spine.length) * 0.3, `Reading chapter ${i + 1}`);
    const file = zip.file(spine[i].href);
    if (!file) continue;
    const raw = await file.async("string");
    const doc = new DOMParser().parseFromString(raw, /xhtml|xml/.test(spine[i].type) ? "application/xhtml+xml" : "text/html");
    const body = doc.getElementsByTagName("body")[0] ?? doc.documentElement;
    if (!body) continue;
    // Skip a cover page we already printed.
    if (cover && body.querySelectorAll("img, image").length === 1 && (body.textContent ?? "").trim().length < 20) continue;
    for (const img of Array.from(body.querySelectorAll("img"))) {
      const src = img.getAttribute("src");
      if (src && !/^data:/.test(src)) img.setAttribute("src", encodeURI(resolve(spine[i].href, src)));
    }
    for (const img of Array.from(body.getElementsByTagNameNS("*", "image"))) {
      const href = img.getAttribute("xlink:href") || img.getAttributeNS("http://www.w3.org/1999/xlink", "href") || img.getAttribute("href");
      if (href) {
        const el = doc.createElement("img");
        el.setAttribute("src", encodeURI(resolve(spine[i].href, href)));
        img.closest("svg")?.replaceWith(el);
      }
    }
    html += `<div style="page-break-before:always"></div>${new XMLSerializer().serializeToString(body).replace(/^<body[^>]*>|<\/body>$/g, "")}`;
  }
  if (!spine.length) throw new Error("This EPUB has no readable chapters.");
  const pdf = await renderHtml(html, {
    pageSize: paperSize(o.paper ?? "A5"),
    margin: { top: 54, right: 48, bottom: 58, left: 48 },
    family: "serif",
    baseSize: o.size ?? 10.5,
    lineHeight: 1.45,
    pageNumbers: true,
    title,
    author,
    resolveImage: async (src) => {
      const p = decodeURI(src);
      const f = zip.file(p);
      if (!f) return null;
      const ext = p.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "svg") return null;
      return { bytes: await f.async("uint8array"), mime: MIME[ext] ?? "image/jpeg" };
    },
    onProgress: (f, l) => onProgress?.(0.3 + f * 0.7, l),
  });
  return pdfOut(`${stem(name)}.pdf`, pdf, `${spine.length} chapter${spine.length === 1 ? "" : "s"}`);
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
