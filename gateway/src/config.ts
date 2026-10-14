import { z } from "zod";

/** Unset or left blank (as copied from .env.example). */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  WA_VERIFY_TOKEN: z.string().min(8),
  WA_APP_SECRET: z.string().min(8),
  WA_ACCESS_TOKEN: z.string().min(10),
  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_GRAPH_VERSION: z.string().default("v25.0"),

  ENGINE_URL: z.string().url(),
  ENGINE_TOKEN: z.string().min(16),
  // Optional second engine (same ENGINE_TOKEN), used when ENGINE_URL fails: the Modal deployment behind AWS.
  ENGINE_FALLBACK_URL: optional(z.string().url()),
  // How long to wait for ENGINE_URL before trying the fallback. Without a fallback this covers a Modal cold start.
  ENGINE_TIMEOUT_MS: optional(z.coerce.number().int().positive()),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  PHONE_HASH_SALT: z.string().min(16),
  // 32 random bytes, base64 (openssl rand -base64 32). Seals the phone number of a pending reminder; without it
  // no reminders are sent. Changing it only loses reminders pending at that moment.
  NUDGE_KEY: optional(z.string()),
  PRIVACY_URL: z.string().url().default("https://soro.charavol.com/privacy"),
  // The bot's public WhatsApp number (digits only), used in SHARE links.
  WA_PUBLIC_NUMBER: z.string().regex(/^\d{10,15}$/).default("2349077485454"),
  VOICE_REPLIES: z.enum(["on", "off"]).default("on"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${missing}`);
  }
  return parsed.data;
}
