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

describe("engine client with a server that sleeps when idle", () => {
  function setup(answers: Record<string, number | "down">) {
    let clock = 0;
    let wakes = 0;
    const calls: string[] = [];
    const f = (async (url: string) => {
      const u = new URL(url);
      calls.push(`${u.origin === AWS ? "aws" : "modal"}${u.pathname}`);
      const a = answers[u.origin];
      if (a === "down") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ intent: { intent: "unknown" }, text: "ok" }), { status: a ?? 200 });
    }) as unknown as typeof fetch;
    const e = createEngineClient({
      baseUrl: AWS,
      token: "t".repeat(16),
      fallbackUrl: MODAL,
      fetch: f,
      now: () => clock,
      cooldownMs: 120_000,
      wake: async () => void wakes++,
    });
    return { e, calls, wakes: () => wakes, at: (ms: number) => (clock = ms) };
  }

  it("checks a quiet server before using it, and only after a quiet spell", async () => {
    const s = setup({});
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls).toEqual(["aws/health", "aws/route"]);
    s.at(4 * 60_000);
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls.slice(2)).toEqual(["aws/route"]);
    s.at(10 * 60_000);
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls.slice(3)).toEqual(["aws/health", "aws/route"]);
    expect(s.wakes()).toBe(0);
  });

  it("wakes a stopped server and answers from the fallback until it is up", async () => {
    const answers: Record<string, number | "down"> = { [AWS]: "down" };
    const s = setup(answers);
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls).toEqual(["aws/health", "modal/route"]); // no waiting on the main route
    expect(s.wakes()).toBe(1);

    s.at(60_000); // still booting, inside the cooldown
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls.slice(2)).toEqual(["modal/route"]);

    s.at(120_000); // after the cooldown: looks again, asks again
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls.slice(3)).toEqual(["aws/health", "modal/route"]);
    expect(s.wakes()).toBe(2);

    delete answers[AWS]; // up
    s.at(240_000);
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls.slice(5)).toEqual(["aws/health", "aws/route"]);
  });

  it("wakes it after a failed call too", async () => {
    const s = setup({ [AWS]: 503 });
    await s.e.route("hi", "en", "2026-10-16");
    expect(s.calls).toEqual(["aws/health", "modal/route"]);
    expect(s.wakes()).toBe(1);
  });
});
