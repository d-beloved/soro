import { createHash, createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The Lambda entry points with AWS stubbed: settings come from a fake parameter, queue sends are recorded, and the
// pipeline itself is replaced (it has its own tests).

const sqsSends: any[] = [];
const handled: any[] = [];

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send(cmd: any) {
      expect(cmd.input).toEqual({ Name: "/soro/gateway", WithDecryption: true });
      return {
        Parameter: {
          Value: [
            "# like a .env file",
            "WA_VERIFY_TOKEN=verify-me-please",
            "WA_APP_SECRET=test-app-secret",
            "WA_ACCESS_TOKEN=access-token-123",
            "WA_PHONE_NUMBER_ID=123",
            "ENGINE_URL=https://engine.example.com",
            "ENGINE_TOKEN=engine-token-0123456789",
            "SUPABASE_URL=https://db.example.com",
            'SUPABASE_SERVICE_ROLE_KEY="service-role-key-0123456789"',
            "PHONE_HASH_SALT=salt-0123456789abcdef",
          ].join("\n"),
        },
      };
    }
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    async send(cmd: any) {
      sqsSends.push(cmd.input);
      return {};
    }
  },
  SendMessageCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("../src/pipeline/handle.js", () => ({
  handleMessage: async (_deps: unknown, m: unknown) => {
    handled.push(m);
  },
}));

let lambda: typeof import("../src/lambda.js");

beforeAll(async () => {
  process.env.SETTINGS_PARAM = "/soro/gateway";
  process.env.QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/soro-messages.fifo";
  lambda = await import("../src/lambda.js");
});

/** A function URL request (payload format 2.0). */
function urlEvent(method: string, path: string, opts: { query?: string; body?: string; headers?: Record<string, string> } = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: opts.query ?? "",
    headers: { host: "abc.lambda-url.us-east-1.on.aws", ...opts.headers },
    requestContext: {
      domainName: "abc.lambda-url.us-east-1.on.aws",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
      requestId: "r1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
    },
    body: opts.body,
    isBase64Encoded: false,
  } as any;
}

const message = { from: "2348000000000", id: "wamid.A", timestamp: "1", type: "text", text: { body: "hi" } };

describe("lambda webhook", () => {
  it("answers Meta's verification challenge", async () => {
    const res: any = await lambda.webhook(urlEvent("GET", "/webhook", { query: "hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=42" }), {} as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("42");
  });

  it("rejects unsigned posts without queueing anything", async () => {
    const res: any = await lambda.webhook(urlEvent("POST", "/webhook", { body: "{}" }), {} as any);
    expect(res.statusCode).toBe(401);
    expect(sqsSends).toHaveLength(0);
  });

  it("queues a signed message per sender and acks", async () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }] }],
    });
    const sig = "sha256=" + createHmac("sha256", "test-app-secret").update(body).digest("hex");
    const res: any = await lambda.webhook(urlEvent("POST", "/webhook", { body, headers: { "x-hub-signature-256": sig } }), {} as any);
    expect(res.statusCode).toBe(200);
    expect(sqsSends).toHaveLength(1);
    const sent = sqsSends[0];
    expect(JSON.parse(sent.MessageBody)).toEqual(message);
    expect(sent.MessageGroupId).toBe(createHash("sha256").update(message.from).digest("hex"));
    expect(sent.MessageGroupId).not.toContain(message.from);
    expect(sent.QueueUrl).toBe(process.env.QUEUE_URL);
    expect(handled).toHaveLength(0); // processed by the worker, not here
  });
});

describe("lambda worker", () => {
  it("runs the pipeline for each queued message", async () => {
    const out = await lambda.worker({ Records: [{ messageId: "1", body: JSON.stringify(message) }] });
    expect(out.batchItemFailures).toEqual([]);
    expect(handled).toEqual([message]);
  });
});

describe("lambda nudge", () => {
  it("does nothing without NUDGE_KEY", async () => {
    await expect(lambda.nudge()).resolves.toBeUndefined();
  });
});
