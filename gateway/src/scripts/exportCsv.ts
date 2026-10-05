// Exports the NAIC "documented real-user interactions" log as CSV.
// Usage: npm run export:csv   -> ../exports/naic_interactions_<date>.csv
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const db = createClient(url, key, { auth: { persistSession: false } });

const rows: Record<string, unknown>[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("naic_interactions").select("*").range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...data);
  if (data.length < 1000) break;
}

function cell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const headers = Object.keys(rows[0] ?? { interaction_id: "" });
const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\n");

const dir = resolve(import.meta.dirname, "../../../exports");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `naic_interactions_${new Date().toISOString().slice(0, 10)}.csv`);
writeFileSync(file, csv + "\n");

const users = new Set(rows.map((r) => r.user_id)).size;
console.log(`Wrote ${rows.length} interactions from ${users} users to ${file}`);
