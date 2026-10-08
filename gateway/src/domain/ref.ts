/**
 * Recruitment source tag. Site and QR links hide it after the greeting as zero-width
 * characters, so the visitor sees only "Hi Sọ̀rọ̀"; friend invites carry a visible
 * "[F-3F9A1C]". Shows where users came from without collecting anything personal.
 */

/** Two bits per character, so each tag letter costs four invisible characters. */
const INVISIBLE = ["​", "‌", "‍", "⁠"] as const;
const INVISIBLE_RUN = /[​‌‍⁠]+/g;
const TAG = /^[A-Za-z0-9_-]{2,20}$/;

/** A user's own share code, e.g. "F-3F9A1C". New users who arrive through it get it as their ref_source. */
export function shareCode(userId: string): string {
  return `F-${userId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** The invisible form of a tag, to append to a wa.me prefill. Mirrored in scripts/set_whatsapp_number.py. */
export function hideTag(tag: string): string {
  let out = "";
  for (const ch of tag.toUpperCase()) {
    const code = ch.charCodeAt(0);
    for (let shift = 6; shift >= 0; shift -= 2) out += INVISIBLE[(code >> shift) & 3];
  }
  return out;
}

function revealTag(run: string): string | null {
  if (run.length % 4) return null;
  let tag = "";
  for (let i = 0; i < run.length; i += 4) {
    let code = 0;
    for (const ch of run.slice(i, i + 4)) code = (code << 2) | INVISIBLE.indexOf(ch as (typeof INVISIBLE)[number]);
    tag += String.fromCharCode(code);
  }
  return TAG.test(tag) ? tag : null;
}

export function parseRef(text: string | undefined | null): string | null {
  for (const run of text?.match(INVISIBLE_RUN) ?? []) {
    const tag = revealTag(run);
    if (tag) return tag;
  }
  const m = text?.match(/\[([A-Za-z0-9_-]{2,20})\]/);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** The message text without any hidden tag, so it never reaches the router. */
export function stripHiddenTag(text: string): string {
  return text.replace(INVISIBLE_RUN, "");
}
