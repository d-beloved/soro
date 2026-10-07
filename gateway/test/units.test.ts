import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/domain/intents.js";
import { formatNaira, parseNaira } from "../src/domain/money.js";
import { parseRef } from "../src/domain/ref.js";
import { periodStart, todayWAT } from "../src/domain/time.js";
import { hashPhone } from "../src/lib/hash.js";
import { t } from "../src/locales/index.js";
import { verifySignature } from "../src/whatsapp/signature.js";

describe("verifySignature", () => {
  const secret = "app-secret-123";
  const body = '{"object":"whatsapp_business_account","entry":[]}';
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature", () => expect(verifySignature(body, good, secret)).toBe(true));
  it("rejects a tampered body", () => expect(verifySignature(body + " ", good, secret)).toBe(false));
  it("rejects missing or malformed headers", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifySignature(body, "sha256=abc", secret)).toBe(false);
  });
});

describe("parseNaira", () => {
  it.each([
    [5000, 5000],
    ["5000", 5000],
    ["5,000", 5000],
    ["₦5k", 5000],
    ["N2.5m", 2_500_000],
    ["12500 naira", 12500],
    ["5 thousand", 5000],
    ["75K", 75000],
  ])("%s -> %s", (input, expected) => expect(parseNaira(input)).toBe(expected));

  it.each([["abc"], [""], [null], [-5], ["5 bags"]])("%s -> null", (input) => expect(parseNaira(input)).toBeNull());
});

describe("formatNaira", () => {
  it("adds the symbol and thousands separators", () => expect(formatNaira(1234567.4)).toBe("₦1,234,567"));
});

describe("parseIntent", () => {
  it("coerces sloppy model output", () => {
    const i = parseIntent({ intent: "log_sale", item: " rice ", quantity: "3", amount_ngn: "75k", unit: "", direction: "sideways" });
    expect(i).toMatchObject({ intent: "log_sale", item: "rice", quantity: 3, amount_ngn: 75000, unit: null, direction: null });
  });
  it("falls back to unknown", () => {
    expect(parseIntent({ intent: "launch_rocket" }).intent).toBe("unknown");
    expect(parseIntent("garbage").intent).toBe("unknown");
  });
});

describe("time (WAT)", () => {
  // 23:30 UTC on Sunday 4 Oct 2026 is already 00:30 Monday 5 Oct in Lagos.
  const now = new Date("2026-10-04T23:30:00Z");
  it("uses the Lagos date", () => expect(todayWAT(now)).toBe("2026-10-05"));
  it("starts today at Lagos midnight", () => expect(periodStart("today", now).toISOString()).toBe("2026-10-04T23:00:00.000Z"));
  it("starts the week on Monday", () => expect(periodStart("week", now).toISOString()).toBe("2026-10-04T23:00:00.000Z"));
  it("starts the month on the 1st", () => expect(periodStart("month", now).toISOString()).toBe("2026-09-30T23:00:00.000Z"));
});

describe("parseRef", () => {
  it("reads the tag from a wa.me prefill", () => expect(parseRef("Hi Sọ̀rọ̀ [oshodi_1]")).toBe("OSHODI_1"));
  it("ignores text without a tag", () => expect(parseRef("I sell rice 5k")).toBeNull());
});

describe("hashPhone", () => {
  it("is stable across formatting and never contains the number", () => {
    const a = hashPhone("+234 803 123 4567", "salt-salt-salt-salt");
    expect(a).toBe(hashPhone("2348031234567", "salt-salt-salt-salt"));
    expect(a).not.toContain("8031234567");
  });
});

describe("locales", () => {
  it("fills placeholders and falls back to English", () => {
    expect(t("yo", "stock_logged", { qty: "10 cartons", item: "Indomie" })).toBe("📦 Stock noted: 10 cartons Indomie.");
  });
});
