import { z } from "zod";
import { parseNaira } from "./money.js";

export const LANGS = ["en", "yo", "ha", "ig"] as const;
export type Lang = (typeof LANGS)[number];

export const TIP_TOPICS = [
  "separate_money",
  "record_keeping",
  "cash_flow",
  "debt_recovery",
  "credit_readiness",
  "savings",
  "pricing",
] as const;
export type TipTopic = (typeof TIP_TOPICS)[number];

export const INTENTS = [
  "log_sale",
  "log_expense",
  "log_income",
  "log_debt",
  "debt_paid",
  "stock_update",
  "summary_query",
  "set_budget",
  "undo_last",
  "correct_last",
  "loan_intake",
  "ask_question",
  "greeting",
  "help",
  "unknown",
] as const;
export type IntentName = (typeof INTENTS)[number];

/** Spending categories. The first two are business spending; the rest are personal. */
export const CATEGORIES = [
  "goods",
  "business_costs",
  "food",
  "transport",
  "data_airtime",
  "rent_bills",
  "family",
  "health",
  "school",
  "fun",
  "clothing",
  "savings",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** What a correction can turn the last record into. */
export const RECORD_INTENTS = ["log_sale", "log_expense", "log_income", "log_debt", "debt_paid"] as const;

export const isBusinessCategory = (c: string | null | undefined): boolean => c === "goods" || c === "business_costs";

const optStr = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));
const optNum = z.unknown().transform((v) => (v == null || v === "" ? null : parseNaira(v)));

/**
 * Flat schema the engine's N-ATLaS router fills (JSON-schema constrained).
 * Lenient on input: the model sometimes returns "5k" or "" instead of numbers/nulls.
 */
export const Intent = z.object({
  intent: z.enum(INTENTS).catch("unknown"),
  item: optStr,
  quantity: optNum,
  unit: optStr,
  amount_ngn: optNum,
  counterparty: optStr,
  direction: z.enum(["owed_to_me", "i_owe"]).nullish().catch(null).transform((v) => v ?? null),
  category: z.enum(CATEGORIES).nullish().catch(null).transform((v) => v ?? null),
  period: z.enum(["today", "week", "month"]).nullish().catch(null).transform((v) => v ?? null),
  topic: z.enum(TIP_TOPICS).nullish().catch(null).transform((v) => v ?? null),
  question: optStr,
  purpose: optStr,
  /** correct_last only: the right kind of record, when the user says the kind was wrong. */
  correct_to: z.enum(RECORD_INTENTS).nullish().catch(null).transform((v) => v ?? null),
  /** Set by the engine, not the model: amounts in the message that the one record leaves out. */
  other_amounts: z
    .array(z.unknown())
    .nullish()
    .catch(null)
    .transform((v) => (v ?? []).map(parseNaira).filter((n): n is number => n != null && n > 0)),
});
export type Intent = z.infer<typeof Intent>;

export function parseIntent(raw: unknown): Intent {
  const r = Intent.safeParse(raw);
  return r.success ? r.data : Intent.parse({ intent: "unknown" });
}
