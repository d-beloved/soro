import { Intent, LANGS, parseIntent, type Lang } from "../domain/intents.js";
import { formatNaira } from "../domain/money.js";
import { parseRef, shareCode, stripHiddenTag } from "../domain/ref.js";
import { todayWAT } from "../domain/time.js";
import { hashPhone } from "../lib/hash.js";
import { LANGUAGE_PROMPT, LANGUAGE_ROWS, t } from "../locales/index.js";
import type { InboundMessage } from "../whatsapp/types.js";
import { applyCommerce } from "./commerce.js";
import type { Ctx, Deps, Reply } from "./context.js";
import { answerQuestion, autoTip } from "./tutor.js";

/** What we learned about the inbound message, written back to its row (and so to the interaction log). */
interface Outcome {
  intent?: string;
  payload?: unknown;
  transcript?: string;
  audio_seconds?: number;
}

/** Someone who sends several messages before answering gets the consent prompt once, not once per message. */
const CONSENT_REPROMPT_MS = 10 * 60_000;

/** A warm engine answers a Yoruba voice note in ~5-8s; past this, say we're on it instead of leaving blue ticks. */
const SLOW_REPLY_MS = 10_000;

const COMMANDS: Record<string, "help" | "language" | "delete" | "undo" | "share"> = {
  HELP: "help",
  MENU: "help",
  LANGUAGE: "language",
  LANG: "language",
  DELETE: "delete",
  UNDO: "undo",
  SHARE: "share",
  INVITE: "share",
};

export async function handleMessage(deps: Deps, msg: InboundMessage): Promise<void> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const ref = parseRef(msg.text?.body) ?? (msg.referral?.source_id ? `AD_${msg.referral.source_id}`.slice(0, 40) : null);
  const user = await deps.repo.getOrCreateUser(hashPhone(msg.from, deps.phoneSalt), ref);

  const messageId = await deps.repo.insertInbound({ wa_message_id: msg.id, user_id: user.id, type: msg.type, language: user.language });
  if (!messageId) {
    deps.log.info({ wa_message_id: msg.id }, "duplicate webhook delivery ignored");
    return;
  }
  void deps.wa.markRead(msg.id);

  const ctx: Ctx = { deps, msg, user, lang: user.language ?? "en", messageId, now };
  const outcome: Outcome = {};
  try {
    await dispatch(ctx, outcome).finally(() => clearTimeout(ctx.slowNotice));
    await deps.repo.updateMessage(messageId, { ...outcome, language: ctx.lang, latency_ms: Date.now() - started });
  } catch (err) {
    deps.log.error({ err, messageId }, "message handling failed");
    await deps.repo
      .updateMessage(messageId, { ...outcome, error: String(err).slice(0, 500), latency_ms: Date.now() - started })
      .catch(() => undefined);
    await deps.wa.sendText(msg.from, t(ctx.lang, "error")).catch(() => undefined);
  }
}

async function dispatch(ctx: Ctx, out: Outcome): Promise<void> {
  const { deps, msg, user } = ctx;
  const to = msg.from;
  const choice = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
  const text = msg.text?.body ? stripHiddenTag(msg.text.body).trim() : undefined;

  // 1. Consent (NDPA 2023): nothing is processed before an explicit yes.
  if (!user.consent_at) {
    if (choice === "consent_yes") {
      await deps.repo.setConsent(user.id);
      out.intent = "consent_given";
      return sendLanguagePicker(ctx);
    }
    if (choice === "consent_no") {
      out.intent = "consent_declined";
      await deps.wa.sendText(to, t("en", "consent_declined"));
      return;
    }
    const lastPrompt = await deps.repo.lastIntentAt(user.id, "consent_prompt");
    if (lastPrompt && ctx.now.getTime() - lastPrompt.getTime() < CONSENT_REPROMPT_MS) {
      out.intent = "consent_pending";
      return;
    }
    out.intent = "consent_prompt";
    await deps.wa.sendButtons(to, t("en", "consent_prompt", { privacy_url: deps.privacyUrl }), [
      { id: "consent_yes", title: t("en", "consent_yes") },
      { id: "consent_no", title: t("en", "consent_no") },
    ]);
    return;
  }

  // 2. Language choice.
  if (choice?.startsWith("lang_")) {
    const lang = choice.slice(5) as Lang;
    if (LANGS.includes(lang)) {
      await deps.repo.setLanguage(user.id, lang);
      ctx.lang = lang;
      out.intent = "language_set";
      return deliver(ctx, { text: t(lang, "welcome"), voice: false });
    }
  }
  if (!user.language) {
    out.intent = "language_prompt";
    return sendLanguagePicker(ctx);
  }

  // 3. Commands and confirmations.
  const command = text ? COMMANDS[text.toUpperCase().replace(/[^A-Z]/g, "")] : undefined;
  if (command === "help") {
    out.intent = "help";
    return deliver(ctx, { text: t(ctx.lang, "help"), voice: false });
  }
  if (command === "language") {
    out.intent = "language_prompt";
    return sendLanguagePicker(ctx);
  }
  if (command === "delete") {
    out.intent = "delete_prompt";
    await deps.wa.sendButtons(to, t(ctx.lang, "delete_confirm"), [
      { id: "delete_yes", title: t(ctx.lang, "delete_yes") },
      { id: "delete_no", title: t(ctx.lang, "delete_no") },
    ]);
    return;
  }
  if (command === "undo") {
    out.intent = "undo_last";
    const reply = await applyCommerce(ctx, Intent.parse({ intent: "undo_last" }));
    return deliver(ctx, { ...reply!, voice: false });
  }
  if (command === "share") {
    out.intent = "share";
    const code = shareCode(user.id);
    const link = `https://wa.me/${deps.publicNumber}?text=${encodeURIComponent(`Hi Sọ̀rọ̀ [${code}]`)}`;
    const count = await deps.repo.countReferrals(code);
    await deliver(ctx, { text: t(ctx.lang, "share_intro", { count }), voice: false });
    // A separate message, so it can be forwarded as it is.
    return deliver(ctx, { text: t(ctx.lang, "share_message", { link }), voice: false });
  }
  if (choice === "delete_yes") {
    await deps.repo.deleteUser(user.id); // also removes this message row
    await deps.wa.sendText(to, t(ctx.lang, "deleted"));
    return;
  }
  if (choice === "delete_no") {
    out.intent = "delete_cancelled";
    await deps.wa.sendText(to, t(ctx.lang, "delete_cancelled"));
    return;
  }

  // 4. Get the words: transcribe voice notes, take text as-is.
  startSlowNotice(ctx);
  const isAudio = msg.type === "audio" && !!msg.audio;
  let input: string;
  let enText: string | undefined;
  if (isAudio) {
    ctx.noticeWaitsForLang = true;
    const media = await deps.wa.downloadMedia(msg.audio!.id);
    const tr = await deps.engine.transcribe(media.bytes, media.mimeType, ctx.lang);
    if (tr.lang !== ctx.lang) {
      // Spoken in another of the four languages: understand and answer this note in that one; the saved choice stays.
      deps.log.info({ messageId: ctx.messageId, chosen: ctx.lang, heard: tr.lang }, "voice note in another language");
      ctx.lang = tr.lang;
    }
    out.transcript = tr.text;
    out.audio_seconds = tr.seconds;
    if (!tr.text) {
      out.intent = "empty_audio";
      return deliver(ctx, { text: t(ctx.lang, "transcribe_empty"), voice: true });
    }
    input = tr.text;
    enText = tr.enText;
    ctx.noticeWaitsForLang = false;
    if (ctx.noticeDue) await sendSlowNotice(ctx);
  } else if (text) {
    out.transcript = text;
    input = text;
  } else {
    out.intent = "unsupported";
    await deps.wa.sendText(to, t(ctx.lang, "unsupported_type"));
    return;
  }

  // 5. Understand (N-ATLaS router) and act.
  const intent = parseIntent(await deps.engine.route(input, ctx.lang, todayWAT(ctx.now), enText));
  out.intent = intent.intent;
  // The English hearing is kept for review only; the "I heard" line shows the note's own transcript.
  out.payload = enText ? { ...intent, heard_en: enText } : intent;

  let reply = await applyCommerce(ctx, intent);
  if (reply && intent.amount_ngn != null && intent.other_amounts.length > 0) reply = withOtherAmounts(ctx, reply, intent.other_amounts);
  if (!reply && intent.intent === "ask_question") reply = await answerQuestion(ctx, intent.topic, intent.question ?? input);
  if (!reply && intent.intent === "help") reply = { text: t(ctx.lang, "help"), voice: false };
  if (!reply && intent.intent === "greeting") reply = { text: t(ctx.lang, "greeting"), voice: true };
  reply ??= { text: t(ctx.lang, "unknown"), voice: true };

  // Echo what we heard so the trader can catch transcription mistakes.
  // Voice notes get a voice reply; text gets text only, so nobody waits on TTS they didn't ask for.
  const shown = isAudio ? `${t(ctx.lang, "heard", { transcript: input })}\n\n${reply.text}` : reply.text;
  await deliver(ctx, { ...reply, text: shown, spoken: reply.spoken ?? firstLine(reply.text), voice: isAudio });

  if (reply.autoTipTopic) {
    const tip = await autoTip(ctx, reply.autoTipTopic);
    if (tip) await deliver(ctx, tip);
  }
}

/**
 * One message saves one record, so "rice 5k, beans 3k, and I buy fuel 2k" loses the fuel. The engine lists the
 * amounts the record leaves out; say so, out loud too, instead of dropping them silently.
 */
function withOtherAmounts(ctx: Ctx, reply: Reply, amounts: number[]): Reply {
  const note = t(ctx.lang, "other_amounts", { amounts: amounts.map(formatNaira).join(", ") });
  return { ...reply, text: `${reply.text}\n\n${note}`, spoken: `${reply.spoken ?? firstLine(reply.text)} ${note}` };
}

/**
 * The engine can be slow (long voice note, busy or cold GPU): after a while, tell the user we got it. During a
 * voice note's transcription the notice waits, so it goes out in the language the note turns out to be in.
 */
function startSlowNotice(ctx: Ctx): void {
  ctx.slowNotice = setTimeout(() => {
    if (ctx.noticeWaitsForLang) ctx.noticeDue = true;
    else void sendSlowNotice(ctx);
  }, ctx.deps.slowReplyMs ?? SLOW_REPLY_MS);
}

async function sendSlowNotice(ctx: Ctx): Promise<void> {
  const { deps } = ctx;
  ctx.noticeDue = false;
  try {
    const text = t(ctx.lang, "working");
    await deps.wa.sendText(ctx.msg.from, text);
    await deps.repo.insertOutbound({ user_id: ctx.user.id, type: "text", language: ctx.lang, payload: { text } });
  } catch (err) {
    deps.log.warn({ err }, "slow-reply notice failed");
  }
}

async function sendLanguagePicker(ctx: Ctx): Promise<void> {
  await ctx.deps.wa.sendList(ctx.msg.from, LANGUAGE_PROMPT, t("en", "language_button"), LANGUAGE_ROWS);
}

/**
 * The voice note says only the headline (the first line, unless the reply sets `spoken`): long notes are slow
 * to make and to listen to, and the full detail is already in the text.
 */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]!;
}

/** Text first (instant), then the voice note (slower), so nobody waits on TTS. */
async function deliver(ctx: Ctx, reply: Reply): Promise<void> {
  const { deps } = ctx;
  clearTimeout(ctx.slowNotice);
  await deps.wa.sendText(ctx.msg.from, reply.text);
  await deps.repo.insertOutbound({ user_id: ctx.user.id, type: "text", language: ctx.lang, payload: { text: reply.text } });

  let audioSent = false;
  if (reply.voice && deps.voiceReplies) {
    try {
      const ogg = await deps.engine.speak(reply.spoken ?? firstLine(reply.text), ctx.lang);
      await deps.wa.sendVoice(ctx.msg.from, ogg);
      await deps.repo.insertOutbound({ user_id: ctx.user.id, type: "audio", language: ctx.lang });
      audioSent = true;
    } catch (err) {
      deps.log.warn({ err }, "voice reply failed; text already sent");
    }
  }

  if (reply.tip) {
    await deps.repo.insertTipDelivery({
      user_id: ctx.user.id,
      tip_id: reply.tip.id,
      message_id: ctx.messageId,
      trigger: reply.tip.trigger,
      audio_sent: audioSent,
    });
  }
}
