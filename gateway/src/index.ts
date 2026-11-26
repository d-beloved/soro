import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { logger } from "./lib/logger.js";

// The gateway as one long-running server (local development, or any host that runs Node). On AWS it runs as
// Lambda functions instead: lambda.ts and aws/README.md.

const cfg = loadConfig();
const { deps, nudger } = buildDeps(cfg, logger);
const app = createApp({ verifyToken: cfg.WA_VERIFY_TOKEN, appSecret: cfg.WA_APP_SECRET, deps });

nudger?.start();
serve({ fetch: app.fetch, port: cfg.PORT }, ({ port }) => logger.info({ port }, "SoroEngine gateway listening"));
