import type { Config } from "./config.js";
import { createRepo } from "./db/repo.js";
import { createEngineClient } from "./engine/client.js";
import { ec2Waker } from "./engine/wake.js";
import type { Logger } from "./lib/logger.js";
import { parseKey } from "./lib/seal.js";
import type { Deps } from "./pipeline/context.js";
import { Nudger } from "./pipeline/nudge.js";
import { createWhatsAppClient } from "./whatsapp/client.js";

/** Everything the pipeline needs, from the environment. Shared by the server (index.ts) and Lambda (lambda.ts). */
export function buildDeps(cfg: Config, log: Logger): { deps: Deps; nudger?: Nudger } {
  const wa = createWhatsAppClient({ accessToken: cfg.WA_ACCESS_TOKEN, phoneNumberId: cfg.WA_PHONE_NUMBER_ID, graphVersion: cfg.WA_GRAPH_VERSION });
  const repo = createRepo(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);
  const nudger = cfg.NUDGE_KEY ? new Nudger({ repo, wa, log, key: parseKey(cfg.NUDGE_KEY) }) : undefined;
  if (!nudger) log.warn("NUDGE_KEY not set: reminders are off");
  const wake =
    cfg.ENGINE_AWS_INSTANCE_ID && cfg.ENGINE_FALLBACK_URL
      ? ec2Waker({ instanceId: cfg.ENGINE_AWS_INSTANCE_ID, region: cfg.ENGINE_AWS_REGION, log })
      : undefined;
  if (cfg.ENGINE_AWS_INSTANCE_ID && !wake) log.warn("ENGINE_AWS_INSTANCE_ID needs ENGINE_FALLBACK_URL: the engine won't be woken");

  const deps: Deps = {
    wa,
    engine: createEngineClient({
      baseUrl: cfg.ENGINE_URL,
      token: cfg.ENGINE_TOKEN,
      timeoutMs: cfg.ENGINE_TIMEOUT_MS,
      fallbackUrl: cfg.ENGINE_FALLBACK_URL,
      wake,
      log,
    }),
    repo,
    log,
    nudger,
    phoneSalt: cfg.PHONE_HASH_SALT,
    privacyUrl: cfg.PRIVACY_URL,
    publicNumber: cfg.WA_PUBLIC_NUMBER,
    voiceReplies: cfg.VOICE_REPLIES === "on",
  };
  return { deps, nudger };
}
