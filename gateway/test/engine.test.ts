import { describe, expect, it } from "vitest";
import { createEngineClient, EngineError } from "../src/engine/client.js";

const AWS = "https://engine.example.com";
const MODAL = "https://soro--engine.modal.run";

/** A fetch that answers per host: a status code, or "down" for a network error. */
function fakeFetch(answers: Record<string, number | "down">) {
  const hits: string[] = [];
  const f = (async (url: string) => {
    const host = new URL(url).origin;
    hits.push(host);
    const a = answers[host];
    if (a === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ intent: { intent: "unknown" }, text: "ok" }), { status: a ?? 200 });
  }) as unknown as typeof fetch;
  return { f, hits };
}

describe("engine client fallback", () => {
  it("uses the main engine while it works", async () => {
    const { f, hits } = fakeFetch({});
    const e = createEngineClient({ baseUrl: AWS, token: "t".repeat(16), fallbackUrl: MODAL, fetch: f });
    await e.route("hi", "en", "2026-10-14");
    expect(hits).toEqual([AWS]);
  });

  it("moves to the fallback when the main engine is down or erroring, then retries it after the cooldown", async () => {
    let clock = 0;
    const answers: Record<string, number | "down"> = { [AWS]: "down" };
    const { f, hits } = fakeFetch(answers);
    const e = createEngineClient({ baseUrl: AWS, token: "t".repeat(16), fallbackUrl: MODAL, fetch: f, now: () => clock, cooldownMs: 1000 });

    expect(await e.adapt({ tip: "a", question: "b", lang: "en" })).toBe("ok");
    expect(hits).toEqual([AWS, MODAL]);

    // inside the cooldown: straight to the fallback, no waiting on the main engine
    await e.route("hi", "en", "2026-10-14");
    expect(hits.slice(2)).toEqual([MODAL]);

    clock = 1000;
    answers[AWS] = 503;
    await e.route("hi", "en", "2026-10-14");
    expect(hits.slice(3)).toEqual([AWS, MODAL]);

    clock = 2000;
    delete answers[AWS];
    await e.route("hi", "en", "2026-10-14");
    expect(hits.slice(5)).toEqual([AWS]);
  });

  it("doesn't retry a request the engine refused", async () => {
    const { f, hits } = fakeFetch({ [AWS]: 422 });
    const e = createEngineClient({ baseUrl: AWS, token: "t".repeat(16), fallbackUrl: MODAL, fetch: f });
    await expect(e.route("hi", "en", "2026-10-14")).rejects.toBeInstanceOf(EngineError);
    expect(hits).toEqual([AWS]);
  });

  it("without a fallback, a failure is just a failure", async () => {
    const { f, hits } = fakeFetch({ [AWS]: 503 });
    const e = createEngineClient({ baseUrl: AWS, token: "t".repeat(16), fetch: f });
    await expect(e.route("hi", "en", "2026-10-14")).rejects.toMatchObject({ status: 503 });
    expect(hits).toEqual([AWS]);
  });
});
