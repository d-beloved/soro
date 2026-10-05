import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Lang, TipTopic } from "../domain/intents.js";

export type TxnKind = "sale" | "expense" | "debt_owed_to_me" | "debt_i_owe" | "stock";

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
  total: number;
  n: number;
}

export interface Repo {
  getOrCreateUser(phoneHash: string, refSource: string | null): Promise<UserRow>;
  setConsent(userId: string): Promise<void>;
  setLanguage(userId: string, lang: Lang): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  /** Returns the new row id, or null if this WhatsApp message was already processed (webhook retry). */
  insertInbound(row: { wa_message_id: string; user_id: string; type: string; language: Lang | null }): Promise<string | null>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
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
  }): Promise<void>;
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
      // Cascades to messages, transactions, loan_intakes, tip_deliveries.
      check(await db.from("users").delete().eq("id", userId));
    },

    async insertInbound(row) {
      const res = await db.from("messages").insert({ ...row, direction: "in" }).select("id").single();
      if (res.error?.code === UNIQUE_VIOLATION) return null;
      return (check(res) as { id: string }).id;
    },

    async updateMessage(id, patch) {
      check(await db.from("messages").update(patch).eq("id", id));
    },

    async insertOutbound(row) {
      check(await db.from("messages").insert({ ...row, direction: "out" }));
    },

    async insertTransaction(row) {
      check(await db.from("transactions").insert(row));
    },

    async insertLoanIntake(row) {
      check(await db.from("loan_intakes").insert(row));
    },

    async summary(userId, since) {
      const rows = check(await db.rpc("summary_for", { p_user: userId, p_since: since.toISOString() })) as
        | { kind: TxnKind; total: number | string; n: number | string }[]
        | null;
      return (rows ?? []).map((r) => ({ kind: r.kind, total: Number(r.total), n: Number(r.n) }));
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
  };
}
