import type { Repo } from "../db/repo.js";
import type { Lang } from "../domain/intents.js";
import type { Logger } from "../lib/logger.js";
import { t } from "../locales/index.js";
import type { WhatsAppApi } from "../whatsapp/client.js";

/** How long after their last message someone who has recorded nothing gets the one reminder. */
export const NUDGE_AFTER_MS = 3 * 60 * 60_000;

/** WhatsApp allows free-form messages only within 24h of the user's last one; stay inside it. */
const WINDOW_MS = 23 * 60 * 60_000;

// Only between 08:00 and 20:00 WAT (UTC+1, no daylight saving).
const WAT_OFFSET_MS = 60 * 60_000;
const DAY_START_H = 8;
const DAY_END_H = 20;

/** Milliseconds from `at` until the reminder, moved into the day; null if that leaves the 24h window. */
export function nudgeDelay(at: Date, afterMs = NUDGE_AFTER_MS): number | null {
  const due = at.getTime() + afterMs;
  const wat = new Date(due + WAT_OFFSET_MS);
  const hour = wat.getUTCHours();
  let send = due;
  if (hour < DAY_START_H || hour >= DAY_END_H) {
    const day = Date.UTC(wat.getUTCFullYear(), wat.getUTCMonth(), wat.getUTCDate() + (hour >= DAY_END_H ? 1 : 0), DAY_START_H);
    send = day - WAT_OFFSET_MS;
  }
  return send - at.getTime() > WINDOW_MS ? null : send - at.getTime();
}

/**
 * Reminds people who onboarded but never recorded anything. We keep no phone numbers, only their hash,
 * so the number lives in memory with the timer: a restart forgets pending reminders, and that is the trade.
 */
export class Nudger {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private deps: { repo: Repo; wa: WhatsAppApi; log: Pick<Logger, "info" | "warn" | "error"> },
    private afterMs = NUDGE_AFTER_MS,
  ) {}

  /** A message from someone set up to record: their clock starts again from now. */
  seen(userId: string, phone: string, lang: Lang, at: Date): void {
    clearTimeout(this.timers.get(userId));
    this.timers.delete(userId);
    const delay = nudgeDelay(at, this.afterMs);
    if (delay === null) return;
    const timer = setTimeout(() => {
      this.timers.delete(userId);
      this.send(userId, phone, lang).catch((err) => this.deps.log.error({ err, userId }, "nudge failed"));
    }, delay);
    timer.unref?.();
    this.timers.set(userId, timer);
  }

  private async send(userId: string, phone: string, lang: Lang): Promise<void> {
    // Claimed first: a second gateway or a retry can't send it twice.
    if (!(await this.deps.repo.claimNudge(userId))) return;
    await this.deps.wa.sendText(phone, t(lang, "nudge"));
    await this.deps.repo.insertOutbound({ user_id: userId, type: "text", language: lang, payload: { nudge: true } });
    this.deps.log.info({ userId }, "nudge sent");
  }
}
