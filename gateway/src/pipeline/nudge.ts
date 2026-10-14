import type { Repo } from "../db/repo.js";
import type { Lang } from "../domain/intents.js";
import type { Logger } from "../lib/logger.js";
import { seal, unseal } from "../lib/seal.js";
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

/** How often the gateway looks for reminders that are due. */
export const POLL_MS = 60_000;

/**
 * Reminds people who onboarded but never recorded anything. We keep no phone numbers, only their hash, so the
 * pending reminder stores the number sealed with NUDGE_KEY (lib/seal.ts) and drops it as soon as the reminder
 * is sent or no longer needed. Pending reminders live in the database, so they survive a gateway restart.
 */
export class Nudger {
  private poll?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private deps: { repo: Repo; wa: WhatsAppApi; log: Pick<Logger, "info" | "warn" | "error">; key: Buffer },
    private afterMs = NUDGE_AFTER_MS,
  ) {}

  /** A message from someone set up to record: their clock starts again from now. Never throws. */
  async seen(userId: string, phone: string, lang: Lang, at: Date): Promise<void> {
    try {
      const delay = nudgeDelay(at, this.afterMs);
      if (delay === null) return await this.deps.repo.cancelNudge(userId);
      await this.deps.repo.scheduleNudge({
        user_id: userId,
        phone_enc: seal(phone, this.deps.key, userId),
        language: lang,
        due_at: new Date(at.getTime() + delay),
        expires_at: new Date(at.getTime() + WINDOW_MS),
      });
    } catch (err) {
      this.deps.log.error({ err, userId }, "nudge scheduling failed");
    }
  }

  start(pollMs = POLL_MS): void {
    this.stop();
    this.poll = setInterval(() => void this.tick(), pollMs);
    this.poll.unref?.();
    void this.tick(); // whatever came due while the gateway was down
  }

  stop(): void {
    clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Sends every reminder that is due. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const row of await this.deps.repo.takeDueNudges(now)) {
        // Down past the 24-hour window (a long outage): WhatsApp would refuse it, so let it go.
        if (new Date(row.expires_at) <= now) {
          this.deps.log.warn({ userId: row.user_id }, "nudge expired before it could be sent");
          continue;
        }
        try {
          await this.send(row.user_id, unseal(row.phone_enc, this.deps.key, row.user_id), row.language);
        } catch (err) {
          this.deps.log.error({ err, userId: row.user_id }, "nudge failed");
        }
      }
    } catch (err) {
      this.deps.log.error({ err }, "nudge poll failed");
    } finally {
      this.ticking = false;
    }
  }

  private async send(userId: string, phone: string, lang: Lang): Promise<void> {
    // Checked again at send time: they may have recorded something since, and nobody is reminded twice.
    if (!(await this.deps.repo.claimNudge(userId))) return;
    await this.deps.wa.sendText(phone, t(lang, "nudge"));
    await this.deps.repo.insertOutbound({ user_id: userId, type: "text", language: lang, payload: { nudge: true } });
    this.deps.log.info({ userId }, "nudge sent");
  }
}
