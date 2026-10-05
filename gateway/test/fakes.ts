import type { Repo, SummaryRow, TipRow, UserRow } from "../src/db/repo.js";
import type { EngineApi } from "../src/engine/client.js";
import type { Deps } from "../src/pipeline/context.js";
import type { WhatsAppApi } from "../src/whatsapp/client.js";
import type { InboundMessage } from "../src/whatsapp/types.js";

export const TIPS: TipRow[] = [
  { id: "record_keeping_01", topic: "record_keeping", text_en: "Record every sale the same day.", text_yo: null, text_ha: null, text_ig: null },
  { id: "savings_01", topic: "savings", text_en: "Save a little every day.", text_yo: "Fi owó díẹ̀ pamọ́ lójoojúmọ́.", text_ha: null, text_ig: null },
];

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
      state.messages.push({ id, ...row });
      return id;
    },
    async updateMessage(id, patch) {
      Object.assign(state.messages.find((m) => m.id === id) ?? {}, patch);
    },
    async insertOutbound(row) {
      state.outbound.push(row);
    },
    async insertTransaction(row) {
      state.txns.push(row);
    },
    async insertLoanIntake(row) {
      state.loans.push(row);
    },
    async summary(userId) {
      const out = new Map<string, SummaryRow>();
      for (const t of state.txns.filter((t) => t.user_id === userId)) {
        const r = out.get(t.kind) ?? { kind: t.kind, total: 0, n: 0 };
        r.total += t.amount_ngn ?? 0;
        r.n++;
        out.set(t.kind, r);
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
  const engine: EngineApi & { routeResult: unknown } = {
    routeResult,
    async transcribe() {
      calls.push("transcribe");
      return { text: transcript, seconds: 4.2 };
    },
    async route() {
      calls.push("route");
      return engine.routeResult;
    },
    async adapt({ tip }) {
      calls.push("adapt");
      return `Adapted: ${tip}`;
    },
    async translate(text) {
      return text;
    },
    async speak() {
      calls.push("speak");
      return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    },
  };
  return { engine, calls };
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
    voiceReplies: true,
    now: () => new Date("2026-10-04T10:00:00Z"),
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
