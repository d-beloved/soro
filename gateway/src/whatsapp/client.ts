// Thin WhatsApp Cloud API client (Graph API). Docs:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages

export interface Button {
  id: string;
  title: string; // max 20 chars
}

export interface ListRow {
  id: string;
  title: string; // max 24 chars
  description?: string; // max 72 chars
}

export interface WhatsAppApi {
  sendText(to: string, body: string): Promise<string | undefined>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<string | undefined>;
  sendList(to: string, body: string, buttonLabel: string, rows: ListRow[]): Promise<string | undefined>;
  sendVoice(to: string, ogg: Uint8Array<ArrayBuffer>): Promise<string | undefined>;
  downloadMedia(mediaId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }>;
  markRead(messageId: string): Promise<void>;
}

interface Options {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  fetch?: typeof fetch;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export function createWhatsAppClient(opts: Options): WhatsAppApi {
  const f = opts.fetch ?? fetch;
  const base = `https://graph.facebook.com/${opts.graphVersion}`;
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  async function call(path: string, init: RequestInit): Promise<any> {
    const res = await f(`${base}/${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw new WhatsAppError(`Graph ${path} failed with ${res.status}`, res.status, body);
    return body;
  }

  async function send(to: string, message: Record<string, unknown>): Promise<string | undefined> {
    const body = await call(`${opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...message }),
    });
    return body?.messages?.[0]?.id;
  }

  return {
    sendText: (to, body) => send(to, { type: "text", text: { body, preview_url: true } }),

    sendButtons: (to, body, buttons) =>
      send(to, {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      }),

    sendList: (to, body, buttonLabel, rows) =>
      send(to, {
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: {
            button: buttonLabel.slice(0, 20),
            sections: [{ title: "SoroEngine", rows: rows.slice(0, 10).map((r) => ({ ...r, title: r.title.slice(0, 24) })) }],
          },
        },
      }),

    async sendVoice(to, ogg) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", "audio/ogg");
      form.append("file", new Blob([ogg], { type: "audio/ogg" }), "reply.ogg");
      const uploaded = await call(`${opts.phoneNumberId}/media`, { method: "POST", body: form });
      // voice: true renders it as a voice note (play button + waveform), not an audio file.
      return send(to, { type: "audio", audio: { id: uploaded.id, voice: true } });
    },

    async downloadMedia(mediaId) {
      const meta = await call(mediaId, { method: "GET" });
      const res = await f(meta.url, { headers: auth });
      if (!res.ok) throw new WhatsAppError(`Media download failed with ${res.status}`, res.status, undefined);
      return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: meta.mime_type ?? "audio/ogg" };
    },

    async markRead(messageId) {
      // Also shows the "typing…" indicator until we reply (or 25s pass).
      await call(`${opts.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } }),
      }).catch(() => undefined);
    },
  };
}
