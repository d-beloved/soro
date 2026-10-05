import { Hono } from "hono";
import type { Deps } from "./pipeline/context.js";
import { handleMessage } from "./pipeline/handle.js";
import { KeyedQueue } from "./lib/queue.js";
import { verifySignature } from "./whatsapp/signature.js";
import { extractEvents, WebhookPayload } from "./whatsapp/types.js";

interface AppOptions {
  verifyToken: string;
  appSecret: string;
  deps: Deps;
}

export function createApp({ verifyToken, appSecret, deps }: AppOptions) {
  const app = new Hono();
  const queue = new KeyedQueue();

  app.get("/health", (c) => c.json({ ok: true }));

  // Meta's one-time webhook verification handshake.
  app.get("/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && token === verifyToken && challenge) return c.text(challenge);
    return c.text("forbidden", 403);
  });

  app.post("/webhook", async (c) => {
    const raw = await c.req.text();
    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), appSecret)) {
      deps.log.warn("webhook signature mismatch");
      return c.text("invalid signature", 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    const parsed = WebhookPayload.safeParse(body);
    if (!parsed.success) {
      deps.log.warn({ issues: parsed.error.issues.slice(0, 3) }, "unrecognised webhook payload");
      return c.text("ok");
    }
    const { messages, statuses } = extractEvents(parsed.data);
    for (const s of statuses) {
      if (s.status === "failed") deps.log.warn({ id: s.id, errors: s.errors }, "outbound message failed");
    }
    // Ack immediately (Meta retries if we take too long); process in the background, in order per sender.
    for (const m of messages) {
      void queue.run(m.from, () =>
        handleMessage(deps, m).catch((err) => deps.log.error({ err }, "unhandled pipeline error")),
      );
    }
    return c.text("ok");
  });

  return app;
}
