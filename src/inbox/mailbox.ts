// Sayso's own email address, so nobody has to set one up. On first start Sayso signs itself up for
// an AgentMail inbox (no account, no console) and keeps the key in its database. Invoices sent to
// that address land in the inbox; Sayso, and agents through it, send and reply from it.
//
// AgentMail lets a self-signed-up inbox receive at once, but it can only email other people after a
// human proves they're there: AgentMail emails OWNER_EMAIL a 6-digit code and the owner types it into
// Sayso once. Until then sending is refused with a clear reason, and receiving still works.
//
// Agents may only email people who already emailed this address or sent an invoice in, so a hijacked
// agent can't use the business's address to write to strangers.
//   AGENTMAIL_API_KEY + AGENTMAIL_INBOX_ID  use an inbox you made in the AgentMail console instead
//   AGENTMAIL_AUTO=off                       don't sign up for one automatically

import { randomBytes, randomUUID } from "node:crypto";
import { emit } from "../events.js";
import type { Store } from "../store.js";

export interface MailMessage {
  message_id: string;
  thread_id: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  text?: string;
  at: string;
}

export interface MailboxStatus {
  address: string | null;
  can_receive: boolean;
  can_send: boolean;
  /** What's left to do before Sayso can email people, in words for the owner. */
  needs: string | null;
}

interface Creds { api_key: string; inbox_id: string; verified: boolean; source: "env" | "signup" }

export class MailError extends Error {}

const addressOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();

export class Mailbox {
  private creds: Creds | null = null;
  /** Offline: a pretend mailbox, so the demo and tests can send, reply and read. */
  private readonly sim: MailMessage[] = [];
  private readonly simAddress = "sayso-demo@agentmail.to";

  constructor(
    private readonly store: Store,
    private readonly opts: { offline?: boolean; ownerEmail?: string; http?: typeof fetch; base?: string } = {},
  ) {
    store.db.exec("CREATE TABLE IF NOT EXISTS mailbox (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const { AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID } = process.env;
    if (AGENTMAIL_API_KEY && AGENTMAIL_INBOX_ID) this.creds = { api_key: AGENTMAIL_API_KEY, inbox_id: AGENTMAIL_INBOX_ID, verified: true, source: "env" };
    else {
      const row = store.db.prepare("SELECT v FROM mailbox WHERE k = 'creds'").get() as { v: string } | undefined;
      if (row) this.creds = JSON.parse(row.v) as Creds;
    }
  }

  private get http() { return this.opts.http ?? fetch; }
  private get base() { return this.opts.base ?? "https://api.agentmail.to/v0"; }
  private save() { this.store.db.prepare("INSERT INTO mailbox (k, v) VALUES ('creds', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(JSON.stringify(this.creds)); }

  status(): MailboxStatus {
    if (this.opts.offline) return { address: this.simAddress, can_receive: true, can_send: true, needs: null };
    if (!this.creds) return { address: null, can_receive: false, can_send: false, needs: process.env.AGENTMAIL_AUTO === "off" ? "Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID." : "Sayso hasn't made its email address yet." };
    if (this.creds.verified) return { address: this.creds.inbox_id, can_receive: true, can_send: true, needs: null };
    return {
      address: this.creds.inbox_id, can_receive: true, can_send: false,
      needs: this.opts.ownerEmail ? `Enter the 6-digit code AgentMail emailed to ${this.opts.ownerEmail}, and Sayso can email people.` : "Set OWNER_EMAIL so AgentMail can send you a code; until then Sayso can receive email but not send it.",
    };
  }

  /** The inbox's key and id, for polling. */
  credentials(): { apiKey: string; inboxId: string } | undefined {
    return this.creds && !this.opts.offline ? { apiKey: this.creds.api_key, inboxId: this.creds.inbox_id } : undefined;
  }

  /** Makes Sayso's address if it has none: AgentMail's agent sign-up, no account needed. */
  async ensure(): Promise<MailboxStatus> {
    if (this.opts.offline || this.creds || process.env.AGENTMAIL_AUTO === "off") return this.status();
    const username = `sayso-${randomBytes(4).toString("hex")}`;
    const res = await this.http(`${this.base}/agent/sign-up`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, source: "sayso", ...(this.opts.ownerEmail ? { human_email: this.opts.ownerEmail } : {}) }),
    });
    if (!res.ok) throw new MailError(`AgentMail sign-up ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { inbox_id: string; api_key: string };
    this.creds = { api_key: body.api_key, inbox_id: body.inbox_id, verified: false, source: "signup" };
    this.save();
    emit("observe", `Sayso's email address is ${body.inbox_id}. Forward invoices there.${this.opts.ownerEmail ? ` AgentMail sent a code to ${this.opts.ownerEmail}; enter it in Sayso so it can email people too.` : ""}`);
    return this.status();
  }

  /** The owner's 6-digit code from AgentMail: lifts the send block on a self-made inbox. */
  async verify(otp: string): Promise<MailboxStatus> {
    if (this.opts.offline || this.creds?.verified) return this.status();
    if (!this.creds) throw new MailError("Sayso has no email address yet.");
    const res = await this.call("POST", "/agent/verify", { otp_code: otp.trim() }, false);
    if (!(res as { verified?: boolean }).verified) throw new MailError("That code didn't work.");
    this.creds.verified = true;
    this.save();
    return this.status();
  }

  private async call(method: string, path: string, body?: unknown, inInbox = true): Promise<unknown> {
    if (!this.creds) throw new MailError("Sayso has no email address yet.");
    const url = `${this.base}${inInbox ? `/inboxes/${encodeURIComponent(this.creds.inbox_id)}` : ""}${path}`;
    const res = await this.http(url, { method, headers: { Authorization: `Bearer ${this.creds.api_key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      if (res.status === 403 && /allow list|message_rejected/.test(t)) throw new MailError(this.status().needs ?? "AgentMail refused to send this.");
      if (res.status === 429) throw new MailError("Sayso's email has hit AgentMail's sending limit for now. Try again later.");
      throw new MailError(`AgentMail ${res.status}: ${t}`);
    }
    return res.json();
  }

  async list(limit = 20): Promise<MailMessage[]> {
    if (this.opts.offline) return this.sim.slice(-limit).reverse();
    const { messages } = (await this.call("GET", `/messages?limit=${Math.min(limit, 50)}`)) as { messages: Array<Record<string, unknown>> };
    return messages.map((m) => ({
      message_id: String(m.message_id), thread_id: String(m.thread_id), from: String(m.from ?? ""), to: (m.to as string[]) ?? [],
      subject: String(m.subject ?? "(no subject)"), preview: String(m.preview ?? ""), at: String(m.timestamp ?? m.created_at ?? ""),
    }));
  }

  async get(messageId: string): Promise<MailMessage | undefined> {
    if (this.opts.offline) return this.sim.find((m) => m.message_id === messageId);
    const m = (await this.call("GET", `/messages/${encodeURIComponent(messageId)}`)) as Record<string, unknown>;
    return {
      message_id: String(m.message_id), thread_id: String(m.thread_id), from: String(m.from ?? ""), to: (m.to as string[]) ?? [],
      subject: String(m.subject ?? "(no subject)"), preview: String(m.preview ?? ""), text: String(m.extracted_text ?? m.text ?? ""), at: String(m.timestamp ?? m.created_at ?? ""),
    };
  }

  /** People an agent may write to: whoever emailed this address, or sent an invoice in by email. */
  async knows(address: string, invoiceSenders: string[] = []): Promise<boolean> {
    const a = addressOf(address);
    if (invoiceSenders.some((s) => addressOf(s) === a)) return true;
    return (await this.list(50)).some((m) => addressOf(m.from) === a);
  }

  async send(to: string, subject: string, text: string): Promise<{ message_id: string; thread_id: string }> {
    if (this.opts.offline) return this.record(to, subject, text);
    return (await this.call("POST", "/messages/send", { to: [to], subject, text })) as { message_id: string; thread_id: string };
  }

  /** Replies in the same thread, so the answer comes back to this inbox with the history. */
  async reply(messageId: string, text: string): Promise<{ message_id: string; thread_id: string }> {
    if (this.opts.offline) {
      const m = this.sim.find((x) => x.message_id === messageId);
      return this.record(m?.from ?? "unknown@example.com", `Re: ${m?.subject ?? ""}`, text, m?.thread_id);
    }
    return (await this.call("POST", `/messages/${encodeURIComponent(messageId)}/reply`, { text })) as { message_id: string; thread_id: string };
  }

  /** A sender for code that just needs to email someone (sign-in links, the one-cent check). */
  sender(): ((to: string, subject: string, text: string) => Promise<void>) | undefined {
    if (this.opts.offline || !this.creds) return undefined;
    return async (to, subject, text) => { await this.send(to, subject, text); };
  }

  /** Offline: an email that arrived, so agents have someone to reply to. */
  simReceive(from: string, subject: string, text: string): MailMessage {
    const m: MailMessage = { message_id: `<sim-${randomUUID()}@agentmail.to>`, thread_id: randomUUID(), from, to: [this.simAddress], subject, preview: text.slice(0, 140), text, at: new Date().toISOString() };
    this.sim.push(m);
    return m;
  }

  private record(to: string, subject: string, text: string, thread: string = randomUUID()) {
    const m: MailMessage = { message_id: `<sim-${randomUUID()}@agentmail.to>`, thread_id: thread, from: this.simAddress, to: [to], subject, preview: text.slice(0, 140), text, at: new Date().toISOString() };
    this.sim.push(m);
    emit("observe", `Offline: emailed ${to}: "${subject}"`);
    return { message_id: m.message_id, thread_id: m.thread_id };
  }
}
