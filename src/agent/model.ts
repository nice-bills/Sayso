// The Claude model Sayso uses everywhere: the invoice reader, the inbox extractor, voice intents
// and the paying agent. Claude Haiku 5.5 by default; CLAUDE_MODEL overrides it.

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

/**
 * Server-side refusal fallback, for models that offer it. Haiku 5.5 doesn't, so it gets none and a
 * refusal simply stops (each caller already handles that).
 */
export const fallbackOptions = (model = CLAUDE_MODEL): { betas?: ["server-side-fallback-2026-07-01"]; fallbacks?: "default" } =>
  model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
