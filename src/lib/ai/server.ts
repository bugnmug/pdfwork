/**
 * Optional server-side AI. Only used when the site owner sets an API key in
 * the hosting environment; otherwise the app uses the local engine. The PDF
 * itself never comes here: only text the user chose to send (a question plus
 * the relevant passages, or the text to summarise / read aloud).
 *
 * Environment (set one):
 *   ANTHROPIC_API_KEY            Claude
 *   OPENAI_API_KEY (+ OPENAI_BASE_URL for compatible providers)
 *   XAI_API_KEY                  Grok
 * Optional: AI_MODEL to choose a model, AI_DAILY_LIMIT (per IP, default 60).
 */
import { createServerFn } from "@tanstack/react-start";

type Provider = { kind: "anthropic" | "openai" | "xai"; key: string; model: string; base: string };

function provider(): Provider | null {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY) return { kind: "anthropic", key: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || "claude-haiku-4-5-20251001", base: "https://api.anthropic.com" };
  if (env.OPENAI_API_KEY) return { kind: "openai", key: env.OPENAI_API_KEY, model: env.AI_MODEL || "gpt-4.1-mini", base: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "") };
  if (env.XAI_API_KEY) return { kind: "xai", key: env.XAI_API_KEY, model: env.AI_MODEL || "grok-4.5", base: "https://api.x.ai/v1" };
  return null;
}

// Best-effort abuse guard. Serverless instances do not share memory, so this is per-instance.
const hits = new Map<string, { day: string; n: number }>();
function allow(ip: string): boolean {
  const limit = Number(process.env.AI_DAILY_LIMIT || 60);
  const day = new Date().toISOString().slice(0, 10);
  const cur = hits.get(ip);
  if (!cur || cur.day !== day) {
    hits.set(ip, { day, n: 1 });
    return true;
  }
  cur.n++;
  return cur.n <= limit;
}

async function clientIp(): Promise<string> {
  try {
    const mod = await import("@tanstack/react-start/server");
    const req = (mod as unknown as { getRequest?: () => Request }).getRequest?.();
    return req?.headers.get("x-forwarded-for")?.split(",")[0].trim() || req?.headers.get("x-real-ip") || "anon";
  } catch {
    return "anon";
  }
}

export const aiStatus = createServerFn({ method: "GET" }).handler(async () => {
  const p = provider();
  return { enabled: !!p, provider: p?.kind ?? null, speech: !!(process.env.OPENAI_API_KEY || process.env.XAI_API_KEY), transcribe: !!process.env.OPENAI_API_KEY };
});

async function complete(p: Provider, system: string, user: string, maxTokens: number): Promise<string> {
  if (p.kind === "anthropic") {
    const res = await fetch(`${p.base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`The AI service returned ${res.status}.`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  }
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`The AI service returned ${res.status}.`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content?.trim() ?? "";
}

type AskInput = { mode: "chat" | "summarize"; question?: string; passages: { page: number; text: string }[]; history?: { q: string; a: string }[]; title?: string };

export const aiAsk = createServerFn({ method: "POST" })
  .validator((d: AskInput) => {
    if (!d || !Array.isArray(d.passages)) throw new Error("Bad request");
    let budget = 60000;
    const passages = d.passages
      .map((p) => ({ page: Number(p.page) || 0, text: String(p.text ?? "") }))
      .filter((p) => {
        if (budget <= 0) return false;
        budget -= p.text.length;
        return true;
      });
    return {
      mode: d.mode === "summarize" ? ("summarize" as const) : ("chat" as const),
      question: String(d.question ?? "").slice(0, 2000),
      passages,
      history: (d.history ?? []).slice(-4).map((h) => ({ q: String(h.q).slice(0, 1000), a: String(h.a).slice(0, 2000) })),
      title: String(d.title ?? "").slice(0, 200),
    };
  })
  .handler(async ({ data }) => {
    const p = provider();
    if (!p) return { ok: false as const, error: "AI is not configured on this site." };
    if (!allow(await clientIp())) return { ok: false as const, error: "Daily AI limit reached. The local answers still work." };
    const ctx = data.passages.map((x) => `[p. ${x.page}] ${x.text}`).join("\n\n");
    try {
      if (data.mode === "summarize") {
        const text = await complete(
          p,
          "You summarise documents faithfully. Write a short overview paragraph, then 5-10 bullet points of the most important facts, decisions, numbers and dates, then a line listing any action items or deadlines. Use only the provided text. Cite pages like (p. 3). If the excerpt is partial, say so.",
          `Document: ${data.title || "Untitled"}\n\n${ctx}`,
          900,
        );
        return { ok: true as const, text };
      }
      const hist = data.history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n\n");
      const text = await complete(
        p,
        "You answer questions about a document using only the excerpts provided. Be direct and specific. Cite pages like (p. 4) for each claim. If the excerpts do not contain the answer, say you could not find it in the document; do not guess.",
        `${hist ? `Earlier in this conversation:\n${hist}\n\n` : ""}Excerpts from ${data.title || "the document"}:\n\n${ctx}\n\nQuestion: ${data.question}`,
        700,
      );
      return { ok: true as const, text };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "The AI request failed." };
    }
  });

export const aiSpeak = createServerFn({ method: "POST" })
  .validator((d: { text: string; voice?: string }) => ({ text: String(d?.text ?? "").slice(0, 3800), voice: String(d?.voice ?? "") }))
  .handler(async ({ data }) => {
    if (!data.text.trim()) return { ok: false as const, error: "Nothing to read." };
    if (!allow(await clientIp())) return { ok: false as const, error: "Daily limit reached." };
    try {
      if (process.env.OPENAI_API_KEY) {
        const res = await fetch(`${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/audio/speech`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: process.env.AI_TTS_MODEL || "gpt-4o-mini-tts", voice: data.voice || "alloy", input: data.text, response_format: "mp3" }),
        });
        if (!res.ok) return { ok: false as const, error: `Speech service returned ${res.status}.` };
        return { ok: true as const, base64: Buffer.from(await res.arrayBuffer()).toString("base64"), mime: "audio/mpeg" };
      }
      if (process.env.XAI_API_KEY) {
        const res = await fetch("https://api.x.ai/v1/tts", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.XAI_API_KEY}` },
          body: JSON.stringify({ text: data.text, voice_id: data.voice || "eve" }),
        });
        if (!res.ok) return { ok: false as const, error: `Speech service returned ${res.status}.` };
        return { ok: true as const, base64: Buffer.from(await res.arrayBuffer()).toString("base64"), mime: res.headers.get("content-type") || "audio/mpeg" };
      }
      return { ok: false as const, error: "Downloadable audio is not configured on this site. Use the built-in reader instead." };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Speech failed." };
    }
  });

export const aiTranscribe = createServerFn({ method: "POST" })
  .validator((d: { base64: string; mime: string }) => ({ base64: String(d?.base64 ?? ""), mime: String(d?.mime ?? "audio/wav") }))
  .handler(async ({ data }) => {
    if (!process.env.OPENAI_API_KEY) return { ok: false as const, error: "Audio transcription is not configured on this site." };
    if (data.base64.length > 4_200_000) return { ok: false as const, error: "Audio chunk too large." };
    if (!allow(await clientIp())) return { ok: false as const, error: "Daily limit reached." };
    const bytes = Buffer.from(data.base64, "base64");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: data.mime }), data.mime.includes("wav") ? "audio.wav" : "audio.webm");
    form.append("model", process.env.AI_STT_MODEL || "whisper-1");
    const res = await fetch(`${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) return { ok: false as const, error: `Transcription service returned ${res.status}.` };
    const j = (await res.json()) as { text?: string };
    return { ok: true as const, text: j.text ?? "" };
  });
