// Lists the messages users corrected (UNDO, "no be 5k, na 50k") next to what the bot heard and how N-ATLaS
// read them, plus the messages it could not understand. Read it to fix the router's examples and rules.
// Usage: npm run review:corrections   -> ../exports/corrections_<date>.md (holds transcripts: keep it local)
//        npm run review:corrections -- --days 1   only what users corrected in the last day (the daily email)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { findCorrections, findUnknowns, likelyCause, type Cause, type Correction, type LoggedMessage } from "../domain/corrections.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const db = createClient(url, key, { auth: { persistSession: false } });

const { values } = parseArgs({ options: { days: { type: "string" } } });
const days = Number(values.days ?? 0);
const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null;
const recent = (m: { created_at: string }) => !since || new Date(m.created_at) >= since;

async function all<T>(table: string, columns: string, inboundOnly = false): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns).order("created_at").range(from, from + 999);
    if (inboundOnly) q = q.eq("direction", "in");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return rows;
}

const messages = await all<LoggedMessage>("messages", "id, user_id, created_at, type, language, transcript, intent, payload", true);
const records = await all<{ message_id: string }>("transactions", "message_id, created_at");
// Every message is replayed (a fix today can point at an older record); only the window is reported.
const corrections = findCorrections(messages, new Set(records.map((r) => r.message_id))).filter((c) => recent(c.fix));
const unknowns = findUnknowns(messages).filter(recent);
const inWindow = messages.filter(recent).length;

const when = (m: LoggedMessage) => new Date(m.created_at).toLocaleString("en-GB", { timeZone: "Africa/Lagos" });
const quote = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() : "(none)");
const read = (m: LoggedMessage) => {
  const { intent: _, ...fields } = (m.payload ?? {}) as Record<string, unknown>;
  const set = Object.entries(fields).filter(([, v]) => v != null);
  return `${m.intent}${set.length ? " " + JSON.stringify(Object.fromEntries(set)) : ""}`;
};

const CAUSE: Record<Cause, string> = {
  router: "N-ATLaS misread it (the right answer was in what it heard): add an example or rule",
  asr: "the speech model probably misheard (the right amount is not in what it heard)",
  unclear: "unclear: a person decides (mishearing, misreading, or the user changed their mind)",
};

function correctionBlock(c: Correction, n: number): string {
  const what = c.kind === "undo" ? "Undone" : `Fixed to \`${JSON.stringify(c.right)}\``;
  return [
    `### ${n}. ${what} (${c.original.language ?? "?"}, ${c.original.type})`,
    "",
    `- **Heard** (${when(c.original)}): ${quote(c.original.transcript)}`,
    `- **N-ATLaS read it as:** \`${read(c.original)}\``,
    `- **User then said:** ${quote(c.fix.transcript)}`,
    `- **Likely cause:** ${CAUSE[likelyCause(c)]}`,
    "",
  ].join("\n");
}

function byLang(list: LoggedMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of list) counts.set(m.language ?? "?", (counts.get(m.language ?? "?") ?? 0) + 1);
  return [...counts].map(([lang, n]) => `${lang} ${n}`).join(", ");
}

const md = [
  `# Corrections review, ${new Date().toISOString().slice(0, 10)}${days > 0 ? ` (last ${days} day${days === 1 ? "" : "s"})` : ""}`,
  "",
  `${inWindow} inbound messages. ${corrections.length} corrected (${corrections.filter((c) => c.kind === "undo").length} undone, ` +
    `${corrections.filter((c) => c.kind === "fix").length} fixed). ${unknowns.length} not understood.`,
  "",
  `Likely causes: ${(["router", "asr", "unclear"] as const).map((k) => `${k} ${corrections.filter((c) => likelyCause(c) === k).length}`).join(", ")}.`,
  "",
  `Corrected by language: ${byLang(corrections.map((c) => c.original)) || "none"}. Not understood by language: ${byLang(unknowns) || "none"}.`,
  "",
  "For each one, decide the cause. A mishearing points at the speech model; a misreading becomes a new",
  "example or rule in engine/soro_engine/prompts.py or amounts.py.",
  "",
  "## Corrected",
  "",
  ...(corrections.length ? corrections.map((c, i) => correctionBlock(c, i + 1)) : ["None yet.", ""]),
  "## Not understood",
  "",
  ...(unknowns.length
    ? unknowns.map((m) => `- ${when(m)} (${m.language ?? "?"}, ${m.type}): ${quote(m.transcript)}`)
    : ["None yet."]),
  "",
].join("\n");

const dir = resolve(import.meta.dirname, "../../../exports");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `corrections_${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, md);
console.log(`${corrections.length} corrections and ${unknowns.length} unknowns from ${inWindow} messages -> ${file}`);

// In GitHub Actions: tell the workflow where the report is and whether there is anything to send.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `file=${file}\nfound=${corrections.length + unknowns.length}\n`);
}
