/**
 * Parses the ways traders say amounts: 5000, "5,000", "₦5k", "N2.5m", "12500 naira", "5 thousand".
 * Returns null when no amount can be read.
 */
export function parseNaira(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : null;
  if (typeof input !== "string") return null;
  const s = input.toLowerCase().replace(/[₦,\s]/g, "").replace(/^n(?=\d)/, "").replace(/naira$/, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(k|thousand|m|million)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = m[2] === "k" || m[2] === "thousand" ? 1_000 : m[2] === "m" || m[2] === "million" ? 1_000_000 : 1;
  return Math.round(n * mult * 100) / 100;
}

const fmt = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });

export function formatNaira(amount: number): string {
  return `₦${fmt.format(Math.round(amount))}`;
}
