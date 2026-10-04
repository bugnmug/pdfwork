/** Passwords, permissions, metadata scrubbing, hashes. */
import { PDFDict, PDFName, PDFArray, PDFRef } from "@cantoo/pdf-lib";
import { BRAND } from "@/lib/brand";
import { appendPages, loadPdf, newDoc, pdfOut, saveDoc, stem, PasswordError, type OutFile, type PDFDocument } from "./core";
import { open, type Src } from "./pages";

export type EncryptOpts = {
  userPassword: string;
  ownerPassword?: string;
  printing?: "none" | "low" | "high";
  copying?: boolean;
  modifying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  assembly?: boolean;
};

export async function encryptPdf(src: Src, o: EncryptOpts): Promise<OutFile> {
  if (!o.userPassword) throw new Error("Choose a password that will be needed to open the PDF.");
  if (o.userPassword.length < 4) throw new Error("Use a password of at least 4 characters.");
  const doc = await open(src);
  const owner = o.ownerPassword || (await randomPassword());
  doc.encrypt({
    userPassword: o.userPassword,
    ownerPassword: owner,
    algorithm: "AES-256",
    permissions: {
      printing: o.printing === "none" ? false : o.printing === "low" ? "lowResolution" : "highResolution",
      copying: !!o.copying,
      modifying: !!o.modifying,
      annotating: !!o.annotating,
      fillingForms: o.fillingForms ?? true,
      contentAccessibility: true,
      documentAssembly: !!o.assembly,
    },
  } as Parameters<PDFDocument["encrypt"]>[0]);
  const note = o.ownerPassword ? "AES-256 · owner password set" : "AES-256 · permissions locked with a random owner password";
  return pdfOut(`${stem(src.name)}-protected.pdf`, await saveDoc(doc, { objectStreams: false }), note);
}

async function randomPassword() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b));
}

/** Remove the open password (requires knowing it) and all permission restrictions. */
export async function decryptPdf(src: Src, password: string): Promise<OutFile> {
  const probe = await loadPdf(src.bytes, { password, name: src.name }).catch((e) => {
    if (e instanceof PasswordError && !password) throw new PasswordError(src.name, false);
    throw e;
  });
  const out = await rebuild(probe);
  return pdfOut(`${stem(src.name)}-unlocked.pdf`, await saveDoc(out), "Password and restrictions removed");
}

/** Copy into a fresh document, carrying over metadata, outline-free. */
async function rebuild(doc: PDFDocument): Promise<PDFDocument> {
  const out = await newDoc();
  await appendPages(out, doc);
  const t = doc.getTitle();
  if (t) out.setTitle(t);
  const a = doc.getAuthor();
  if (a) out.setAuthor(a);
  const s = doc.getSubject();
  if (s) out.setSubject(s);
  return out;
}

export type SanitizeOpts = {
  metadata?: boolean;
  javascript?: boolean;
  attachments?: boolean;
  links?: boolean;
  annotations?: boolean;
  forms?: boolean;
};

/** Strip hidden data: document info, XMP, JavaScript, embedded files, links, comments. */
export async function sanitizePdf(src: Src, o: SanitizeOpts): Promise<OutFile> {
  const doc = await open(src);
  const removed: string[] = [];
  const cat = doc.catalog;
  if (o.metadata !== false) {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) {
      for (const k of info.keys()) info.delete(k);
    }
    cat.delete(PDFName.of("Metadata"));
    cat.delete(PDFName.of("PieceInfo"));
    for (const p of doc.getPages()) {
      p.node.delete(PDFName.of("Metadata"));
      p.node.delete(PDFName.of("PieceInfo"));
      p.node.delete(PDFName.of("Thumb"));
    }
    doc.setProducer("");
    doc.setCreator("");
    removed.push("metadata");
  }
  const names = cat.lookupMaybe(PDFName.of("Names"), PDFDict);
  if (o.javascript !== false) {
    names?.delete(PDFName.of("JavaScript"));
    cat.delete(PDFName.of("OpenAction"));
    cat.delete(PDFName.of("AA"));
    for (const p of doc.getPages()) p.node.delete(PDFName.of("AA"));
    removed.push("scripts");
  }
  if (o.attachments !== false) {
    names?.delete(PDFName.of("EmbeddedFiles"));
    cat.delete(PDFName.of("AF"));
    removed.push("attachments");
  }
  if (o.links || o.annotations || o.javascript !== false) {
    for (const p of doc.getPages()) {
      const annots = p.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) continue;
      const keep: (PDFRef | PDFDict)[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const a = doc.context.lookup(ref);
        if (!(a instanceof PDFDict)) continue;
        const sub = a.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
        if (o.javascript !== false) {
          a.delete(PDFName.of("AA"));
          const act = a.lookupMaybe(PDFName.of("A"), PDFDict);
          if (act?.lookupMaybe(PDFName.of("S"), PDFName)?.asString() === "/JavaScript") a.delete(PDFName.of("A"));
        }
        if (sub === "/Link" && o.links) continue;
        if (o.annotations && sub !== "/Link" && sub !== "/Widget") continue;
        keep.push(ref as PDFRef);
      }
      p.node.set(PDFName.of("Annots"), doc.context.obj(keep));
    }
    if (o.links) removed.push("links");
    if (o.annotations) removed.push("comments");
  }
  if (o.forms) {
    try {
      doc.getForm().flatten();
      removed.push("form fields (flattened)");
    } catch {
      /* no form */
    }
  }
  const bytes = await saveDoc(doc);
  return pdfOut(`${stem(src.name)}-clean.pdf`, bytes, `Removed: ${removed.join(", ")}`);
}

export async function toPdfA(src: Src, level: "1B" | "2B" | "3B" = "2B"): Promise<OutFile> {
  const doc = await open(src);
  try {
    (doc as unknown as { convertToPDFA(o: { conformance: string }): void }).convertToPDFA({ conformance: level });
  } catch (e) {
    throw new Error(`PDF/A conversion failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return pdfOut(`${stem(src.name)}-pdfa.pdf`, await saveDoc(doc, { objectStreams: level !== "1B" }), `PDF/A-${level} metadata and colour profile added`);
}

export type Fingerprint = {
  name: string;
  bytes: number;
  sha256: string;
  sha1: string;
  md5: string;
  pdf?: {
    version: string;
    pages: number;
    encrypted: boolean;
    title?: string;
    author?: string;
    producer?: string;
    creator?: string;
    created?: string;
    modified?: string;
    ids?: string[];
    javascript: boolean;
    attachments: number;
    forms: number;
  };
};

export async function fingerprint(bytes: Uint8Array, name: string): Promise<Fingerprint> {
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const buf = bytes.slice().buffer;
  const [s256, s1] = await Promise.all([crypto.subtle.digest("SHA-256", buf), crypto.subtle.digest("SHA-1", buf)]);
  const fp: Fingerprint = { name, bytes: bytes.byteLength, sha256: hex(s256), sha1: hex(s1), md5: md5Hex(bytes) };
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const ver = head.match(/%PDF-(\d\.\d)/)?.[1];
  if (ver) {
    try {
      const { PDFDocument: D } = await import("@cantoo/pdf-lib");
      const d = await D.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const idArr = d.context.lookup(d.context.trailerInfo.ID);
      const ids: string[] = [];
      if (idArr instanceof PDFArray) for (let i = 0; i < idArr.size(); i++) ids.push(String(idArr.get(i)).replace(/[<>]/g, ""));
      const names = d.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
      let forms = 0;
      try {
        forms = d.isEncrypted ? 0 : d.getForm().getFields().length;
      } catch {
        forms = 0;
      }
      let attachments = 0;
      try {
        attachments = d.isEncrypted ? 0 : d.getAttachments().length;
      } catch {
        attachments = 0;
      }
      const safe = <T,>(f: () => T) => {
        try {
          return d.isEncrypted ? undefined : f();
        } catch {
          return undefined;
        }
      };
      fp.pdf = {
        version: ver,
        pages: d.getPageCount(),
        encrypted: d.isEncrypted,
        title: safe(() => d.getTitle()),
        author: safe(() => d.getAuthor()),
        producer: safe(() => d.getProducer()),
        creator: safe(() => d.getCreator()),
        created: safe(() => d.getCreationDate()?.toISOString()),
        modified: safe(() => d.getModificationDate()?.toISOString()),
        ids,
        javascript: !!names?.has(PDFName.of("JavaScript")) || !!d.catalog.has(PDFName.of("OpenAction")),
        attachments,
        forms,
      };
    } catch {
      /* not parseable: hashes are still valid */
    }
  }
  return fp;
}

export function fingerprintReport(fp: Fingerprint): string {
  const lines = [
    `${BRAND.name} file fingerprint`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `File:     ${fp.name}`,
    `Size:     ${fp.bytes.toLocaleString()} bytes`,
    `SHA-256:  ${fp.sha256}`,
    `SHA-1:    ${fp.sha1}`,
    `MD5:      ${fp.md5}`,
  ];
  if (fp.pdf) {
    const p = fp.pdf;
    lines.push(
      "",
      `PDF version: ${p.version}`,
      `Pages:       ${p.pages}`,
      `Encrypted:   ${p.encrypted ? "yes" : "no"}`,
      ...(p.title ? [`Title:       ${p.title}`] : []),
      ...(p.author ? [`Author:      ${p.author}`] : []),
      ...(p.creator ? [`Creator:     ${p.creator}`] : []),
      ...(p.producer ? [`Producer:    ${p.producer}`] : []),
      ...(p.created ? [`Created:     ${p.created}`] : []),
      ...(p.modified ? [`Modified:    ${p.modified}`] : []),
      ...(p.ids?.length ? [`Document ID: ${p.ids.join(" / ")}`] : []),
      `JavaScript:  ${p.javascript ? "present" : "none"}`,
      `Attachments: ${p.attachments}`,
      `Form fields: ${p.forms}`,
    );
  }
  lines.push("", "Any change to the file, even one byte, produces a completely different SHA-256.");
  return lines.join("\n");
}

/* Compact MD5 (RFC 1321). Web Crypto has no MD5; it is offered only for legacy checksums. */
export function md5Hex(input: Uint8Array): string {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = input.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(input);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return [...out].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function readMetadata(src: Src) {
  const doc = await open(src);
  const kw = doc.getKeywords();
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: typeof kw === "string" ? kw : "",
    creator: doc.getCreator() ?? "",
    producer: doc.getProducer() ?? "",
    created: doc.getCreationDate()?.toISOString() ?? "",
    modified: doc.getModificationDate()?.toISOString() ?? "",
    pages: doc.getPageCount(),
  };
}

export async function setMetadata(src: Src, m: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string }): Promise<OutFile> {
  const doc = await open(src);
  doc.setTitle(m.title ?? "", { showInWindowTitleBar: !!m.title });
  doc.setAuthor(m.author ?? "");
  doc.setSubject(m.subject ?? "");
  doc.setKeywords((m.keywords ?? "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean));
  if (m.creator !== undefined) doc.setCreator(m.creator);
  doc.setModificationDate(new Date());
  return pdfOut(`${stem(src.name)}.pdf`, await saveDoc(doc), "Properties updated");
}

export type HiddenItem = { label: string; detail: string; risk: "high" | "medium" | "low"; fix: "sanitize" | "flatten" | null };

/** Things a PDF carries that you can't see on the page: author names, software, scripts, attachments, comments, form data. */
export async function inspectHidden(src: Src): Promise<HiddenItem[]> {
  const doc = await open(src);
  const out: HiddenItem[] = [];
  const info: [string, string | undefined][] = [
    ["Author", doc.getAuthor()],
    ["Title", doc.getTitle()],
    ["Subject", doc.getSubject()],
    ["Keywords", (() => {
      const k = doc.getKeywords();
      return typeof k === "string" ? k : undefined;
    })()],
    ["Created with", doc.getCreator()],
    ["Produced by", doc.getProducer()],
  ];
  const present = info.filter(([, v]) => v && v.trim());
  if (present.length) out.push({ label: "Document properties", detail: present.map(([k, v]) => `${k}: ${v}`).join(" · "), risk: present.some(([k]) => k === "Author") ? "medium" : "low", fix: "sanitize" });
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  if (created || modified) out.push({ label: "Dates", detail: [created ? `Created ${created.toLocaleString()}` : "", modified ? `Modified ${modified.toLocaleString()}` : ""].filter(Boolean).join(" · "), risk: "low", fix: "sanitize" });
  if (doc.catalog.has(PDFName.of("Metadata"))) out.push({ label: "XMP metadata", detail: "An embedded metadata packet that can repeat names, software and edit history.", risk: "low", fix: "sanitize" });
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const js = !!names?.has(PDFName.of("JavaScript")) || doc.catalog.has(PDFName.of("OpenAction")) || doc.catalog.has(PDFName.of("AA"));
  if (js) out.push({ label: "Scripts or automatic actions", detail: "Code or actions that run when the file is opened.", risk: "high", fix: "sanitize" });
  let attachments: { name: string }[] = [];
  try {
    attachments = doc.getAttachments() as { name: string }[];
  } catch {
    attachments = [];
  }
  if (attachments.length) out.push({ label: `Embedded file${attachments.length === 1 ? "" : "s"}`, detail: attachments.map((a) => a.name).slice(0, 6).join(", "), risk: "high", fix: "sanitize" });
  let fields = 0;
  let filled = 0;
  try {
    const form = doc.getForm();
    for (const f of form.getFields()) {
      fields++;
      const v = (f as unknown as { getText?: () => string | undefined }).getText?.();
      if (v) filled++;
    }
  } catch {
    /* no form */
  }
  if (fields) out.push({ label: "Form fields", detail: `${fields} field${fields === 1 ? "" : "s"}${filled ? `, ${filled} with typed answers that can be copied or changed` : ""}.`, risk: filled ? "medium" : "low", fix: "flatten" });
  const counts = new Map<string, number>();
  for (const p of doc.getPages()) {
    const annots = p.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = doc.context.lookup(annots.get(i));
      if (!(a instanceof PDFDict)) continue;
      const sub = a.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString().slice(1) ?? "Other";
      if (sub === "Widget") continue;
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
  }
  const links = counts.get("Link") ?? 0;
  counts.delete("Link");
  const comments = [...counts.values()].reduce((a, b) => a + b, 0);
  if (comments) out.push({ label: "Comments and markup", detail: [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", "), risk: "medium", fix: "sanitize" });
  if (links) out.push({ label: "Links", detail: `${links} clickable link${links === 1 ? "" : "s"}.`, risk: "low", fix: null });
  return out;
}
