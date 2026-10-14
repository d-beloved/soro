import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Lang, TipTopic } from "../domain/intents.js";

export type TxnKind =
  | "sale"
  | "expense"
  | "income"
  | "debt_owed_to_me"
  | "debt_i_owe"
  | "debt_paid_to_me"
  | "debt_i_paid"
  | "stock";

export interface TxnRow {
  id: string;
  kind: TxnKind;
  item: string | null;
  qty: number | null;
  unit: string | null;
  amount_ngn: number | null;
  counterparty: string | null;
  category: string | null;
}

export type TxnPatch = Partial<Pick<TxnRow, "kind" | "item" | "amount_ngn" | "counterparty" | "category">>;

export interface UserRow {
  id: string;
  language: Lang | null;
  consent_at: string | null;
  ref_source: string | null;
}

export interface TipRow {
  id: string;
  topic: TipTopic;
  text_en: string;
  text_yo: string | null;
  text_ha: string | null;
  text_ig: string | null;
}

export interface MessagePatch {
  transcript?: string | null;
  audio_seconds?: number | null;
  language?: Lang | null;
  intent?: string | null;
  payload?: unknown;
  latency_ms?: number;
  error?: string | null;
}

export interface SummaryRow {
  kind: TxnKind;
  category: string | null;
  total: number;
  n: number;
}

/** All-time debt total for one person and one debt kind. */
export interface DebtRow {
  counterparty: string | null;
  kind: TxnKind;
  total: number;
}

/** A reminder waiting to go out; the phone number is sealed (lib/seal.ts). */
export interface PendingNudge {
  user_id: string;
  phone_enc: string;
  language: Lang;
  due_at: string;
  expires_at: string;
}

export interface Repo {
  getOrCreateUser(phoneHash: string, refSource: string | null): Promise<UserRow>;
  setConsent(userId: string): Promise<void>;
  setLanguage(userId: string, lang: Lang): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  /** Returns the new row id, or null if this WhatsApp message was already processed (webhook retry). */
  insertInbound(row: { wa_message_id: string; user_id: string; type: string; language: Lang | null }): Promise<string | null>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  /** When we last handled one of this user's messages with this intent. */
  lastIntentAt(userId: string, intent: string): Promise<Date | null>;
  insertOutbound(row: { user_id: string; type: string; language: Lang; payload?: unknown }): Promise<void>;
  insertTransaction(row: {
    user_id: string;
    message_id: string;
    kind: TxnKind;
    item: string | null;
    qty: number | null;
    unit: string | null;
    amount_ngn: number | null;
    counterparty: string | null;
    category: string | null;
  }): Promise<void>;
  /** The user's most recent record that has not been undone. */
  lastTransaction(userId: string): Promise<TxnRow | null>;
  voidTransaction(id: string): Promise<void>;
  updateTransaction(id: string, patch: TxnPatch): Promise<void>;
  debts(userId: string): Promise<DebtRow[]>;
  setBudget(userId: string, category: string, amountNgn: number): Promise<void>;
  budgets(userId: string): Promise<{ category: string; amount_ngn: number }[]>;
  /** How many people consented after arriving through this share code. */
  countReferrals(code: string): Promise<number>;
  insertLoanIntake(row: {
    user_id: string;
    message_id: string;
    amount_ngn: number | null;
    purpose: string | null;
    monthly_sales_ngn: number | null;
  }): Promise<void>;
  summary(userId: string, since: Date): Promise<SummaryRow[]>;
  /** A tip on this topic (or any topic) the user has not heard yet; least-recent if all heard. */
  pickTip(userId: string, topic: TipTopic | null): Promise<TipRow | null>;
  lastTipAt(userId: string): Promise<Date | null>;
  insertTipDelivery(row: { user_id: string; tip_id: string; message_id: string; trigger: "asked" | "auto"; audio_sent: boolean }): Promise<void>;
  /** Marks the user reminded, if they have never recorded anything and were not reminded before; false otherwise. */
  claimNudge(userId: string): Promise<boolean>;
  /** Starts the user's reminder clock if they could still be reminded; otherwise drops any pending one. */
  scheduleNudge(row: Omit<PendingNudge, "due_at" | "expires_at"> & { due_at: Date; expires_at: Date }): Promise<void>;
  cancelNudge(userId: string): Promise<void>;
  /** Removes and returns every reminder due by `now`: whoever takes a row sends it, so no two gateways both do. */
  takeDueNudges(now: Date): Promise<PendingNudge[]>;
}

const UNIQUE_VIOLATION = "23505";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new Error(`supabase: ${res.error.message}`);
  return res.data;
}

export function createRepo(url: string, serviceRoleKey: string): Repo {
  const db: SupabaseClient = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let tipCache: { at: number; tips: TipRow[] } | null = null;
  async function allTips(): Promise<TipRow[]> {
    if (tipCache && Date.now() - tipCache.at < 10 * 60_000) return tipCache.tips;
    const tips = check(await db.from("tips").select("id, topic, text_en, text_yo, text_ha, text_ig").order("id")) as TipRow[];
    tipCache = { at: Date.now(), tips };
    return tips;
  }

  const userCols = "id, language, consent_at, ref_source";

  return {
    async getOrCreateUser(phoneHash, refSource) {
      const existing = check(await db.from("users").select(userCols).eq("phone_hash", phoneHash).maybeSingle()) as UserRow | null;
      if (existing) {
        check(await db.from("users").update({ last_seen_at: new Date().toISOString() }).eq("id", existing.id));
        return existing;
      }
      const res = await db.from("users").insert({ phone_hash: phoneHash, ref_source: refSource }).select(userCols).single();
      if (res.error?.code === UNIQUE_VIOLATION) {
        return check(await db.from("users").select(userCols).eq("phone_hash", phoneHash).single()) as UserRow;
      }
      return check(res) as UserRow;
    },

    async setConsent(userId) {
      check(await db.from("users").update({ consent_at: new Date().toISOString() }).eq("id", userId));
    },

    async setLanguage(userId, lang) {
      check(await db.from("users").update({ language: lang }).eq("id", userId));
    },

    async deleteUser(userId) {
      // Erases the user and everything they sent; keeps a bare, unlinkable row per message (0006_anonymise_on_delete.sql).
      check(await db.rpc("erase_user", { p_user: userId }));
    },

    async insertInbound(row) {
      const res = await db.from("messages").insert({ ...row, direction: "in" }).select("id").single();
      if (res.error?.code === UNIQUE_VIOLATION) return null;
      return (check(res) as { id: string }).id;
    },

    async updateMessage(id, patch) {
      check(await db.from("messages").update(patch).eq("id", id));
    },

    async lastIntentAt(userId, intent) {
      const row = check(
        await db
          .from("messages")
          .select("created_at")
          .eq("user_id", userId)
          .eq("intent", intent)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as { created_at: string } | null;
      return row ? new Date(row.created_at) : null;
    },

    async insertOutbound(row) {
      check(await db.from("messages").insert({ ...row, direction: "out" }));
    },

    async insertTransaction(row) {
      check(await db.from("transactions").insert(row));
    },

    async lastTransaction(userId) {
      const row = check(
        await db
          .from("transactions")
          .select("id, kind, item, qty, unit, amount_ngn, counterparty, category")
          .eq("user_id", userId)
          .is("voided_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as TxnRow | null;
      return row && { ...row, qty: row.qty == null ? null : Number(row.qty), amount_ngn: row.amount_ngn == null ? null : Number(row.amount_ngn) };
    },

    async voidTransaction(id) {
      check(await db.from("transactions").update({ voided_at: new Date().toISOString() }).eq("id", id));
    },

    async updateTransaction(id, patch) {
      check(await db.from("transactions").update(patch).eq("id", id));
    },

    async debts(userId) {
      const rows = check(await db.rpc("debts_for", { p_user: userId })) as
        | { counterparty: string | null; kind: TxnKind; total: number | string }[]
        | null;
      return (rows ?? []).map((r) => ({ counterparty: r.counterparty, kind: r.kind, total: Number(r.total) }));
    },

    async setBudget(userId, category, amountNgn) {
      check(
        await db
          .from("budgets")
          .upsert({ user_id: userId, category, amount_ngn: amountNgn, updated_at: new Date().toISOString() }, { onConflict: "user_id,category" }),
      );
    },

    async budgets(userId) {
      const rows = check(await db.from("budgets").select("category, amount_ngn").eq("user_id", userId)) as
        | { category: string; amount_ngn: number | string }[]
        | null;
      return (rows ?? []).map((r) => ({ category: r.category, amount_ngn: Number(r.amount_ngn) }));
    },

    async countReferrals(code) {
      const res = await db.from("users").select("id", { count: "exact", head: true }).eq("ref_source", code).not("consent_at", "is", null);
      check(res);
      return res.count ?? 0;
    },

    async insertLoanIntake(row) {
      check(await db.from("loan_intakes").insert(row));
    },

    async summary(userId, since) {
      const rows = check(await db.rpc("summary_for", { p_user: userId, p_since: since.toISOString() })) as
        | { kind: TxnKind; category: string | null; total: number | string; n: number | string }[]
        | null;
      return (rows ?? []).map((r) => ({ kind: r.kind, category: r.category, total: Number(r.total), n: Number(r.n) }));
    },

    async pickTip(userId, topic) {
      const tips = (await allTips()).filter((t) => !topic || t.topic === topic);
      if (tips.length === 0) return null;
      const heard = check(
        await db.from("tip_deliveries").select("tip_id, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
      ) as { tip_id: string }[];
      const heardIds = heard.map((h) => h.tip_id);
      const fresh = tips.filter((t) => !heardIds.includes(t.id));
      if (fresh.length > 0) return fresh[Math.floor(Math.random() * fresh.length)] ?? null;
      // All heard: the one heard longest ago.
      return [...tips].sort((a, b) => heardIds.indexOf(b.id) - heardIds.indexOf(a.id))[0] ?? null;
    },

    async lastTipAt(userId) {
      const row = check(
        await db.from("tip_deliveries").select("created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ) as { created_at: string } | null;
      return row ? new Date(row.created_at) : null;
    },

    async insertTipDelivery(row) {
      check(await db.from("tip_deliveries").insert(row));
    },

    async claimNudge(userId) {
      // Undone records count: whoever recorded and undid one already knows how.
      const res = await db.from("transactions").select("id", { count: "exact", head: true }).eq("user_id", userId);
      check(res);
      if ((res.count ?? 0) > 0) return false;
      const rows = check(
        await db.from("users").update({ nudged_at: new Date().toISOString() }).eq("id", userId).is("nudged_at", null).select("id"),
      ) as { id: string }[] | null;
      return (rows ?? []).length > 0;
    },

    async scheduleNudge(row) {
      check(
        await db.rpc("schedule_nudge", {
          p_user: row.user_id,
          p_phone_enc: row.phone_enc,
          p_language: row.language,
          p_due: row.due_at.toISOString(),
          p_expires: row.expires_at.toISOString(),
        }),
      );
    },

    async cancelNudge(userId) {
      check(await db.from("pending_nudges").delete().eq("user_id", userId));
    },

    async takeDueNudges(now) {
      return (check(
        await db.from("pending_nudges").delete().lte("due_at", now.toISOString()).select("user_id, phone_enc, language, due_at, expires_at"),
      ) ?? []) as PendingNudge[];
    },
  };
}
