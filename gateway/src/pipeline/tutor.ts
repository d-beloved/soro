import type { TipRow } from "../db/repo.js";
import type { Lang, TipTopic } from "../domain/intents.js";
import { t } from "../locales/index.js";
import type { Ctx, Reply } from "./context.js";

function storedText(tip: TipRow, lang: Lang): string {
  if (lang === "en") return tip.text_en;
  return tip[`text_${lang}`] ?? tip.text_en;
}

/**
 * Voice Tutor: answers a money question by grounding N-ATLaS in one curated, reviewed tip,
 * so the model rephrases trusted advice instead of inventing financial guidance.
 */
export async function answerQuestion(ctx: Ctx, topic: TipTopic | null, question: string): Promise<Reply | null> {
  const tip = await ctx.deps.repo.pickTip(ctx.user.id, topic);
  if (!tip) return null;
  let body: string;
  try {
    body = await ctx.deps.engine.adapt({ tip: tip.text_en, question, lang: ctx.lang });
  } catch (err) {
    ctx.deps.log.warn({ err }, "adapt failed; using stored tip");
    body = storedText(tip, ctx.lang);
  }
  return { text: `${t(ctx.lang, "tip_header")}\n${body}`, spoken: body, voice: true, tip: { id: tip.id, trigger: "asked" } };
}

/** Short related tip after a commerce action, at most once a day, from the stored text (no LLM call). Text only. */
export async function autoTip(ctx: Ctx, topic: TipTopic): Promise<Reply | null> {
  const last = await ctx.deps.repo.lastTipAt(ctx.user.id);
  if (last && ctx.now.getTime() - last.getTime() < 24 * 3_600_000) return null;
  const tip = await ctx.deps.repo.pickTip(ctx.user.id, topic);
  if (!tip) return null;
  const body = storedText(tip, ctx.lang);
  return { text: `${t(ctx.lang, "tip_header")}\n${body}`, voice: false, tip: { id: tip.id, trigger: "auto" } };
}
