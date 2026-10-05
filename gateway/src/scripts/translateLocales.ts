// Drafts yo/ha/ig UI strings from en.json using the engine's N-ATLaS /translate endpoint.
// Keeps any key whose {placeholders} the model dropped out of the file (falls back to English).
// Usage: npm run locales:translate   (engine must be running; then get native speakers to review)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEngineClient } from "../engine/client.js";

const engine = createEngineClient({ baseUrl: process.env.ENGINE_URL ?? "http://localhost:8000", token: process.env.ENGINE_TOKEN ?? "" });
const dir = resolve(import.meta.dirname, "../locales");
const en = JSON.parse(readFileSync(resolve(dir, "en.json"), "utf8")) as Record<string, string>;

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

for (const lang of ["yo", "ha", "ig"] as const) {
  const path = resolve(dir, `${lang}.json`);
  const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  for (const [key, text] of Object.entries(en)) {
    if (existing[key]) continue; // never overwrite reviewed strings
    const out = await engine.translate(text, lang);
    if (placeholders(out) !== placeholders(text)) {
      console.warn(`[${lang}] ${key}: placeholders changed, skipped`);
      continue;
    }
    existing[key] = out;
    console.log(`[${lang}] ${key}`);
  }
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
}
