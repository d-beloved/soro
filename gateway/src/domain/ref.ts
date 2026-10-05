/**
 * Recruitment source tag, e.g. the wa.me link pre-fills "Hi SoroEngine [OSHODI]".
 * Lets the NAIC report show where testers came from without collecting anything personal.
 */
export function parseRef(text: string | undefined | null): string | null {
  const m = text?.match(/\[([A-Za-z0-9_-]{2,20})\]/);
  return m?.[1] ? m[1].toUpperCase() : null;
}
