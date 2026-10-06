/**
 * Recruitment source tag, e.g. the wa.me link pre-fills "Hi SoroEngine [OSHODI]".
 * Lets the NAIC report show where testers came from without collecting anything personal.
 */
/** A user's own share code, e.g. "F-3F9A1C". New users who arrive through it get it as their ref_source. */
export function shareCode(userId: string): string {
  return `F-${userId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function parseRef(text: string | undefined | null): string | null {
  const m = text?.match(/\[([A-Za-z0-9_-]{2,20})\]/);
  return m?.[1] ? m[1].toUpperCase() : null;
}
