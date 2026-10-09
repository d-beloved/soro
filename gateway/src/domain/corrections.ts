// Finds the messages the bot likely got wrong, from what users did next: an UNDO or "no be 5k, na 50k"
// right after a record points at the message that made it. Used by scripts/reviewCorrections.ts.
import { parseNaira } from "./money.js";

export interface LoggedMessage {
  id: string;
  user_id: string;
  created_at: string;
  type: string;
  language: string | null;
  transcript: string | null;
  intent: string | null;
  payload: unknown;
}

export interface Correction {
  /** "undo": the user threw the record away. "fix": the user changed part of it. */
  kind: "undo" | "fix";
  /** The message whose record was undone or fixed: what the bot heard and how N-ATLaS read it. */
  original: LoggedMessage;
  /** The UNDO or correction message itself. */
  fix: LoggedMessage;
  /** For "fix": what the user said was right (the correction's fields that were filled in). */
  right: Record<string, unknown>;
}

/**
 * Replays each user's messages in order the way the gateway does: every message that made a record goes on
 * a stack, UNDO takes the newest one off (it voids the user's last live record), and a correction applies to
 * the newest one still there.
 *
 * @param messages inbound messages, any order
 * @param recordMessageIds ids of messages that created a transaction
 */
export function findCorrections(messages: LoggedMessage[], recordMessageIds: Set<string>): Correction[] {
  const byUser = new Map<string, LoggedMessage[]>();
  for (const m of messages) {
    const list = byUser.get(m.user_id) ?? [];
    list.push(m);
    byUser.set(m.user_id, list);
  }

  const found: Correction[] = [];
  for (const list of byUser.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const live: LoggedMessage[] = [];
    for (const m of list) {
      if (recordMessageIds.has(m.id)) {
        live.push(m);
      } else if (m.intent === "undo_last") {
        const original = live.pop();
        if (original) found.push({ kind: "undo", original, fix: m, right: {} });
      } else if (m.intent === "correct_last") {
        const original = live.at(-1);
        const { intent: _, ...fields } = (m.payload ?? {}) as Record<string, unknown>;
        const right = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null));
        if (original && Object.keys(right).length) found.push({ kind: "fix", original, fix: m, right });
      }
    }
  }
  return found.sort((a, b) => a.fix.created_at.localeCompare(b.fix.created_at));
}

export type Cause = "asr" | "router" | "unclear";

/** Every amount written in a transcript: "135,100", "5k", "₦2.5m". Spoken number words are not counted. */
function amountsIn(text: string): number[] {
  const found = text.toLowerCase().match(/[₦n]?\d[\d,]*(?:\.\d+)?\s?[km]?\b/g) ?? [];
  return found.map((s) => parseNaira(s.replace(/^n/, ""))).filter((n): n is number => n != null);
}

/**
 * A first guess at who got it wrong, so a daily report can be skimmed:
 * - "router": the right answer was in what the bot heard, so N-ATLaS read it wrong (a new example or rule fixes it);
 * - "asr": the right amount is nowhere in what it heard, so the speech model probably misheard;
 * - "unclear": an UNDO, or a fix with nothing to check against. A person decides.
 */
export function likelyCause(c: Correction): Cause {
  if (c.kind === "undo") return "unclear";
  const heard = c.original.transcript ?? "";
  const amount = c.right.amount_ngn;
  if (typeof amount === "number") {
    if (amountsIn(heard).includes(amount)) return "router";
    return c.original.type === "audio" ? "asr" : "unclear";
  }
  // Kind, category, person or direction: the words were there; the reading was wrong.
  return "router";
}

/** Messages N-ATLaS could not place at all. Users often say these again in other words. */
export function findUnknowns(messages: LoggedMessage[]): LoggedMessage[] {
  return messages.filter((m) => m.intent === "unknown").sort((a, b) => a.created_at.localeCompare(b.created_at));
}
