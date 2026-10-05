import type { Repo, UserRow } from "../db/repo.js";
import type { EngineApi } from "../engine/client.js";
import type { Lang, TipTopic } from "../domain/intents.js";
import type { Logger } from "../lib/logger.js";
import type { WhatsAppApi } from "../whatsapp/client.js";
import type { InboundMessage } from "../whatsapp/types.js";

export interface Deps {
  wa: WhatsAppApi;
  engine: EngineApi;
  repo: Repo;
  log: Pick<Logger, "info" | "warn" | "error">;
  phoneSalt: string;
  privacyUrl: string;
  voiceReplies: boolean;
  now?: () => Date;
}

/** Per-message state passed through the pipeline. */
export interface Ctx {
  deps: Deps;
  msg: InboundMessage;
  user: UserRow;
  lang: Lang;
  messageId: string;
  now: Date;
}

export interface Reply {
  text: string;
  /** What the voice note says; defaults to `text`. */
  spoken?: string;
  voice: boolean;
  tip?: { id: string; trigger: "asked" | "auto" };
  /** After a commerce action, send a related tip if none was sent in the last day. */
  autoTipTopic?: TipTopic;
}
