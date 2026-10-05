import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Never log phone numbers or tokens.
  redact: ["from", "to", "*.from", "*.to", "headers.authorization", "*.wa_id"],
});

export type Logger = typeof logger;
