import { LANGS, type Lang } from "../domain/intents.js";

// Client for the GPU engine (engine/soro_engine/api.py), on AWS, Modal or localhost.

export interface Transcription {
  text: string;
  seconds: number;
  /** The language the voice note was heard in; can differ from the user's chosen one. */
  lang: Lang;
  /**
   * A Yoruba, Hausa or Igbo note whose transcript has no amount, as the English model heard it, when that one has
   * an amount: people often say amounts in English inside those languages. Pass it on to route().
   */
  enText?: string;
}

export interface EngineApi {
  /** `lang` is the user's chosen language; the engine also listens for the other three. */
  transcribe(audio: Uint8Array<ArrayBuffer>, mimeType: string, lang: Lang): Promise<Transcription>;
  /** Returns the raw router JSON; validate it with parseIntent(). */
  route(text: string, lang: Lang, today: string, enText?: string): Promise<unknown>;
  /** Rewrites a curated tip so it answers the trader's question, in their language. */
  adapt(input: { tip: string; question: string; lang: Lang }): Promise<string>;
  /** OGG/OPUS bytes ready for a WhatsApp voice note. */
  speak(text: string, lang: Lang): Promise<Uint8Array<ArrayBuffer>>;
}

interface Options {
  baseUrl: string;
  token: string;
  /** How long to wait for baseUrl. Defaults to 120s (a Modal cold start: container boot + model load), or 60s with a fallback. */
  timeoutMs?: number;
  /** A second engine with the same token, tried when baseUrl fails (network error, timeout or 5xx). */
  fallbackUrl?: string;
  /** After baseUrl fails, how long everything goes straight to the fallback before baseUrl is tried again. */
  cooldownMs?: number;
  log?: { warn(obj: object, msg: string): void };
  fetch?: typeof fetch;
  now?: () => number;
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const COLD_START_MS = 120_000;

export function createEngineClient(opts: Options): EngineApi {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const primary = { base: opts.baseUrl.replace(/\/$/, ""), timeoutMs: opts.timeoutMs ?? (opts.fallbackUrl ? 60_000 : COLD_START_MS) };
  // The fallback is Modal, which scales to zero: give it the full cold start.
  const fallback = opts.fallbackUrl ? { base: opts.fallbackUrl.replace(/\/$/, ""), timeoutMs: COLD_START_MS } : null;
  const cooldownMs = opts.cooldownMs ?? 2 * 60_000;
  let primaryDownUntil = 0;

  async function call(target: { base: string; timeoutMs: number }, path: string, body: BodyInit, contentType: string): Promise<Response> {
    const res = await f(`${target.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": contentType },
      body,
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    if (!res.ok) throw new EngineError(`engine ${path} failed with ${res.status}: ${await res.text().catch(() => "")}`, res.status);
    return res;
  }

  async function post(path: string, body: BodyInit, contentType: string): Promise<Response> {
    if (!fallback) return call(primary, path, body, contentType);
    if (now() >= primaryDownUntil) {
      try {
        return await call(primary, path, body, contentType);
      } catch (err) {
        // A 4xx is about the request itself (bad audio, bad token): the fallback would refuse it too.
        if (err instanceof EngineError && err.status !== undefined && err.status < 500) throw err;
        primaryDownUntil = now() + cooldownMs;
        opts.log?.warn({ err, path }, "engine failed, using the fallback");
      }
    }
    return call(fallback, path, body, contentType);
  }

  const json = async (path: string, payload: unknown) => (await post(path, JSON.stringify(payload), "application/json")).json() as Promise<any>;

  return {
    async transcribe(audio, mimeType, lang) {
      const res = await post(`/transcribe?lang=${lang}&detect=true`, audio, mimeType);
      const body = (await res.json()) as { text: string; seconds: number; lang?: string; en_text?: string };
      const heard = LANGS.find((l) => l === body.lang) ?? lang; // an older engine doesn't send it
      const enText = body.en_text?.trim();
      return { text: body.text.trim(), seconds: body.seconds, lang: heard, ...(enText ? { enText } : {}) };
    },
    async route(text, lang, today, enText) {
      return (await json("/route", { text, lang, today, ...(enText ? { en_text: enText } : {}) })).intent;
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
