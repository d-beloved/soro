import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRepo } from "./db/repo.js";
import { createEngineClient } from "./engine/client.js";
import { logger } from "./lib/logger.js";
import { createWhatsAppClient } from "./whatsapp/client.js";

const cfg = loadConfig();

const app = createApp({
  verifyToken: cfg.WA_VERIFY_TOKEN,
  appSecret: cfg.WA_APP_SECRET,
  deps: {
    wa: createWhatsAppClient({ accessToken: cfg.WA_ACCESS_TOKEN, phoneNumberId: cfg.WA_PHONE_NUMBER_ID, graphVersion: cfg.WA_GRAPH_VERSION }),
    engine: createEngineClient({ baseUrl: cfg.ENGINE_URL, token: cfg.ENGINE_TOKEN }),
    repo: createRepo(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY),
    log: logger,
    phoneSalt: cfg.PHONE_HASH_SALT,
    privacyUrl: cfg.PRIVACY_URL,
    voiceReplies: cfg.VOICE_REPLIES === "on",
  },
});

serve({ fetch: app.fetch, port: cfg.PORT }, ({ port }) => logger.info({ port }, "SoroEngine gateway listening"));
