/**
 * Peer-to-peer plumbing for P2P Share and the whiteboard. A PeerJS broker
 * introduces the two browsers; data then flows over a WebRTC data channel
 * (DTLS-encrypted). Files can additionally be end-to-end encrypted with a
 * password (PBKDF2 → AES-256-GCM) before they leave the device.
 *
 * Self-hosting the broker: set VITE_PEER_HOST (and optionally VITE_PEER_PORT,
 * VITE_PEER_PATH, VITE_PEER_SECURE=false) at build time.
 */
import type { DataConnection, Peer as PeerT, PeerOptions } from "peerjs";

export const NAMESPACE = "spitepdf-v1-";
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function makeCode(len = 6): string {
  const r = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(r, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function cleanCode(s: string): string {
  return s
    .toLowerCase()
    .replace(/^.*#/, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
}

function peerOptions(): PeerOptions {
  const env = import.meta.env as Record<string, string | undefined>;
  const o: PeerOptions = { debug: 0 };
  if (env.VITE_PEER_HOST) {
    o.host = env.VITE_PEER_HOST;
    if (env.VITE_PEER_PORT) o.port = Number(env.VITE_PEER_PORT);
    o.path = env.VITE_PEER_PATH || "/";
    o.secure = env.VITE_PEER_SECURE ? env.VITE_PEER_SECURE !== "false" : location.protocol === "https:";
  }
  return o;
}

/** Open a peer with the given id (retrying with a new code if it's taken). */
export async function openPeer(code?: string): Promise<{ peer: PeerT; code: string }> {
  const { Peer } = await import("peerjs");
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = code ?? makeCode();
    const peer = new Peer(code === undefined || attempt === 0 ? NAMESPACE + c : NAMESPACE + makeCode(), peerOptions());
    const result = await new Promise<"ok" | "taken" | Error>((resolve) => {
      peer.once("open", () => resolve("ok"));
      peer.once("error", (e: Error & { type?: string }) => resolve(e.type === "unavailable-id" ? "taken" : e));
    });
    if (result === "ok") return { peer, code: peer.id.slice(NAMESPACE.length) };
    peer.destroy();
    if (result !== "taken") throw friendly(result);
  }
  throw new Error("Couldn't get a free share code. Try again.");
}

/** An anonymous peer for the receiving side. */
export async function openGuest(): Promise<PeerT> {
  const { Peer } = await import("peerjs");
  const peer = new Peer(peerOptions());
  await new Promise<void>((resolve, reject) => {
    peer.once("open", () => resolve());
    peer.once("error", (e) => reject(friendly(e)));
  });
  return peer;
}

export function connect(peer: PeerT, code: string): Promise<DataConnection> {
  return new Promise((resolve, reject) => {
    const conn = peer.connect(NAMESPACE + code, { reliable: true, serialization: "raw" });
    const timer = setTimeout(() => reject(new Error("The other device didn't answer. Check the code and that the sharing page is still open there.")), 20000);
    conn.once("open", () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once("error", (e) => {
      clearTimeout(timer);
      reject(friendly(e));
    });
    peer.once("error", (e: Error & { type?: string }) => {
      clearTimeout(timer);
      reject(e.type === "peer-unavailable" ? new Error("No one is sharing with that code right now. Check it, or ask for a new one.") : friendly(e));
    });
  });
}

export function friendly(e: unknown): Error {
  const err = e as Error & { type?: string };
  switch (err?.type) {
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return new Error("Couldn't reach the connection service. Check your internet connection and try again.");
    case "browser-incompatible":
      return new Error("This browser doesn't support direct connections (WebRTC).");
    case "peer-unavailable":
      return new Error("No one is sharing with that code right now.");
    default:
      return err instanceof Error ? err : new Error(String(e));
  }
}

/** Wait until the data channel has room, so large files don't pile up in memory. */
export async function drain(conn: DataConnection, max = 2 * 1024 * 1024) {
  const dc = (conn as unknown as { dataChannel?: RTCDataChannel }).dataChannel;
  const buffered = () => (dc?.bufferedAmount ?? 0) + ((conn as unknown as { bufferSize?: number }).bufferSize ?? 0) * 65536;
  while (conn.open && buffered() > max) await new Promise((r) => setTimeout(r, 15));
}

/* ------------------------------------------------------ password crypto */

const enc = new TextEncoder();

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: 200_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out.buffer;
}

export async function open(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  const u = new Uint8Array(data);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, key, u.subarray(12));
}

export const b64 = (u: Uint8Array | ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(u)));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const CHECK = "spitepdf-password-check";
