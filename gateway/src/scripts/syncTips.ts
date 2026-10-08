// Uploads the hand-written tip translations.
// Input: ../supabase/seed/tip_translations.json  { "<tip_id>": { "yo": "...", "ha": "...", "ig": "..." } }
// Only fills text_<lang>; set reviewed.<lang>=true in the dashboard after a native speaker checks it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const db = createClient(url, key, { auth: { persistSession: false } });

const file = resolve(import.meta.dirname, "../../../supabase/seed/tip_translations.json");
const translations = JSON.parse(readFileSync(file, "utf8")) as Record<string, Partial<Record<"yo" | "ha" | "ig", string>>>;

let updated = 0;
for (const [id, langs] of Object.entries(translations)) {
  const patch: Record<string, string> = {};
  for (const [lang, text] of Object.entries(langs)) if (text) patch[`text_${lang}`] = text;
  if (Object.keys(patch).length === 0) continue;
  const { error } = await db.from("tips").update(patch).eq("id", id);
  if (error) throw new Error(`${id}: ${error.message}`);
  updated++;
}
console.log(`Updated translations for ${updated} tips`);
