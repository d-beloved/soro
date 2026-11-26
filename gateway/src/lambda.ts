import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { type Config, loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { logger } from "./lib/logger.js";
import { handleMessage } from "./pipeline/handle.js";
import type { InboundMessage } from "./whatsapp/types.js";

// The gateway on AWS Lambda, as three functions (aws/template.yaml):
//   webhook  WhatsApp calls it (a function URL). It checks the signature, puts each message on a FIFO queue and acks.
//   worker   The queue calls it with one message at a time, in order per sender, and it runs the pipeline.
//   nudge    A schedule calls it every minute to send the reminders that are due.
// Settings and secrets live in one SecureString parameter (SETTINGS_PARAM), written like a .env file; the
// template's own variables (QUEUE_URL, ENGINE_AWS_INSTANCE_ID) override it.

async function loadSettings(): Promise<Config> {
  const name = process.env.SETTINGS_PARAM;
  if (!name) throw new Error("SETTINGS_PARAM is not set");
  const ssm = new SSMClient({});
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const fromParam = parseEnv(out.Parameter?.Value ?? "");
  return loadConfig({ ...fromParam, ...process.env });
}

/** Settings are read again after this long, so an edit to the parameter takes effect without a redeploy. */
const SETTINGS_TTL_MS = 5 * 60_000;

let ready: Promise<ReturnType<typeof setup>> | undefined;
let loadedAt = 0;

function setup(cfg: Config) {
  const { deps, nudger } = buildDeps(cfg, logger);
  const queueUrl = process.env.QUEUE_URL;
  const sqs = new SQSClient({});
  const dispatch = async (m: InboundMessage) => {
    if (!queueUrl) throw new Error("QUEUE_URL is not set");
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(m),
        // One sender's messages are processed one at a time, in order; the hash keeps the number out of the group id.
        MessageGroupId: createHash("sha256").update(m.from).digest("hex"),
        // Meta resending the same message within 5 minutes is dropped here (and the pipeline skips repeats anyway).
        MessageDeduplicationId: createHash("sha256").update(m.id).digest("hex"),
      }),
    );
  };
  const app = createApp({ verifyToken: cfg.WA_VERIFY_TOKEN, appSecret: cfg.WA_APP_SECRET, deps, dispatch });
  return { deps, nudger, http: handle(app) };
}

/** Built on a Lambda container's first call, and again once the settings are SETTINGS_TTL_MS old. */
function init() {
  if (!ready || Date.now() - loadedAt > SETTINGS_TTL_MS) {
    loadedAt = Date.now();
    const next = loadSettings().then(setup);
    next.catch(() => {
      if (ready === next) ready = undefined; // a failed start (say, the parameter missing) is retried next call
    });
    ready = next;
  }
  return ready;
}

type HttpHandler = ReturnType<typeof handle>;

export const webhook = async (event: Parameters<HttpHandler>[0], context: Parameters<HttpHandler>[1]) =>
  (await init()).http(event, context);

interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

export const worker = async (event: SqsEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> => {
  const { deps } = await init();
  for (const record of event.Records) {
    // Never fail the record: a retry would run the whole message again and could reply twice.
    try {
      await handleMessage(deps, JSON.parse(record.body) as InboundMessage);
    } catch (err) {
      deps.log.error({ err }, "unhandled pipeline error");
    }
  }
  return { batchItemFailures: [] };
};

export const nudge = async (): Promise<void> => {
  const { nudger } = await init();
  await nudger?.tick();
};
