// Invoices by email through AgentMail (agentmail.to): the business gets an address like
// pay-acme@agentmail.to, AgentMail posts each new email here as a `message.received` webhook, and it
// lands in the inbox like any other invoice. Webhooks are signed with Svix; we verify the
// signature over the raw body and reject anything older than five minutes.
//   AGENTMAIL_WEBHOOK_SECRET  the webhook's secret (whsec_...)
//   AGENTMAIL_INBOX_ID        optional: only accept mail for this inbox

import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { emit } from "../events.js";
import type { InboundEmail } from "./extract.js";

const TOLERANCE_S = 300;

/** Svix: base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), key = base64 after "whsec_". */
export function verifySvix(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, rawBody: string, nowS = Date.now() / 1000): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const stripHtml = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

interface AgentMailMessage {
  inbox_id?: string; message_id?: string; from?: string | string[]; from_?: string | string[]; subject?: string;
  text?: string; html?: string; extracted_text?: string; body_url?: string; timestamp?: string; created_at?: string;
}

/** An AgentMail message as an inbound email; bodies over 64 KiB come by URL. */
export async function toInboundEmail(m: AgentMailMessage, fetchBody: (url: string) => Promise<string> = async (u) => (await fetch(u)).text()): Promise<InboundEmail | undefined> {
  const from = [m.from ?? m.from_].flat()[0];
  let body = m.text?.trim() || (m.html ? stripHtml(m.html) : "");
  if (!body && m.body_url) body = stripHtml(await fetchBody(m.body_url));
  if (!from || !body || !m.message_id) return undefined;
  return { messageId: m.message_id, from, subject: m.subject ?? "(no subject)", body: body.slice(0, 20_000), receivedAt: new Date(m.timestamp ?? m.created_at ?? Date.now()) };
}

export function agentMailRouter(secret: string, receive: (e: InboundEmail) => Promise<unknown>, inboxId = process.env.AGENTMAIL_INBOX_ID): express.Router {
  const r = express.Router();
  r.post("/webhooks/agentmail", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const ok = verifySvix(secret, { id: req.header("svix-id"), timestamp: req.header("svix-timestamp"), signature: req.header("svix-signature") }, raw);
    if (!ok) return void res.status(401).json({ error: "bad signature" });
    const event = JSON.parse(raw) as { event_type?: string; message?: AgentMailMessage };
    if (event.event_type !== "message.received" || !event.message) return void res.status(204).end();
    if (inboxId && event.message.inbox_id !== inboxId) return void res.status(204).end();
    const email = await toInboundEmail(event.message);
    if (!email) {
      emit("observe", "AgentMail delivered an email with no readable body; skipped");
      return void res.status(204).end();
    }
    // Retries carry the same message id, and the inbox ignores an id it has already seen.
    await receive(email);
    res.status(204).end();
  });
  return r;
}

/**
 * Polls an AgentMail inbox over its API, for when Sayso has no public URL for the webhook yet.
 *   AGENTMAIL_API_KEY  the inbox's API key (am_...)
 *   AGENTMAIL_INBOX_ID the inbox, e.g. sayso-invoices@agentmail.to
 */
export class AgentMailPoller {
  private readonly seen = new Set<string>();

  constructor(private readonly apiKey: string, private readonly inboxId: string, private readonly http: typeof fetch = fetch, private readonly base = "https://api.agentmail.to/v0") {}

  static fromEnv(): AgentMailPoller | undefined {
    const { AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID } = process.env;
    return AGENTMAIL_API_KEY && AGENTMAIL_INBOX_ID ? new AgentMailPoller(AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID) : undefined;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.http(`${this.base}/inboxes/${encodeURIComponent(this.inboxId)}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`AgentMail ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  /** Receives the newest messages not seen yet; the inbox also ignores a message id it already has. */
  async poll(receive: (e: InboundEmail) => Promise<unknown>): Promise<number> {
    const { messages } = await this.get<{ messages: Array<{ message_id: string }> }>("/messages?limit=20");
    let n = 0;
    for (const { message_id } of messages.reverse()) {
      if (this.seen.has(message_id)) continue;
      const m = await this.get<AgentMailMessage>(`/messages/${encodeURIComponent(message_id)}`);
      const email = await toInboundEmail({ ...m, text: m.extracted_text || m.text });
      this.seen.add(message_id);
      if (!email) continue;
      await receive(email);
      n++;
    }
    return n;
  }
}

/** Sends mail from the AgentMail inbox (the owner's emailed sign-in links). Needs AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID. */
export function agentMailSenderFromEnv(http: typeof fetch = fetch, base = "https://api.agentmail.to/v0"): ((to: string, subject: string, text: string) => Promise<void>) | undefined {
  const { AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID } = process.env;
  if (!AGENTMAIL_API_KEY || !AGENTMAIL_INBOX_ID) return undefined;
  return async (to, subject, text) => {
    const res = await http(`${base}/inboxes/${encodeURIComponent(AGENTMAIL_INBOX_ID)}/messages/send`, {
      method: "POST", headers: { Authorization: `Bearer ${AGENTMAIL_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`AgentMail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
