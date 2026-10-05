import type { SummaryRow, TxnKind } from "../db/repo.js";
import type { Intent } from "../domain/intents.js";
import { formatNaira } from "../domain/money.js";
import { periodStart } from "../domain/time.js";
import { t } from "../locales/index.js";
import type { Ctx, Reply } from "./context.js";

function describe(i: Intent): string {
  const what = [i.quantity != null ? String(i.quantity) : null, i.unit, i.item].filter(Boolean).join(" ");
  return what ? `${what} — ` : "";
}

const totalOf = (rows: SummaryRow[], kind: TxnKind) => rows.find((r) => r.kind === kind)?.total ?? 0;

async function record(ctx: Ctx, kind: TxnKind, i: Intent): Promise<void> {
  await ctx.deps.repo.insertTransaction({
    user_id: ctx.user.id,
    message_id: ctx.messageId,
    kind,
    item: i.item,
    qty: i.quantity,
    unit: i.unit,
    amount_ngn: i.amount_ngn,
    counterparty: i.counterparty,
  });
}

export async function applyCommerce(ctx: Ctx, i: Intent): Promise<Reply | null> {
  const { lang } = ctx;
  const { repo } = ctx.deps;

  switch (i.intent) {
    case "log_sale":
    case "log_expense": {
      if (i.amount_ngn == null) return { text: t(lang, "need_amount"), voice: true };
      const kind = i.intent === "log_sale" ? "sale" : "expense";
      await record(ctx, kind, i);
      const today = await repo.summary(ctx.user.id, periodStart("today", ctx.now));
      return {
        text: t(lang, kind === "sale" ? "sale_logged" : "expense_logged", {
          what: describe(i),
          amount: formatNaira(i.amount_ngn),
          today_total: formatNaira(totalOf(today, kind)),
        }),
        voice: false,
        autoTipTopic: kind === "sale" ? "record_keeping" : "separate_money",
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

    case "stock_update": {
      if (!i.item) return { text: t(lang, "need_item"), voice: true };
      await record(ctx, "stock", i);
      const qty = [i.quantity != null ? String(i.quantity) : "", i.unit ?? ""].filter(Boolean).join(" ");
      return { text: t(lang, "stock_logged", { qty, item: i.item }), voice: false, autoTipTopic: "pricing" };
    }

    case "summary_query": {
      const period = i.period ?? "today";
      const rows = await repo.summary(ctx.user.id, periodStart(period, ctx.now));
      const periodLabel = t(lang, `period_${period}`);
      if (rows.length === 0) return { text: t(lang, "summary_empty", { period: periodLabel }), voice: true };
      const sales = totalOf(rows, "sale");
      const expenses = totalOf(rows, "expense");
      const text = t(lang, "summary", {
        period: periodLabel,
        sales: formatNaira(sales),
        sales_n: rows.find((r) => r.kind === "sale")?.n ?? 0,
        expenses: formatNaira(expenses),
        profit: formatNaira(sales - expenses),
        owed_to_me: formatNaira(totalOf(rows, "debt_owed_to_me")),
        i_owe: formatNaira(totalOf(rows, "debt_i_owe")),
      });
      return { text, voice: true, autoTipTopic: "cash_flow" };
    }

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
