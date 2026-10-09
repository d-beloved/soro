import { describe, expect, it } from "vitest";
import { handleMessage } from "../src/pipeline/handle.js";
import { FAKE_NOW, makeDeps, pick, PHONE, tap, text, voice } from "./fakes.js";

async function onboarded(lang = "lang_en") {
  const t = makeDeps();
  await handleMessage(t.deps, text("Hi Sọ̀rọ̀ [OSHODI]"));
  await handleMessage(t.deps, tap("consent_yes"));
  await handleMessage(t.deps, pick(lang));
  t.sent.length = 0;
  t.calls.length = 0;
  return t;
}

describe("onboarding", () => {
  it("asks for consent first and records the referral tag, never the phone number", async () => {
    const { deps, sent, state } = makeDeps();
    await handleMessage(deps, text("Hi Sọ̀rọ̀ [OSHODI]"));
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

  it("consent -> language list -> welcome as text", async () => {
    const { deps, sent } = makeDeps();
    await handleMessage(deps, text("hello"));
    await handleMessage(deps, tap("consent_yes"));
    expect(sent.at(-1)).toMatchObject({ kind: "list", ids: ["lang_en", "lang_yo", "lang_ha", "lang_ig"] });
    await handleMessage(deps, pick("lang_yo"));
    expect(sent.at(-1)?.kind).toBe("text");
    expect(sent.at(-2)?.kind).toBe("list");
  });

  it("sends the consent prompt once for a burst of messages, again after 10 minutes", async () => {
    const t = makeDeps();
    await handleMessage(t.deps, text("Hi"));
    await handleMessage(t.deps, text("Hello"));
    await handleMessage(t.deps, voice());
    expect(t.sent.map((s) => s.kind)).toEqual(["buttons"]);
    expect(t.state.messages.map((m) => m.intent)).toEqual(["consent_prompt", "consent_pending", "consent_pending"]);

    t.deps.now = () => new Date(new Date(FAKE_NOW).getTime() + 11 * 60_000);
    await handleMessage(t.deps, text("Hi again"));
    expect(t.sent.map((s) => s.kind)).toEqual(["buttons", "buttons"]);
  });
});

describe("commerce", () => {
  it("logs a voice-note sale, echoes the transcript, replies with text then voice, then a text-only auto tip", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice", quantity: 3, unit: "bags", amount_ngn: "75k" };
    await handleMessage(t.deps, voice());

    expect(t.state.txns).toEqual([
      expect.objectContaining({ kind: "sale", item: "rice", qty: 3, unit: "bags", amount_ngn: 75000 }),
    ]);
    expect(t.sent[0]!.body).toContain('I heard: "I sell 3 bags of rice 75k"');
    expect(t.sent[0]!.body).toContain("₦75,000");
    expect(t.sent.map((s) => s.kind)).toEqual(["text", "voice", "text"]);
    expect(t.state.tipDeliveries).toEqual([expect.objectContaining({ tip_id: "record_keeping_01", trigger: "auto", audio_sent: false })]);

    const row = t.state.messages.at(-1);
    expect(row).toMatchObject({ intent: "log_sale", transcript: "I sell 3 bags of rice 75k", audio_seconds: 4.2, language: "en" });
    expect(row.latency_ms).toBeTypeOf("number");
  });

  it("speaks only the headline of a reply, never the transcript echo", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_expense", item: "data", amount_ngn: 2500, category: "data_airtime" };
    await handleMessage(t.deps, voice());
    expect(t.spoken).toEqual(["✅ Spent: data — ₦2,500 (data & airtime)."]);
  });

  it("speaks a short summary: totals only", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_income", item: "salary", amount_ngn: 1000000 };
    await handleMessage(t.deps, text("My salary don enter 1m"));
    t.engine.routeResult = { intent: "log_expense", amount_ngn: 2500, category: "data_airtime" };
    await handleMessage(t.deps, text("data 2500"));
    t.engine.routeResult = { intent: "summary_query", period: "today" };
    await handleMessage(t.deps, voice());
    expect(t.spoken).toEqual(["Your money today. Money in ₦1,000,000, spent ₦2,500."]);
    expect(t.sent.at(-2)!.body).toContain("Type SHARE");
  });

  it("says which amounts in a message were not saved, in the text and the voice note", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice and beans", amount_ngn: 8000, other_amounts: [2000] };
    await handleMessage(t.deps, voice());
    expect(t.state.txns).toEqual([expect.objectContaining({ kind: "sale", amount_ngn: 8000 })]);
    expect(t.sent[0]!.body).toContain("I also heard ₦2,000");
    expect(t.spoken[0]).toMatch(/^✅ Sale recorded: .*₦8,000\. ℹ️ I also heard ₦2,000/);
  });

  it("does not mention other amounts when nothing was saved", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice", other_amounts: [2000] };
    await handleMessage(t.deps, text("I sell rice"));
    expect(t.sent[0]!.body).not.toContain("also heard");
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
    t.engine.routeResult = { intent: "log_expense", amount_ngn: 2500, category: "business_costs" };
    await handleMessage(t.deps, text("transport for goods 2500"));
    t.engine.routeResult = { intent: "log_debt", counterparty: "Emeka", amount_ngn: 4000 };
    await handleMessage(t.deps, text("Emeka owe me 4k"));
    t.sent.length = 0;
    t.engine.routeResult = { intent: "summary_query", period: "today" };
    await handleMessage(t.deps, text("how far today"));
    const body = t.sent[0]!.body!;
    expect(body).toContain("Sales: ₦10,000 (1)");
    expect(body).toContain("Business costs: ₦2,500");
    expect(body).toContain("Sales minus costs: ₦7,500");
    expect(body).toContain("People owe you: ₦4,000 (Emeka ₦4,000)");
    expect(body).not.toContain("Personal");
    expect(body).toContain("Type SHARE");
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

describe("fixing mistakes", () => {
  it("UNDO removes the last record from every total", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "rice", quantity: 3, unit: "bags", amount_ngn: 75000 };
    await handleMessage(t.deps, text("sold rice 75k"));
    t.sent.length = 0;
    t.calls.length = 0;
    await handleMessage(t.deps, text("undo"));
    expect(t.calls).toEqual([]); // a command: no LLM call
    expect(t.sent[0]!.body).toContain("Removed: Sale: 3 bags rice — ₦75,000");
    expect(t.state.txns[0].voided_at).toBeTruthy();

    t.engine.routeResult = { intent: "summary_query", period: "today" };
    await handleMessage(t.deps, text("how far today"));
    expect(t.sent.find((s) => s.body?.includes("Nothing recorded today"))).toBeDefined();
  });

  it("undo by voice, and says so when there is nothing to remove", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "undo_last" };
    await handleMessage(t.deps, text("cancel am"));
    expect(t.sent[0]!.body).toContain("nothing to remove");
  });

  it("corrects the amount of the last record", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "pepper", amount_ngn: 5000 };
    await handleMessage(t.deps, text("sold pepper 5k"));
    t.sent.length = 0;
    t.engine.routeResult = { intent: "correct_last", amount_ngn: 50000 };
    await handleMessage(t.deps, text("no be 5k, na 50k"));
    expect(t.state.txns[0].amount_ngn).toBe(50000);
    expect(t.sent[0]!.body).toContain("Fixed: Sale: pepper — ₦50,000");
  });

  it("fixes the kind and the amount in one message", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_income", item: "salary", amount_ngn: 135000 };
    await handleMessage(t.deps, text("there's a tithe 135,000"));
    t.sent.length = 0;
    t.engine.routeResult = { intent: "correct_last", correct_to: "log_expense", item: "tithe", amount_ngn: 135100 };
    await handleMessage(t.deps, text("no be income, na tithe I pay, 135,100"));
    expect(t.state.txns[0]).toMatchObject({ kind: "expense", item: "tithe", amount_ngn: 135100, category: "other" });
    expect(t.sent[0]!.body).toContain("Fixed: Spending: tithe — ₦135,100 (other)");
  });

  it("fixes a category, or a debt's person and direction", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_expense", item: "bolt", amount_ngn: 3500, category: "food" };
    await handleMessage(t.deps, text("bolt 3500"));
    t.engine.routeResult = { intent: "correct_last", category: "transport" };
    await handleMessage(t.deps, text("e no be food, na transport"));
    expect(t.state.txns[0]).toMatchObject({ kind: "expense", category: "transport", amount_ngn: 3500 });

    t.engine.routeResult = { intent: "log_debt", counterparty: "Chidi", amount_ngn: 7000, direction: "owed_to_me" };
    await handleMessage(t.deps, text("Chidi owe me 7k"));
    t.engine.routeResult = { intent: "correct_last", counterparty: "Emeka", direction: "i_owe" };
    await handleMessage(t.deps, text("na Emeka, and na me owe am"));
    expect(t.state.txns[1]).toMatchObject({ kind: "debt_i_owe", counterparty: "Emeka", amount_ngn: 7000, category: null });
  });

  it("asks what to change when the correction changes nothing", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_sale", item: "pepper", amount_ngn: 5000 };
    await handleMessage(t.deps, text("sold pepper 5k"));
    t.sent.length = 0;
    t.engine.routeResult = { intent: "correct_last", amount_ngn: 5000 };
    await handleMessage(t.deps, text("e no correct"));
    expect(t.sent[0]!.body).toContain("What should I change? Last record: Sale: pepper — ₦5,000");
  });
});

describe("spoken language", () => {
  it("understands and answers a voice note in the language it was spoken in, without changing the saved one", async () => {
    const t = await onboarded("lang_en");
    t.engine.heardLang = "yo";
    t.engine.routeResult = { intent: "log_sale", item: "rice", amount_ngn: 75000 };
    await handleMessage(t.deps, voice());
    expect(t.sent[0]!.body).toContain("Ohun tí mo gbọ́");
    const user = [...t.state.users.values()][0]!;
    expect(user.language).toBe("en");
    expect(t.state.messages.at(-1)).toMatchObject({ language: "yo" });
  });

  it("gives the router the English hearing of a note, but shows the note's own transcript", async () => {
    const t = await onboarded("lang_yo");
    t.engine.enText = "more a wunje thirteen thousand two hundred";
    t.engine.routeResult = { intent: "log_expense", item: "food", amount_ngn: 13200, category: "food" };
    await handleMessage(t.deps, voice());
    expect(t.engine.routedEnText).toEqual(["more a wunje thirteen thousand two hundred"]);
    expect(t.sent[0]!.body).toContain("I sell 3 bags of rice 75k");
    expect(t.sent[0]!.body).not.toContain("thirteen");
    expect(t.state.messages.at(-1).payload).toMatchObject({ amount_ngn: 13200, heard_en: "more a wunje thirteen thousand two hundred" });
  });

  it("routes text without an English hearing", async () => {
    const t = await onboarded();
    t.engine.enText = "ignored";
    await handleMessage(t.deps, text("hello"));
    expect(t.engine.routedEnText).toEqual([undefined]);
  });
});

describe("debts paid back", () => {
  it("tracks what each person still owes", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_debt", counterparty: "Emeka", amount_ngn: 4000, direction: "owed_to_me" };
    await handleMessage(t.deps, text("Emeka owe me 4k"));
    t.engine.routeResult = { intent: "debt_paid", counterparty: "emeka", amount_ngn: 1500, direction: "owed_to_me" };
    await handleMessage(t.deps, text("Emeka pay me 1500"));
    expect(t.state.txns.at(-1)).toMatchObject({ kind: "debt_paid_to_me", amount_ngn: 1500 });
    expect(t.sent.at(-1)!.body).toContain("emeka still owes you ₦2,500");

    t.engine.routeResult = { intent: "debt_paid", counterparty: "Emeka", amount_ngn: 2500, direction: "owed_to_me" };
    await handleMessage(t.deps, text("Emeka don pay the rest"));
    expect(t.sent.find((s) => s.body?.includes("Emeka has paid everything"))).toBeDefined();

    t.sent.length = 0;
    t.engine.routeResult = { intent: "summary_query", period: "month" };
    await handleMessage(t.deps, text("summary"));
    expect(t.sent[0]!.body).not.toContain("People owe you");
  });

  it("records repayments the user makes", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_debt", counterparty: "Alhaji", amount_ngn: 20000, direction: "i_owe" };
    await handleMessage(t.deps, text("I owe Alhaji 20k"));
    t.engine.routeResult = { intent: "debt_paid", counterparty: "Alhaji", amount_ngn: 10000, direction: "i_owe" };
    await handleMessage(t.deps, text("I pay Alhaji 10k"));
    expect(t.sent.find((s) => s.body?.includes("You still owe Alhaji ₦10,000"))).toBeDefined();
  });
});

describe("personal money", () => {
  it("logs personal spending and income in their own summary section", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_income", item: "salary", amount_ngn: 150000 };
    await handleMessage(t.deps, text("salary 150k"));
    expect(t.state.txns.at(-1)).toMatchObject({ kind: "income", amount_ngn: 150000 });
    t.engine.routeResult = { intent: "log_expense", item: "data", amount_ngn: 1500, category: "data_airtime" };
    await handleMessage(t.deps, text("data 1500"));
    expect(t.sent.find((s) => s.body?.includes("Spent: data — ₦1,500 (data & airtime)"))).toBeDefined();
    t.engine.routeResult = { intent: "log_expense", item: "lunch", amount_ngn: 2500, category: "food" };
    await handleMessage(t.deps, text("lunch 2500"));

    t.sent.length = 0;
    t.engine.routeResult = { intent: "summary_query", period: "month" };
    await handleMessage(t.deps, text("where my money dey go"));
    const body = t.sent[0]!.body!;
    expect(body).toContain("Money in: ₦150,000");
    expect(body).toContain("Spent: ₦4,000");
    expect(body).toContain("Left: ₦146,000");
    expect(body).toContain("Most spending: food ₦2,500, data & airtime ₦1,500");
    expect(body).not.toContain("Business");
  });

  it("an expense without a category counts as personal", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "log_expense", amount_ngn: 700 };
    await handleMessage(t.deps, text("I spend 700"));
    expect(t.state.txns[0]).toMatchObject({ kind: "expense", category: "other" });
  });

  it("sets a budget and reports against it on each spend", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "set_budget", category: "food", amount_ngn: "20k" };
    await handleMessage(t.deps, text("food budget 20k"));
    expect(t.sent[0]!.body).toContain("Budget set: food, ₦20,000 a month");
    t.engine.routeResult = { intent: "log_expense", item: "foodstuff", amount_ngn: 14000, category: "food" };
    await handleMessage(t.deps, text("foodstuff 14k"));
    expect(t.sent.find((s) => s.body?.includes("Food this month: ₦14,000 of your ₦20,000 budget (₦6,000 left)"))).toBeDefined();
    t.engine.routeResult = { intent: "log_expense", item: "suya", amount_ngn: 8000, category: "food" };
    await handleMessage(t.deps, text("suya 8k"));
    expect(t.sent.find((s) => s.body?.includes("₦2,000 over your ₦20,000 budget"))).toBeDefined();
  });

  it("asks which category a budget is for", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "set_budget", amount_ngn: 20000 };
    await handleMessage(t.deps, text("budget 20k"));
    expect(t.sent[0]!.body).toContain("Budget for what?");
  });
});

describe("sharing", () => {
  it("SHARE sends a forwardable link with the user's code, and counts who joined through it", async () => {
    const t = await onboarded();
    await handleMessage(t.deps, text("share"));
    const link = t.sent[1]!.body!.match(/https:\/\/wa\.me\/2349077485454\?text=\S+/)![0];
    const code = decodeURIComponent(link.split("text=")[1]!).match(/\[(F-[0-9A-Z]+)\]/)![1]!;
    expect(t.sent[0]!.body).toContain("joined with your link so far: 0");

    // a friend arrives through the link and consents
    const friend = { ...text(`Hi Sọ̀rọ̀ [${code}]`), from: "2348099999999" };
    await handleMessage(t.deps, friend);
    await handleMessage(t.deps, { ...tap("consent_yes"), from: "2348099999999" });
    t.sent.length = 0;
    await handleMessage(t.deps, text("SHARE"));
    expect(t.sent[0]!.body).toContain("joined with your link so far: 1");
  });
});

describe("voice tutor", () => {
  it("grounds the answer in a curated tip and records the delivery", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "ask_question", topic: "savings", question: "How I go save?" };
    await handleMessage(t.deps, text("How I go save?"));
    expect(t.calls).toContain("adapt");
    expect(t.sent[0]!.body).toContain("Adapted: Save a little every day.");
    expect(t.sent.map((s) => s.kind)).toEqual(["text"]);
    expect(t.state.tipDeliveries[0]).toMatchObject({ tip_id: "savings_01", trigger: "asked", audio_sent: false });
  });

  it("answers a voice-note question by voice too", async () => {
    const t = await onboarded();
    t.engine.routeResult = { intent: "ask_question", topic: "savings", question: "How I go save?" };
    await handleMessage(t.deps, voice());
    expect(t.sent.map((s) => s.kind)).toEqual(["text", "voice"]);
    expect(t.state.tipDeliveries[0]).toMatchObject({ trigger: "asked", audio_sent: true });
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

describe("slow replies", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("tells the user we got it when the engine is slow, then sends the reply", async () => {
    const t = await onboarded();
    t.deps.slowReplyMs = 5;
    t.engine.routeResult = { intent: "greeting" };
    const route = t.engine.route;
    t.engine.route = async (...args) => (await wait(40), route(...args));
    await handleMessage(t.deps, text("hello"));
    expect(t.sent.map((s) => s.body)).toEqual(["⏳ Got it, one moment…", expect.stringContaining("Hello!")]);
  });

  it("waits for a voice note's language, and says it in that one", async () => {
    const t = await onboarded("lang_yo");
    t.deps.slowReplyMs = 5;
    t.engine.heardLang = "en";
    t.engine.routeResult = { intent: "greeting" };
    const transcribe = t.engine.transcribe;
    t.engine.transcribe = async (...args) => (await wait(40), transcribe(...args));
    await handleMessage(t.deps, voice());
    expect(t.sent.filter((s) => s.kind === "text").map((s) => s.body)).toEqual([
      "⏳ Got it, one moment…",
      expect.stringContaining("Hello!"),
    ]);
  });

  it("sends no notice when the reply comes quickly", async () => {
    const t = await onboarded();
    t.deps.slowReplyMs = 30;
    t.engine.routeResult = { intent: "greeting" };
    await handleMessage(t.deps, text("hello"));
    await wait(60);
    expect(t.sent.map((s) => s.body)).toEqual([expect.stringContaining("Hello!")]);
  });
});
