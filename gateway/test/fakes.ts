import type { DebtRow, Repo, SummaryRow, TipRow, UserRow } from "../src/db/repo.js";
import type { Lang } from "../src/domain/intents.js";
import type { EngineApi } from "../src/engine/client.js";
import type { Deps } from "../src/pipeline/context.js";
import type { WhatsAppApi } from "../src/whatsapp/client.js";
import type { InboundMessage } from "../src/whatsapp/types.js";

export const TIPS: TipRow[] = [
  { id: "record_keeping_01", topic: "record_keeping", text_en: "Record every sale the same day.", text_yo: null, text_ha: null, text_ig: null },
  { id: "savings_01", topic: "savings", text_en: "Save a little every day.", text_yo: "Fi owó díẹ̀ pamọ́ lójoojúmọ́.", text_ha: null, text_ig: null },
];

/** The fixed clock for handled messages; makeDeps uses it for `now`. */
export const FAKE_NOW = "2026-10-04T10:00:00Z";

export function fakeRepo() {
  const users = new Map<string, UserRow & { phone_hash: string }>();
  const seenWa = new Set<string>();
  const state = {
    users,
    messages: [] as any[],
    outbound: [] as any[],
    txns: [] as any[],
    loans: [] as any[],
    tipDeliveries: [] as any[],
    budgets: new Map<string, number>(),
  };
  let n = 0;
  const repo: Repo = {
    async getOrCreateUser(phoneHash, refSource) {
      const existing = [...users.values()].find((u) => u.phone_hash === phoneHash);
      if (existing) return { ...existing };
      const u = { id: `u${++n}`, phone_hash: phoneHash, language: null, consent_at: null, ref_source: refSource };
      users.set(u.id, u);
      return { ...u };
    },
    async setConsent(id) {
      users.get(id)!.consent_at = "2026-10-04T10:00:00Z";
    },
    async setLanguage(id, lang) {
      users.get(id)!.language = lang;
    },
    async deleteUser(id) {
      users.delete(id);
    },
    async insertInbound(row) {
      if (seenWa.has(row.wa_message_id)) return null;
      seenWa.add(row.wa_message_id);
      const id = `m${++n}`;
      state.messages.push({ id, created_at: FAKE_NOW, ...row });
      return id;
    },
    async updateMessage(id, patch) {
      Object.assign(state.messages.find((m) => m.id === id) ?? {}, patch);
    },
    async lastIntentAt(userId, intent) {
      const row = state.messages.filter((m) => m.user_id === userId && m.intent === intent).at(-1);
      return row ? new Date(row.created_at) : null;
    },
    async insertOutbound(row) {
      state.outbound.push(row);
    },
    async insertTransaction(row) {
      state.txns.push({ id: `t${++n}`, voided_at: null, ...row });
    },
    async lastTransaction(userId) {
      return state.txns.filter((t) => t.user_id === userId && !t.voided_at).at(-1) ?? null;
    },
    async voidTransaction(id) {
      state.txns.find((t) => t.id === id).voided_at = "2026-10-04T10:00:00Z";
    },
    async updateTransaction(id, patch) {
      Object.assign(state.txns.find((t) => t.id === id), patch);
    },
    async debts(userId) {
      const out = new Map<string, DebtRow>();
      for (const t of state.txns.filter((t) => t.user_id === userId && !t.voided_at && t.kind.startsWith("debt"))) {
        const key = `${(t.counterparty ?? "").toLowerCase()}|${t.kind}`;
        const r = out.get(key) ?? { counterparty: t.counterparty, kind: t.kind, total: 0 };
        r.total += t.amount_ngn ?? 0;
        out.set(key, r);
      }
      return [...out.values()];
    },
    async setBudget(userId, category, amount) {
      state.budgets.set(`${userId}|${category}`, amount);
    },
    async budgets(userId) {
      return [...state.budgets]
        .filter(([k]) => k.startsWith(`${userId}|`))
        .map(([k, amount_ngn]) => ({ category: k.split("|")[1]!, amount_ngn }));
    },
    async countReferrals(code) {
      return [...users.values()].filter((u) => u.ref_source === code && u.consent_at).length;
    },
    async insertLoanIntake(row) {
      state.loans.push(row);
    },
    async summary(userId) {
      const out = new Map<string, SummaryRow>();
      for (const t of state.txns.filter((t) => t.user_id === userId && !t.voided_at)) {
        const key = `${t.kind}|${t.category}`;
        const r = out.get(key) ?? { kind: t.kind, category: t.category ?? null, total: 0, n: 0 };
        r.total += t.amount_ngn ?? 0;
        r.n++;
        out.set(key, r);
      }
      return [...out.values()];
    },
    async pickTip(_userId, topic) {
      return TIPS.find((t) => !topic || t.topic === topic) ?? null;
    },
    async lastTipAt(userId) {
      return state.tipDeliveries.some((d) => d.user_id === userId) ? new Date("2026-10-04T09:00:00Z") : null;
    },
    async insertTipDelivery(row) {
      state.tipDeliveries.push(row);
    },
  };
  return { repo, state };
}

export function fakeWa() {
  const sent: { kind: string; to: string; body?: string; ids?: string[] }[] = [];
  const wa: WhatsAppApi = {
    async sendText(to, body) {
      sent.push({ kind: "text", to, body });
      return "wamid.out";
    },
    async sendButtons(to, body, buttons) {
      sent.push({ kind: "buttons", to, body, ids: buttons.map((b) => b.id) });
      return "wamid.out";
    },
    async sendList(to, body, _label, rows) {
      sent.push({ kind: "list", to, body, ids: rows.map((r) => r.id) });
      return "wamid.out";
    },
    async sendVoice(to) {
      sent.push({ kind: "voice", to });
      return "wamid.out";
    },
    async downloadMedia() {
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg; codecs=opus" };
    },
    async markRead() {},
  };
  return { wa, sent };
}

export function fakeEngine(routeResult: unknown = { intent: "unknown" }, transcript = "I sell 3 bags of rice 75k") {
  const calls: string[] = [];
  /** What each voice reply said. */
  const spoken: string[] = [];
  const engine: EngineApi & { routeResult: unknown; heardLang: Lang | null } = {
    routeResult,
    /** Set to make the next voice notes sound like another language. */
    heardLang: null,
    async transcribe(_audio, _mime, lang) {
      calls.push("transcribe");
      return { text: transcript, seconds: 4.2, lang: engine.heardLang ?? lang };
    },
    async route() {
      calls.push("route");
      return engine.routeResult;
    },
    async adapt({ tip }) {
      calls.push("adapt");
      return `Adapted: ${tip}`;
    },
    async speak(text) {
      calls.push("speak");
      spoken.push(text);
      return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    },
  };
  return { engine, calls, spoken };
}

export function makeDeps(overrides: Partial<Deps> = {}) {
  const r = fakeRepo();
  const w = fakeWa();
  const e = fakeEngine();
  const deps: Deps = {
    wa: w.wa,
    engine: e.engine,
    repo: r.repo,
    log: { info() {}, warn() {}, error() {} } as unknown as Deps["log"],
    phoneSalt: "test-salt-test-salt",
    privacyUrl: "https://soro.charavol.com/privacy",
    publicNumber: "2349077485454",
    voiceReplies: true,
    now: () => new Date(FAKE_NOW),
    ...overrides,
  };
  return { deps, ...r, ...w, ...e };
}

let seq = 0;
export const PHONE = "2348031234567";
export function text(body: string): InboundMessage {
  return { from: PHONE, id: `wamid.in${++seq}`, timestamp: "1791100000", type: "text", text: { body } };
}
export function tap(id: string): InboundMessage {
  return { from: PHONE, id: `wamid.in${++seq}`, timestamp: "1791100000", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } };
}
export function pick(id: string): InboundMessage {
  return { from: PHONE, id: `wamid.in${++seq}`, timestamp: "1791100000", type: "interactive", interactive: { type: "list_reply", list_reply: { id, title: id } } };
}
export function voice(): InboundMessage {
  return { from: PHONE, id: `wamid.in${++seq}`, timestamp: "1791100000", type: "audio", audio: { id: "media123", mime_type: "audio/ogg; codecs=opus", voice: true } };
}
