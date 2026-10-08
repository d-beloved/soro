import type { Lang } from "../domain/intents.js";

// Client for the GPU engine (engine/soro_engine/api.py), on Modal or localhost.

export interface Transcription {
  text: string;
  seconds: number;
}

export interface EngineApi {
  transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string, lang: Lang): Promise<Transcription>;
  /** Returns the raw router JSON; validate it with parseIntent(). */
  route(text: string, lang: Lang, today: string): Promise<unknown>;
  /** Rewrites a curated tip so it answers the trader's question, in their language. */
  adapt(input: { tip: string; question: string; lang: Lang }): Promise<string>;
  /** OGG/OPUS bytes ready for a WhatsApp voice note. */
  speak(text: string, lang: Lang): Promise<Uint8Array<ArrayBuffer>>;
}

interface Options {
  baseUrl: string;
  token: string;
  /** Covers a Modal cold start (container boot + model load). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function createEngineClient(opts: Options): EngineApi {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;

  async function post(path: string, body: BodyInit, contentType: string): Promise<Response> {
    const res = await f(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new EngineError(`engine ${path} failed with ${res.status}: ${await res.text().catch(() => "")}`, res.status);
    return res;
  }

  const json = async (path: string, payload: unknown) => (await post(path, JSON.stringify(payload), "application/json")).json() as Promise<any>;

  return {
    async transcribe(audio, mimeType, lang) {
      const res = await post(`/transcribe?lang=${lang}`, audio, mimeType);
      const body = (await res.json()) as Transcription;
      return { text: body.text.trim(), seconds: body.seconds };
    },
    async route(text, lang, today) {
      return (await json("/route", { text, lang, today })).intent;
    },
    async adapt(input) {
      return (await json("/adapt", input)).text;
    },
    async speak(text, lang) {
      const res = await post("/speak", JSON.stringify({ text, lang }), "application/json");
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
