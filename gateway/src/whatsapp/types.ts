import { z } from "zod";

// Only the parts of the WhatsApp Cloud API webhook payload we use.
// Unknown fields pass through; unknown message types are kept as "unsupported".

const InboundMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional(), voice: z.boolean().optional() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string(), description: z.string().optional() }).optional(),
    })
    .optional(),
  // Click-to-WhatsApp ads put the source here.
  referral: z.object({ source_id: z.string().optional(), headline: z.string().optional() }).passthrough().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

const Status = z.object({
  id: z.string(),
  status: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(z.object({ code: z.number(), title: z.string().optional() }).passthrough()).optional(),
});
export type Status = z.infer<typeof Status>;

export const WebhookPayload = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: z.string() }).optional(),
              contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
              messages: z.array(InboundMessage).optional(),
              statuses: z.array(Status).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export function extractEvents(payload: WebhookPayload): { messages: InboundMessage[]; statuses: Status[] } {
  const messages: InboundMessage[] = [];
  const statuses: Status[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      messages.push(...(change.value.messages ?? []));
      statuses.push(...(change.value.statuses ?? []));
    }
  }
  return { messages, statuses };
}
