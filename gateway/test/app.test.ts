import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeDeps } from "./fakes.js";

const secret = "test-app-secret";

function setup() {
  const t = makeDeps();
  const app = createApp({ verifyToken: "verify-me", appSecret: secret, deps: t.deps });
  return { app, ...t };
}

describe("webhook", () => {
  it("answers Meta's verification challenge", async () => {
    const { app } = setup();
    const ok = await app.request("/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await ok.text()).toBe("42");
    const bad = await app.request("/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned posts", async () => {
    const { app } = setup();
    const res = await app.request("/webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("acks signed posts and processes the message", async () => {
    const { app, sent } = setup();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123", display_phone_number: "234" },
                messages: [{ from: "2348000000000", id: "wamid.A", timestamp: "1", type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    });
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const res = await app.request("/webhook", { method: "POST", body, headers: { "x-hub-signature-256": sig } });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]?.kind).toBe("buttons"); // consent prompt
  });
});
