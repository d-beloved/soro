import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/pipeline/handle.js";
import { Nudger, nudgeDelay } from "../src/pipeline/nudge.js";
import { parseKey, seal, unseal } from "../src/lib/seal.js";
import { FAKE_NOW, makeDeps, pick, PHONE, tap, text } from "./fakes.js";

const H = 60 * 60_000;

describe("nudgeDelay", () => {
  it("waits three hours, moved to between 08:00 and 20:00 WAT", () => {
    expect(nudgeDelay(new Date("2026-10-09T09:00:00Z"))).toBe(3 * H); // 10:00 WAT -> 13:00
    expect(nudgeDelay(new Date("2026-10-09T17:00:00Z"))).toBe(14 * H); // 18:00 WAT -> 08:00 next day
    expect(nudgeDelay(new Date("2026-10-09T02:00:00Z"))).toBe(5 * H); // 03:00 WAT -> 08:00
    expect(nudgeDelay(new Date("2026-10-09T15:59:00Z"))).toBe(3 * H); // 16:59 WAT -> 19:59
  });

  it("gives up when the reminder would land outside WhatsApp's 24-hour window", () => {
    expect(nudgeDelay(new Date("2026-10-09T09:00:00Z"), 24 * H)).toBeNull();
  });
});

const KEY = randomBytes(32);

describe("nudge", () => {
  const nudgers: Nudger[] = [];
  beforeEach(() => vi.useFakeTimers({ now: new Date(FAKE_NOW) }));
  afterEach(() => {
    nudgers.splice(0).forEach((n) => n.stop());
    vi.useRealTimers();
  });

  function startNudger(t: ReturnType<typeof makeDeps>) {
    const n = new Nudger({ ...t.deps, key: KEY });
    n.start();
    nudgers.push(n);
    t.deps.nudger = n;
    return n;
  }

  async function onboarded(lang = "lang_yo") {
    const t = makeDeps();
    t.deps.now = () => new Date(); // the fake clock, so later messages restart the reminder clock
    startNudger(t);
    await handleMessage(t.deps, text("Hi"));
    await handleMessage(t.deps, tap("consent_yes"));
    await handleMessage(t.deps, pick(lang));
    t.sent.length = 0;
    return t;
  }

  it("reminds someone who onboarded and recorded nothing, once, in their language", async () => {
    const t = await onboarded();
    await vi.advanceTimersByTimeAsync(3 * H - 1000);
    expect(t.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sent).toEqual([{ kind: "text", to: PHONE, body: expect.stringContaining("Kò sí nǹkan kan nínú àkọsílẹ̀ rẹ") }]);
    expect(t.state.outbound.at(-1)).toMatchObject({ language: "yo", payload: { nudge: true } });
    expect(t.state.pendingNudges.size).toBe(0);

    // talking again restarts the clock, but the reminder is never sent twice, and the number isn't kept for it
    await handleMessage(t.deps, text("HELP"));
    expect(t.state.pendingNudges.size).toBe(0);
    t.sent.length = 0;
    await vi.advanceTimersByTimeAsync(4 * H);
    expect(t.sent).toEqual([]);
  });

  it("each message restarts the clock", async () => {
    const t = await onboarded();
    await vi.advanceTimersByTimeAsync(2 * H);
    await handleMessage(t.deps, text("HELP"));
    t.sent.length = 0;
    await vi.advanceTimersByTimeAsync(2 * H);
    expect(t.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * H);
    expect(t.sent).toHaveLength(1);
  });

  it("survives a gateway restart", async () => {
    const t = await onboarded();
    nudgers[0]!.stop();
    await vi.advanceTimersByTimeAsync(4 * H); // down past the due time
    expect(t.sent).toEqual([]);
    startNudger(t); // the new process sends what came due while it was down
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toHaveLength(1);
  });

  it("stores the number only sealed, bound to the user", async () => {
    const t = await onboarded();
    const [row] = [...t.state.pendingNudges.values()];
    expect(row!.phone_enc).not.toContain(PHONE.replace(/\D/g, ""));
    expect(unseal(row!.phone_enc, KEY, row!.user_id)).toBe(PHONE);
    expect(() => unseal(row!.phone_enc, KEY, "someone-else")).toThrow();
  });

  it("lets a reminder go once WhatsApp's 24-hour window has closed", async () => {
    const t = await onboarded();
    nudgers[0]!.stop();
    await vi.advanceTimersByTimeAsync(24 * H);
    startNudger(t);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent).toEqual([]);
    expect(t.state.pendingNudges.size).toBe(0);
  });

  it("leaves people who recorded something alone, and drops their number at once", async () => {
    const t = await onboarded("lang_en");
    t.engine.routeResult = { intent: "log_expense", item: "bread", amount_ngn: 1500, category: "food" };
    await handleMessage(t.deps, text("I buy bread 1,500"));
    expect(t.state.txns).toHaveLength(1);
    expect(t.state.pendingNudges.size).toBe(0);
    t.sent.length = 0;
    await vi.advanceTimersByTimeAsync(4 * H);
    expect(t.sent).toEqual([]);
  });

  it("does not remind someone who has not finished onboarding or who deleted their data", async () => {
    const t = makeDeps();
    startNudger(t);
    await handleMessage(t.deps, text("Hi"));
    await handleMessage(t.deps, tap("consent_yes")); // no language yet
    const d = await onboarded();
    await handleMessage(d.deps, tap("delete_yes"));
    expect(t.state.pendingNudges.size).toBe(0);
    expect(d.state.pendingNudges.size).toBe(0);
    t.sent.length = 0;
    d.sent.length = 0;
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(t.sent).toEqual([]);
    expect(d.sent).toEqual([]);
  });
});

describe("seal", () => {
  it("round-trips and refuses the wrong key or user", () => {
    const sealed = seal("2348012345678", KEY, "u1");
    expect(unseal(sealed, KEY, "u1")).toBe("2348012345678");
    expect(seal("2348012345678", KEY, "u1")).not.toBe(sealed); // fresh IV each time
    expect(() => unseal(sealed, randomBytes(32), "u1")).toThrow();
    expect(() => unseal(sealed, KEY, "u2")).toThrow();
  });

  it("only takes a 32-byte key", () => {
    expect(parseKey(KEY.toString("base64"))).toEqual(KEY);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow();
  });
});
