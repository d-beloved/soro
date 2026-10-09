import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/pipeline/handle.js";
import { Nudger, nudgeDelay } from "../src/pipeline/nudge.js";
import { makeDeps, pick, PHONE, tap, text } from "./fakes.js";

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

describe("nudge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function onboarded(lang = "lang_yo") {
    const t = makeDeps();
    t.deps.nudger = new Nudger(t.deps);
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

    // talking again restarts the clock, but the reminder is never sent twice
    await handleMessage(t.deps, text("HELP"));
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

  it("leaves people who recorded something alone", async () => {
    const t = await onboarded("lang_en");
    t.engine.routeResult = { intent: "log_expense", item: "bread", amount_ngn: 1500, category: "food" };
    await handleMessage(t.deps, text("I buy bread 1,500"));
    expect(t.state.txns).toHaveLength(1);
    t.sent.length = 0;
    await vi.advanceTimersByTimeAsync(4 * H);
    expect(t.sent).toEqual([]);
  });

  it("does not remind someone who has not finished onboarding or who deleted their data", async () => {
    const t = makeDeps();
    t.deps.nudger = new Nudger(t.deps);
    await handleMessage(t.deps, text("Hi"));
    await handleMessage(t.deps, tap("consent_yes")); // no language yet
    const d = await onboarded();
    await handleMessage(d.deps, tap("delete_yes"));
    t.sent.length = 0;
    d.sent.length = 0;
    await vi.advanceTimersByTimeAsync(24 * H);
    expect(t.sent).toEqual([]);
    expect(d.sent).toEqual([]);
  });
});
