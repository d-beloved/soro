import en from "./en.json" with { type: "json" };
import yo from "./yo.json" with { type: "json" };
import ha from "./ha.json" with { type: "json" };
import ig from "./ig.json" with { type: "json" };
import type { Lang } from "../domain/intents.js";

// en.json is the master. yo/ha/ig are drafted by N-ATLaS (npm run locales:translate)
// and reviewed by native speakers. Missing keys fall back to English.

export type MsgKey = keyof typeof en;

const tables: Record<Lang, Partial<Record<MsgKey, string>>> = { en, yo, ha, ig };

export function t(lang: Lang, key: MsgKey, vars: Record<string, string | number> = {}): string {
  const template = tables[lang][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}

export const english = en;

/** Shown before the user has picked a language, so it is written in all four. */
export const LANGUAGE_PROMPT =
  "Which language do you want? 🗣️\nÈdè wo lo fẹ́ lò?\nWane harshe kake so?\nKedu asụsụ ị chọrọ?";

export const LANGUAGE_ROWS: { id: `lang_${Lang}`; title: string; description: string }[] = [
  { id: "lang_en", title: "English / Pidgin", description: "Nigerian English and Pidgin" },
  { id: "lang_yo", title: "Yorùbá", description: "Èdè Yorùbá" },
  { id: "lang_ha", title: "Hausa", description: "Harshen Hausa" },
  { id: "lang_ig", title: "Igbo", description: "Asụsụ Igbo" },
];
