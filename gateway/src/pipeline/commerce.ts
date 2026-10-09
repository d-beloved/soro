import type { DebtRow, SummaryRow, TxnKind, TxnPatch, TxnRow } from "../db/repo.js";
import { isBusinessCategory, type Category, type Intent } from "../domain/intents.js";
import { formatNaira } from "../domain/money.js";
import { periodStart } from "../domain/time.js";
import { t, type MsgKey } from "../locales/index.js";
import type { Ctx, Reply } from "./context.js";

type Lang = Ctx["lang"];

function describe(i: Pick<Intent, "quantity" | "unit" | "item">): string {
  const what = [i.quantity != null ? String(i.quantity) : null, i.unit, i.item].filter(Boolean).join(" ");
  return what ? `${what} — ` : "";
}

const sumOf = (rows: SummaryRow[], keep: (r: SummaryRow) => boolean) => rows.filter(keep).reduce((a, r) => a + r.total, 0);
const totalOf = (rows: SummaryRow[], kind: TxnKind) => sumOf(rows, (r) => r.kind === kind);
const isBusinessCost = (r: SummaryRow) => r.kind === "expense" && isBusinessCategory(r.category);
// Expenses with no category count as personal "other", the router's fallback.
const isPersonalSpend = (r: SummaryRow) => r.kind === "expense" && !isBusinessCategory(r.category);

const categoryLabel = (lang: Lang, c: string | null) => t(lang, `cat_${c ?? "other"}` as MsgKey);

/** "Sale: 3 bags rice — ₦75,000" for a stored record, used by UNDO and corrections. Spends add their category. */
function describeRow(lang: Lang, r: TxnRow): string {
  const what = [r.qty != null ? String(r.qty) : null, r.unit, r.item].filter(Boolean).join(" ") || r.counterparty || "";
  const parts = [what, r.amount_ngn != null ? formatNaira(r.amount_ngn) : null].filter(Boolean).join(" — ");
  const category = r.kind === "expense" && r.category ? ` (${categoryLabel(lang, r.category)})` : "";
  return `${t(lang, `kind_${r.kind}` as MsgKey)}${parts ? `: ${parts}` : ""}${category}`;
}

const isIOwe = (k: TxnKind) => k === "debt_i_owe" || k === "debt_i_paid";

/**
 * What a correction changes on the last record: any of its kind, amount, item, category and person, in one
 * message ("no be income, na tithe I pay, 135k"). Only fields that differ are returned; empty means nothing to fix.
 */
export function correctionPatch(last: TxnRow, i: Intent): TxnPatch {
  // Debts keep their direction unless the user gives one.
  const iOwe = i.direction ? i.direction === "i_owe" : isIOwe(last.kind);
  let kind = last.kind;
  if (i.correct_to === "log_sale") kind = "sale";
  else if (i.correct_to === "log_expense") kind = "expense";
  else if (i.correct_to === "log_income") kind = "income";
  else if (i.correct_to === "log_debt" || (!i.correct_to && i.direction && (last.kind === "debt_owed_to_me" || last.kind === "debt_i_owe")))
    kind = iOwe ? "debt_i_owe" : "debt_owed_to_me";
  else if (i.correct_to === "debt_paid" || (!i.correct_to && i.direction && (last.kind === "debt_paid_to_me" || last.kind === "debt_i_paid")))
    kind = iOwe ? "debt_i_paid" : "debt_paid_to_me";

  // Only spends have a category; one that becomes a spend without being told falls back to "other".
  const category = kind === "expense" ? (i.category ?? last.category ?? "other") : null;

  const next: TxnPatch = { kind, category, amount_ngn: i.amount_ngn ?? last.amount_ngn, item: i.item ?? last.item, counterparty: i.counterparty ?? last.counterparty };
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== last[k as keyof TxnPatch])) as TxnPatch;
}

/** What is still owed, per person, after repayments. Positive means unpaid. */
function balances(rows: DebtRow[]) {
  const people = new Map<string, { name: string | null; toMe: number; iOwe: number }>();
  for (const r of rows) {
    const key = (r.counterparty ?? "").trim().toLowerCase();
    const p = people.get(key) ?? { name: r.counterparty, toMe: 0, iOwe: 0 };
    if (r.kind === "debt_owed_to_me") p.toMe += r.total;
    if (r.kind === "debt_paid_to_me") p.toMe -= r.total;
    if (r.kind === "debt_i_owe") p.iOwe += r.total;
    if (r.kind === "debt_i_paid") p.iOwe -= r.total;
    people.set(key, p);
  }
  return people;
}

async function record(ctx: Ctx, kind: TxnKind, i: Intent, category: string | null = null): Promise<void> {
  await ctx.deps.repo.insertTransaction({
    user_id: ctx.user.id,
    message_id: ctx.messageId,
    kind,
    item: i.item,
    qty: i.quantity,
    unit: i.unit,
    amount_ngn: i.amount_ngn,
    counterparty: i.counterparty,
    category,
  });
}

/** "Food this month: ₦14,000 of your ₦20,000 budget (₦6,000 left)", or null if there is no budget. */
async function budgetLine(ctx: Ctx, category: string): Promise<string | null> {
  const budget = (await ctx.deps.repo.budgets(ctx.user.id)).find((b) => b.category === category);
  if (!budget) return null;
  const month = await ctx.deps.repo.summary(ctx.user.id, periodStart("month", ctx.now));
  const spent = sumOf(month, (r) => r.kind === "expense" && (r.category ?? "other") === category);
  const label = categoryLabel(ctx.lang, category);
  const vars = { category: label.charAt(0).toUpperCase() + label.slice(1), spent: formatNaira(spent), budget: formatNaira(budget.amount_ngn) };
  return spent > budget.amount_ngn
    ? t(ctx.lang, "budget_over", { ...vars, over: formatNaira(spent - budget.amount_ngn) })
    : t(ctx.lang, "budget_status", { ...vars, left: formatNaira(budget.amount_ngn - spent) });
}

export async function applyCommerce(ctx: Ctx, i: Intent): Promise<Reply | null> {
  const { lang } = ctx;
  const { repo } = ctx.deps;

  switch (i.intent) {
    case "log_sale": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      await record(ctx, "sale", i);
      const today = await repo.summary(ctx.user.id, periodStart("today", ctx.now));
      return {
        text: t(lang, "sale_logged", { what: describe(i), amount: formatNaira(i.amount_ngn), today_total: formatNaira(totalOf(today, "sale")) }),
        voice: false,
        autoTipTopic: "record_keeping",
      };
    }

    case "log_expense": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      const category: Category = i.category ?? "other";
      await record(ctx, "expense", i, category);
      const today = await repo.summary(ctx.user.id, periodStart("today", ctx.now));
      const vars = { what: describe(i), amount: formatNaira(i.amount_ngn) };
      if (isBusinessCategory(category)) {
        return {
          text: t(lang, "expense_logged", { ...vars, today_total: formatNaira(sumOf(today, isBusinessCost)) }),
          voice: false,
          autoTipTopic: "separate_money",
        };
      }
      const lines = [
        t(lang, "spent_logged", { ...vars, category: categoryLabel(lang, category), today_total: formatNaira(sumOf(today, isPersonalSpend)) }),
      ];
      const budget = await budgetLine(ctx, category);
      if (budget) lines.push(budget);
      return { text: lines.join("\n"), voice: false, autoTipTopic: "savings" };
    }

    case "log_income": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      await record(ctx, "income", i);
      const month = await repo.summary(ctx.user.id, periodStart("month", ctx.now));
      return {
        text: t(lang, "income_logged", { what: describe(i), amount: formatNaira(i.amount_ngn), month_total: formatNaira(totalOf(month, "income")) }),
        voice: false,
        autoTipTopic: "savings",
      };
    }

    case "log_debt": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      // "X owe me" is by far the most common phrasing, so it is the default.
      const kind = i.direction === "i_owe" ? "debt_i_owe" : "debt_owed_to_me";
      await record(ctx, kind, i);
      return {
        text: t(lang, `${kind}_logged`, { who: i.counterparty ?? t(lang, "someone"), amount: formatNaira(i.amount_ngn) }),
        voice: false,
        autoTipTopic: "debt_recovery",
      };
    }

    case "debt_paid": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      const kind = i.direction === "i_owe" ? "debt_i_paid" : "debt_paid_to_me";
      await record(ctx, kind, i);
      const who = i.counterparty ?? t(lang, "someone");
      let balance = "";
      if (i.counterparty) {
        const p = balances(await repo.debts(ctx.user.id)).get(i.counterparty.trim().toLowerCase());
        const left = p ? (kind === "debt_i_paid" ? p.iOwe : p.toMe) : 0;
        if (kind === "debt_i_paid") {
          balance = left > 0 ? t(lang, "balance_you_owe", { who, amount: formatNaira(left) }) : t(lang, "balance_cleared_i_owe", { who });
        } else {
          balance = left > 0 ? t(lang, "balance_owes_you", { who, amount: formatNaira(left) }) : t(lang, "balance_cleared_to_me", { who });
        }
      }
      return {
        text: t(lang, `${kind}_logged`, { who, amount: formatNaira(i.amount_ngn), balance }).trim(),
        voice: false,
        autoTipTopic: "debt_recovery",
      };
    }

    case "set_budget": {
      if (!i.category) return { text: t(lang, "need_category"), voice: true };
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      await repo.setBudget(ctx.user.id, i.category, i.amount_ngn);
      const month = await repo.summary(ctx.user.id, periodStart("month", ctx.now));
      const spent = sumOf(month, (r) => r.kind === "expense" && (r.category ?? "other") === i.category);
      return {
        text: t(lang, "budget_set", { category: categoryLabel(lang, i.category), amount: formatNaira(i.amount_ngn), spent: formatNaira(spent) }),
        voice: true,
        autoTipTopic: "cash_flow",
      };
    }

    case "undo_last": {
      const last = await repo.lastTransaction(ctx.user.id);
      if (!last) return { text: t(lang, "nothing_to_undo"), voice: true };
      await repo.voidTransaction(last.id);
      return { text: t(lang, "undone", { what: describeRow(lang, last) }), voice: true };
    }

    case "correct_last": {
      const last = await repo.lastTransaction(ctx.user.id);
      if (!last) return { text: t(lang, "nothing_to_undo"), voice: true };
      if (last.kind === "stock") return { text: t(lang, "cannot_correct"), voice: true };
      const patch = correctionPatch(last, i);
      if (Object.keys(patch).length === 0) return { text: t(lang, "need_fix", { what: describeRow(lang, last) }), voice: true };
      await repo.updateTransaction(last.id, patch);
      return { text: t(lang, "corrected", { what: describeRow(lang, { ...last, ...patch }) }), voice: true };
    }

    case "stock_update": {
      if (!i.item) return { text: t(lang, "need_item"), voice: true };
      await record(ctx, "stock", i);
      const qty = [i.quantity != null ? String(i.quantity) : "", i.unit ?? ""].filter(Boolean).join(" ");
      return { text: t(lang, "stock_logged", { qty, item: i.item }), voice: false, autoTipTopic: "pricing" };
    }

    case "summary_query":
      return summarise(ctx, i.period ?? "today");

    case "loan_intake": {
      // Attach the trader's own recorded sales: this is what makes the intake useful to a lender.
      const last30 = await repo.summary(ctx.user.id, new Date(ctx.now.getTime() - 30 * 86_400_000));
      const monthlySales = totalOf(last30, "sale");
      await repo.insertLoanIntake({
        user_id: ctx.user.id,
        message_id: ctx.messageId,
        amount_ngn: i.amount_ngn,
        purpose: i.purpose ?? i.item,
        monthly_sales_ngn: monthlySales > 0 ? monthlySales : null,
      });
      const purpose = i.purpose ?? i.item;
      return {
        text: t(lang, "loan_logged", {
          amount: i.amount_ngn != null ? formatNaira(i.amount_ngn) : t(lang, "a_loan"),
          purpose: purpose ? ` (${purpose})` : "",
        }),
        voice: true,
        autoTipTopic: "credit_readiness",
      };
    }

    default:
      return null;
  }
}

/** Business, personal and debt sections, each shown only when the user has records for it. */
async function summarise(ctx: Ctx, period: "today" | "week" | "month"): Promise<Reply> {
  const { lang } = ctx;
  const rows = await ctx.deps.repo.summary(ctx.user.id, periodStart(period, ctx.now));
  const people = [...balances(await ctx.deps.repo.debts(ctx.user.id)).values()];
  const periodLabel = t(lang, `period_${period}`);
  const sections: string[] = [];

  // The voice note says the totals only; the text carries the detail.
  const spoken: string[] = [t(lang, "summary_spoken_title", { period: periodLabel })];

  const sales = totalOf(rows, "sale");
  const costs = sumOf(rows, isBusinessCost);
  if (sales > 0 || costs > 0) {
    spoken.push(t(lang, "summary_spoken_business", { sales: formatNaira(sales), costs: formatNaira(costs) }));
    sections.push(
      t(lang, "summary_business", {
        sales: formatNaira(sales),
        sales_n: rows.filter((r) => r.kind === "sale").reduce((a, r) => a + r.n, 0),
        costs: formatNaira(costs),
        profit: formatNaira(sales - costs),
      }),
    );
  }

  const income = totalOf(rows, "income");
  const spent = sumOf(rows, isPersonalSpend);
  if (income > 0 || spent > 0) {
    spoken.push(t(lang, "summary_spoken_personal", { income: formatNaira(income), spent: formatNaira(spent) }));
    const byCategory = new Map<string, number>();
    for (const r of rows.filter(isPersonalSpend)) byCategory.set(r.category ?? "other", (byCategory.get(r.category ?? "other") ?? 0) + r.total);
    const top = [...byCategory]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c, v]) => `${categoryLabel(lang, c)} ${formatNaira(v)}`)
      .join(", ");
    let text = t(lang, "summary_personal", { income: formatNaira(income), spent: formatNaira(spent), left: formatNaira(income - spent) });
    if (top) text += `\n${t(lang, "summary_top", { list: top })}`;
    sections.push(text);
  }

  const owedToMe = people.filter((p) => p.toMe > 0).sort((a, b) => b.toMe - a.toMe);
  const iOwe = people.filter((p) => p.iOwe > 0).sort((a, b) => b.iOwe - a.iOwe);
  if (owedToMe.length > 0 || iOwe.length > 0) {
    spoken.push(
      t(lang, "summary_spoken_debts", {
        owed_to_me: formatNaira(owedToMe.reduce((a, p) => a + p.toMe, 0)),
        i_owe: formatNaira(iOwe.reduce((a, p) => a + p.iOwe, 0)),
      }),
    );
    const names = (list: typeof people, pick: (p: (typeof people)[number]) => number) =>
      list.length === 0 ? "" : ` (${list.slice(0, 3).map((p) => `${p.name ?? t(lang, "someone")} ${formatNaira(pick(p))}`).join(", ")})`;
    sections.push(
      t(lang, "summary_debts", {
        owed_to_me: formatNaira(owedToMe.reduce((a, p) => a + p.toMe, 0)) + names(owedToMe, (p) => p.toMe),
        i_owe: formatNaira(iOwe.reduce((a, p) => a + p.iOwe, 0)) + names(iOwe, (p) => p.iOwe),
      }),
    );
  }

  if (sections.length === 0) return { text: t(lang, "summary_empty", { period: periodLabel }), voice: true };
  const text = [t(lang, "summary_title", { period: periodLabel }), ...sections, t(lang, "summary_share")].join("\n\n");
  return { text, spoken: spoken.join(" "), voice: true, autoTipTopic: "cash_flow" };
}
