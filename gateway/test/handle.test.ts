import { describe, expect, it } from "vitest";
import { handleMessage } from "../src/pipeline/handle.js";
import { makeDeps, pick, PHONE, tap, text, voice } from "./fakes.js";

async function onboarded(lang = "lang_en") {
  const t = makeDeps();
  await handleMessage(t.deps, text("Hi SoroEngine [OSHODI]"));
  await handleMessage(t.deps, tap("consent_yes"));
  await handleMessage(t.deps, pick(lang));
  t.sent.length = 0;
  t.calls.length = 0;
  return t;
}

describe("onboarding", () => {
  it("asks for consent first and records the referral tag, never the phone number", async () => {
    const { deps, sent, state } = makeDeps();
    await handleMessage(deps, text("Hi SoroEngine [OSHODI]"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "buttons", ids: ["consent_yes", "consent_no"] });
    expect(sent[0]!.body).toContain("https://soro.charavol.com/privacy");
    const user = [...state.users.values()][0]!;
    expect(user.ref_source).toBe("OSHODI");
    expect(JSON.stringify([...state.users.values()])).not.toContain(PHONE);
  });

  it("does not process content before consent", async () => {
    const { deps, calls, state } = makeDeps();
    await handleMessage(deps, voice());
    expect(calls).toEqual([]);
    expect(state.txns).toHaveLength(0);
  });

  it("consent -> language list -> welcome with voice", async () => {
    const { deps, sent } = makeDeps();
    await handleMessage(deps, text("hello"));
    await handleMessage(deps, tap("consent_yes"));
    expect(sent.at(-1)).toMatchObject({ kind: "list", ids: ["lang_en", "lang_yo", "lang_ha", "lang_ig"] });
    await handleMessage(deps, pick("lang_yo"));
    expect(sent.at(-2)?.kind).toBe("text");
    expect(sent.at(-1)?.kind).toBe("voice");
  });
});

describe("commerce", () => {
  it("logs a voice-note sale, echoes the transcript, replies with text then voice, then an auto tip", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice", quantity: 3, unit: "bags", amount_ngn: "75k" };
    await handleMessage(t.deps, voice());

    expect(t.state.txns).toEqual([
      expect.objectContaining({ kind: "sale", item: "rice", qty: 3, unit: "bags", amount_ngn: 75000 }),
    ]);
    expect(t.sent[0]!.body).toContain('I heard: "I sell 3 bags of rice 75k"');
    expect(t.sent[0]!.body).toContain("₦75,000");
    expect(t.sent.map((s) => s.kind)).toEqual(["text", "voice", "text", "voice"]);
    expect(t.state.tipDeliveries).toEqual([expect.objectContaining({ tip_id: "record_keeping_01", trigger: "auto", audio_sent: true })]);

    const row = t.state.messages.at(-1);
    expect(row).toMatchObject({ intent: "log_sale", transcript: "I sell 3 bags of rice 75k", audio_seconds: 4.2, language: "en" });
    expect(row.latency_ms).toBeTypeOf("number");
  });

  it("asks for the amount instead of guessing", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice" };
    await handleMessage(t.deps, text("I sell rice"));
    expect(t.state.txns).toHaveLength(0);
    expect(t.sent[0]!.body).toContain("how much");
  });

  it("summarises sales, expenses and debts", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", amount_ngn: 10000 };
    await handleMessage(t.deps, text("sold 10k"));
    t.engine.routeResult = { intent: "log_expense", amount_ngn: 2500 };
    await handleMessage(t.deps, text("transport 2500"));
    t.engine.routeResult = { intent: "log_debt", counterparty: "Emeka", amount_ngn: 4000 };
    await handleMessage(t.deps, text("Emeka owe me 4k"));
    t.sent.length = 0;
    t.engine.routeResult = { intent: "summary_query", period: "today" };
    await handleMessage(t.deps, text("how far today"));
    const body = t.sent[0]!.body!;
    expect(body).toContain("Sales: ₦10,000 (1)");
    expect(body).toContain("Expenses: ₦2,500");
    expect(body).toContain("Sales minus expenses: ₦7,500");
    expect(body).toContain("People owe you: ₦4,000");
  });

  it("attaches recorded monthly sales to a loan intake", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", amount_ngn: 50000 };
    await handleMessage(t.deps, text("sold 50k"));
    t.engine.routeResult = { intent: "loan_intake", amount_ngn: "100k", purpose: "buy goods" };
    await handleMessage(t.deps, text("I need 100k loan"));
    expect(t.state.loans[0]).toMatchObject({ amount_ngn: 100000, purpose: "buy goods", monthly_sales_ngn: 50000 });
  });
});

describe("voice tutor", () => {
  it("grounds the answer in a curated tip and records the delivery", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "ask_question", topic: "savings", question: "How I go save?" };
    await handleMessage(t.deps, text("How I go save?"));
    expect(t.calls).toContain("adapt");
    expect(t.sent[0]!.body).toContain("Adapted: Save a little every day.");
    expect(t.sent[1]!.kind).toBe("voice");
    expect(t.state.tipDeliveries[0]).toMatchObject({ tip_id: "savings_01", trigger: "asked", audio_sent: true });
  });

  it("falls back to the stored translation if the LLM fails", async () => {
    const t = await onboarded("lang_yo");
    t.engine.adapt = async () => {
      throw new Error("engine down");
    };
    t.engine.routeResult = { intent: "ask_question", topic: "savings" };
    await handleMessage(t.deps, text("Bawo ni mo se le fi owo pamo?"));
    expect(t.sent[0]!.body).toContain("Fi owó díẹ̀ pamọ́ lójoojúmọ́.");
  });
});

describe("reliability and privacy", () => {
  it("ignores webhook retries of the same message", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", amount_ngn: 1000 };
    const m = text("sold 1k");
    await handleMessage(t.deps, m);
    await handleMessage(t.deps, m);
    expect(t.state.txns).toHaveLength(1);
  });

  it("still sends the text reply when TTS fails", async () => {
    const t = await onboarded();
    t.engine.speak = async () => {
      throw new Error("tts oom");
    };
    t.engine.routeResult = { intent: "greeting" };
    await handleMessage(t.deps, text("hello"));
    expect(t.sent.map((s) => s.kind)).toEqual(["text"]);
  });

  it("apologises and records the error when the engine is down", async () => {
    const t = await onboarded();
    t.engine.route = async () => {
      throw new Error("503");
    };
    await handleMessage(t.deps, text("sold 1k"));
    expect(t.sent[0]!.body).toContain("something went wrong");
    expect(t.state.messages.at(-1).error).toContain("503");
  });

  it("DELETE asks for confirmation, then removes the user", async () => {
    const t = await onboarded();
    await handleMessage(t.deps, text("delete"));
    expect(t.sent[0]).toMatchObject({ kind: "buttons", ids: ["delete_yes", "delete_no"] });
    await handleMessage(t.deps, tap("delete_yes"));
    expect(t.state.users.size).toBe(0);
  });
});
