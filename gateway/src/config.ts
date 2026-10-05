import { z } from "zod";

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

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  PHONE_HASH_SALT: z.string().min(16),
  PRIVACY_URL: z.string().url().default("https://soro.charavol.com/privacy"),
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
