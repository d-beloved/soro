import { describe, expect, it } from "vitest";
import { findCorrections, findUnknowns, likelyCause, type Correction, type LoggedMessage } from "../src/domain/corrections.js";

let clock = 0;
function msg(id: string, intent: string, payload: unknown = { intent }, user = "u1"): LoggedMessage {
  clock += 1;
  return {
    id,
    user_id: user,
    created_at: new Date(Date.UTC(2026, 9, 8, 9, clock)).toISOString(),
    type: "audio",
    language: "yo",
    transcript: `said ${id}`,
    intent,
    payload,
  };
}

describe("findCorrections", () => {
  it("links a fixed amount to the record it changed", () => {
    const sale = msg("a", "log_sale", { intent: "log_sale", amount_ngn: 5000 });
    const fix = msg("b", "correct_last", { intent: "correct_last", amount_ngn: 50000, heard_en: "no be five k na fifty k" });
    expect(findCorrections([fix, sale], new Set(["a"]))).toEqual([{ kind: "fix", original: sale, fix, right: { amount_ngn: 50000 } }]);
  });

  it("follows the gateway: UNDO removes the newest live record, a fix applies to the next one", () => {
    const first = msg("a", "log_expense");
    const second = msg("b", "log_sale");
    const undo = msg("c", "undo_last");
    const fix = msg("d", "correct_last", { intent: "correct_last", amount_ngn: 2000 });
    const found = findCorrections([first, second, undo, fix], new Set(["a", "b"]));
    expect(found.map((c) => [c.kind, c.original.id])).toEqual([
      ["undo", "b"],
      ["fix", "a"],
    ]);
  });

  it("ignores messages that made no record, other users' records, and undo with nothing left", () => {
    const question = msg("a", "ask_question");
    const theirs = msg("b", "log_sale", { intent: "log_sale" }, "u2");
    const undo = msg("c", "undo_last");
    expect(findCorrections([question, theirs, undo], new Set(["b"]))).toEqual([]);
  });

  it("skips a correction that fixed nothing, and keeps one that fixed the kind", () => {
    const sale = msg("a", "log_sale");
    const empty = msg("b", "correct_last", { intent: "correct_last", amount_ngn: null });
    const kind = msg("c", "correct_last", { intent: "correct_last", correct_to: "log_expense", item: null });
    expect(findCorrections([sale, empty, kind], new Set(["a"])).map((c) => c.right)).toEqual([{ correct_to: "log_expense" }]);
  });
});

describe("likelyCause", () => {
  const fixOf = (heard: string, right: Record<string, unknown>, type = "audio"): Correction => {
    const original = { ...msg("a", "log_sale"), transcript: heard, type };
    return { kind: "fix", original, fix: msg("b", "correct_last"), right };
  };

  it("blames N-ATLaS when the right amount was in what it heard", () => {
    expect(likelyCause(fixOf("there's a tithe, 135,100", { amount_ngn: 135100 }))).toBe("router");
    expect(likelyCause(fixOf("I sell pepper 50k", { amount_ngn: 50000 }))).toBe("router");
  });
  it("blames the speech model when a voice note never had the right amount", () => {
    expect(likelyCause(fixOf("I sell pepper 5k", { amount_ngn: 50000 }))).toBe("asr");
    expect(likelyCause(fixOf("I sell pepper 5k", { amount_ngn: 50000 }, "text"))).toBe("unclear");
  });
  it("blames N-ATLaS for a wrong kind or category", () => {
    expect(likelyCause(fixOf("tithe 135,100", { correct_to: "log_expense" }))).toBe("router");
  });
});

describe("findUnknowns", () => {
  it("keeps only messages N-ATLaS could not place", () => {
    const lost = msg("a", "unknown");
    expect(findUnknowns([msg("b", "log_sale"), lost])).toEqual([lost]);
  });
});
