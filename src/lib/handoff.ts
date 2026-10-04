/**
 * Moves files between tools without touching the network: "Continue with…",
 * the home page drop zone, and links like Privacy scanner → Auto-redact all
 * park files here, then the next tool picks them up on mount.
 */
import type { OutFile } from "@/lib/pdf/core";

let parked: { files: File[]; from?: string } | null = null;

export function park(files: File[], from?: string) {
  parked = { files, from };
}

export function take(): { files: File[]; from?: string } | null {
  const p = parked;
  parked = null;
  return p;
}

export function peek(): number {
  return parked?.files.length ?? 0;
}

export function outToFile(o: OutFile): File {
  const copy = new Uint8Array(o.bytes.byteLength);
  copy.set(o.bytes);
  return new File([copy], o.filename, { type: o.mime });
}
