# The gateway on AWS Lambda

The gateway runs as three Lambda functions, so nothing runs between messages:

- **webhook**: WhatsApp calls it through a function URL. It checks the signature, puts each message on a FIFO queue, and acks.
- **worker**: the queue hands it one message at a time, in order per sender, and it runs the pipeline. It also starts the engine's EC2 server when that server is stopped, using the function's own role, so no access key is needed.
- **nudge**: runs every minute and sends the reminders that are due.

[template.yaml](template.yaml) defines the functions, the queue (encrypted, messages dropped after an hour) and a log group (30 days). [src/lambda.ts](../src/lambda.ts) holds the handlers. For local development, `npm run dev` still runs the gateway as one server.

## 1. Settings

The functions read their settings from one SSM parameter.

1. In the AWS console, go to **Systems Manager → Parameter Store → Create parameter**.
2. Fill in:
   - **Name:** `/soro/gateway`
   - **Tier:** Standard
   - **Type:** SecureString, with the default key
3. For the **value**, paste the gateway's settings, one `KEY=value` per line, the same names as [.env.example](../.env.example):

```
WA_VERIFY_TOKEN=
WA_APP_SECRET=
WA_ACCESS_TOKEN=
WA_PHONE_NUMBER_ID=
ENGINE_URL=https://engine.example.com
ENGINE_TOKEN=
ENGINE_FALLBACK_URL=https://<workspace>--soroengine-engine-web.modal.run
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PHONE_HASH_SALT=
NUDGE_KEY=
```

`PHONE_HASH_SALT` and `NUDGE_KEY` must be the values the gateway already uses. A new salt makes every user look new, and a new key loses the reminders that are pending.

To change a setting later, edit the parameter. The functions read it again every 5 minutes.

## 2. Deploy

In **AWS CloudShell** (the terminal icon in the console's top bar), in the engine's region:

```bash
git clone https://github.com/d-beloved/soro.git && cd soro
gateway/aws/deploy.sh i-0123456789abcdef0     # the engine's instance ID
```

The output ends with `WebhookUrl`. Check it:

```bash
curl https://<id>.lambda-url.us-east-1.on.aws/health    # {"ok":true}
```

Run the same two commands again to deploy a new version.

## 3. Point WhatsApp at it

1. Open the Meta app's **WhatsApp → Configuration** page.
2. Set the **Callback URL** to `WebhookUrl` followed by `webhook`, so it ends in `.on.aws/webhook`.
3. Set the **Verify token** to `WA_VERIFY_TOKEN`.
4. Click **Verify and save**. The `messages` field must stay subscribed.
5. Send the bot a message.

Logs are in **CloudWatch → Log groups → `/soro/gateway`**.
