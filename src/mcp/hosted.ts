// Sayso's hosted MCP endpoint (Streamable HTTP at /mcp). Any agent that speaks MCP can add it by
// URL with its own key: Claude, ChatGPT, Cursor, OpenClaw, Hermes, or the assistant someone texts
// from iMessage. An agent can quote, forward an invoice and check status. Approving is not a tool:
// the owner gets a link and taps it while signed in, so a hijacked agent can't pay anyone.
// Agents with their own USDZ still pay quotes directly over x402 (pay_url), capped by Metal.

import express, { type Request } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentKey, AgentKeys } from "../agents/keys.js";
import { emit } from "../events.js";
import type { Inbox, InboxItem } from "../inbox/inbox.js";
import type { Notifier } from "../notify.js";
import { PayoutError, publicView, type PayoutService } from "../payouts/service.js";
import { toMinor } from "../treasury/money.js";
import { MailError, type Mailbox } from "../inbox/mailbox.js";
import { invoiceShape, toRequest, type Invoice } from "./tools.js";

export interface HostedDeps { svc: PayoutService; inbox: Inbox; keys: AgentKeys; notify: Notifier; mailbox?: Mailbox }

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const fail = (message: string) => ({ ...text({ error: message }), isError: true });

/** Where people reach this server: PUBLIC_URL, or the host the agent called. */
const baseUrl = (req: Request) => process.env.PUBLIC_URL ?? `${req.header("x-forwarded-proto") ?? req.protocol}://${req.header("host")}`;
/** Points an agent without credentials at the auth.md discovery chain (RFC 9728). */
const resourceMetadata = (req: Request) => `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;
/** Invoice ids are often whole email Message-IDs, so links carry a short hash of one instead. */
export const shortCode = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 8);
export const approvalPath = (id: string) => `/p/${shortCode(id)}`;

function summarise(item: InboxItem & { payout?: ReturnType<typeof publicView> | null }, base: string) {
  const p = item.payout;
  const what = p ? `${p.amount} ${p.currency} to ${p.payee}` : item.subject;
  const next: Record<string, string> = {
    awaiting_approval: `Waiting for the owner's tap. Send them this link: ${base}${approvalPath(item.id)}`,
    needs_verification: `Held: ${p?.reasons.join("; ") || "looks risky"}. The owner must confirm the bank details with the payee directly, not by email. Link: ${base}${approvalPath(item.id)}`,
    needs_details: `Missing: ${item.missing.join(", ")}. Forward it again with those details, or the owner can fill them in: ${base}${approvalPath(item.id)}`,
    duplicate: "Already in the inbox; not queued again.",
    rejected: `Sayso won't pay this: ${p?.reasons.join("; ")}`,
    paying: `Approved and paying. Payout status: ${p?.status}.`,
    ignored: "The owner ignored it.",
  };
  return { invoice_id: item.id, status: item.status, what, next: next[item.status], approval_url: `${base}${approvalPath(item.id)}`, payout_id: item.payoutId };
}

// The cards view chat apps draw inline (an MCP App): swipe through invoices, tap one, swipe to approve.
// Approving still opens Sayso, where the owner signs with their passkey; the view can't pay anyone.
export const VIEW_URI = "ui://sayso/cards.html";
const VIEW_MIME = "text/html;profile=mcp-app";
const viewHtml = readFileSync(new URL("./view.html", import.meta.url), "utf8");
const withView = { ui: { resourceUri: VIEW_URI }, "ui/resourceUri": VIEW_URI };

type Listed = ReturnType<Inbox["list"]>[number];
/** One card for the view: who, how much, why it's waiting, and the owner's approval link. */
export function cardOf(item: Listed, base: string) {
  const p = item.payout, f = item.fields;
  const account = (f.iban ?? f.accountNumber ?? "").replace(/\s/g, "");
  const via = item.id.startsWith("agent-") ? (item.subject.match(/^Forwarded by (.+)$/)?.[1] ?? "Your agent") : null;
  return {
    id: item.id, status: item.status, from: item.from, subject: item.subject, received_at: item.receivedAt,
    payee: p?.payee ?? f.payeeName, amount: p?.amount ?? f.amount, currency: p?.currency ?? f.currency,
    reference: p?.reference ?? f.reference, due: f.dueDate, account: account.length >= 4 ? account.slice(-4) : null,
    reasons: p?.reasons ?? [], missing: item.missing, price_usdz: p?.price_usdz ?? null, forwarded_by: via,
    approval_url: `${base}${approvalPath(item.id)}`,
    // What Sayso decided and why, so the card can lead with it.
    decision: p?.decision ? { verdict: p.decision.verdict, decided_by: p.decision.decided_by, reason: p.decision.reason, inputs: p.decision.inputs } : null,
  };
}
const cards = (d: HostedDeps, base: string, include_done?: boolean) =>
  d.inbox.list().filter((i) => include_done || pending.includes(i.status)).slice(0, 50).map((i) => cardOf(i, base));

// Emails an agent may send through Sayso's address in a day, so a runaway agent can't spam from it.
const EMAILS_PER_DAY = 20;
const sentToday = new Map<string, { day: string; n: number }>();
function spend(agent: AgentKey): boolean {
  const day = new Date().toISOString().slice(0, 10), s = sentToday.get(agent.id);
  if (!s || s.day !== day) { sentToday.set(agent.id, { day, n: 1 }); return true; }
  return s.n < EMAILS_PER_DAY ? (s.n++, true) : false;
}
const emailOf = (from: string) => from.match(/<([^>]+)>/)?.[1]?.trim() ?? (/^[^\s@]+@[^\s@]+$/.test(from.trim()) ? from.trim() : null);

/** Asks whoever sent an invoice for what it's missing, from Sayso's address, in the same thread when it came by email. */
async function askForDetails(d: HostedDeps, agent: AgentKey, invoiceId: string, note?: string) {
  const mb = d.mailbox;
  if (!mb) return { error: "Sayso has no email set up." };
  const item = d.inbox.list().find((i) => i.id === invoiceId);
  if (!item) return { error: "No such invoice." };
  if (item.status !== "needs_details") return { error: "That invoice isn't missing anything." };
  const to = emailOf(item.from);
  if (!to) return { error: `Sayso doesn't have an email address for ${item.from}.` };
  if (!spend(agent)) return { error: `This agent has sent its ${EMAILS_PER_DAY} emails for today.` };
  const about = item.subject && !/^Forwarded by/.test(item.subject) ? ` ("${item.subject}")` : "";
  const text = `Hello,\n\nThanks for your invoice${about}. Before we can pay it, we need: ${item.missing.join(", ")}.${note ? `\n\n${note}` : ""}\n\nReply to this email with those details and we'll take it from there.\n\nThanks`;
  try {
    const original = await mb.get(item.id).catch(() => undefined);
    const r = original ? await mb.reply(item.id, text) : await mb.send(to, about ? `Re: ${item.subject}` : "About your invoice", text);
    emit("observe", `${agent.name} asked ${to} for the missing ${item.missing.join(", ")}`);
    return { sent_to: to, from: mb.status().address, message_id: r.message_id, thread_id: r.thread_id, next: "Their reply comes back to Sayso's inbox and shows up as an invoice again." };
  } catch (err) {
    return { error: err instanceof MailError ? err.message : "Sending failed." };
  }
}

const overCap = (agent: AgentKey, priceUsdz: string) => agent.capMinor !== null && toMinor(Number(priceUsdz)) > agent.capMinor;
const pending = ["awaiting_approval", "needs_verification", "needs_details", "paying"];

/** An agent hands Sayso an invoice: into the owner's inbox, with a link and a push for their tap. */
async function forward(d: HostedDeps, agent: AgentKey, base: string, a: { text: string; from?: string; subject?: string }) {
  const item = await d.inbox.receive({ messageId: `agent-${agent.id.slice(0, 8)}-${randomUUID()}`, from: a.from ?? `${agent.name} (agent)`, subject: a.subject ?? `Forwarded by ${agent.name}`, body: a.text, receivedAt: new Date() });
  const full = d.inbox.list().find((i) => i.id === item.id)!;
  if (full.payout && overCap(agent, full.payout.price_usdz) && ["awaiting_approval", "needs_verification"].includes(full.status)) {
    d.inbox.ignore(item.id);
    emit("refuse", `${agent.name} forwarded ${full.payout.amount} ${full.payout.currency}, above its cap; not queued`);
    return { error: `That's above this agent's cap of ${(agent.capMinor! / 100).toFixed(2)} USD per payout. Ask the owner to forward it themselves.` };
  }
  const s = summarise(full, base);
  if (["awaiting_approval", "needs_verification", "needs_details"].includes(full.status)) {
    void d.notify(full.status === "needs_verification" ? "Check before paying" : full.status === "needs_details" ? "Invoice needs details" : "Invoice to approve", `${s.what} (from ${agent.name})`, approvalPath(item.id));
  }
  return s;
}

function buildServer(d: HostedDeps, agent: AgentKey, base: string): McpServer {
  const server = new McpServer({ name: "sayso", version: "0.2.0" }, { instructions: "Sayso pays real-world invoices in local currency through Airwallex. Forward invoices with forward_invoice; the owner approves each payment themselves from a link. Never tell the owner a payment is made until payout_status says paid." });

  server.registerTool("forward_invoice", {
    description: "Put an invoice in the owner's Sayso inbox. Paste the whole invoice or email text (OCR the photo first if you were sent one). Sayso reads it, checks the payee with Airwallex, and sends the owner a one-tap approval link. Returns the link and what happens next.",
    _meta: withView,
    inputSchema: {
      text: z.string().min(1).max(20_000).describe("The full invoice or email text, including bank details and the total"),
      from: z.string().optional().describe("Who sent the invoice, e.g. \"Kreuzberg Studio <billing@kreuzberg.de>\""),
      subject: z.string().optional(),
    },
  }, async (args) => {
    const r = await forward(d, agent, base, args);
    if ("error" in r) return fail(r.error);
    return { ...text(r), structuredContent: { items: cards(d, base, true).filter((c) => c.id === r.invoice_id || pending.includes(c.status)), focus: r.invoice_id } };
  });

  server.registerTool("list_invoices", {
    description: "The owner's Sayso inbox: invoices waiting for their tap, held for a check, missing details, or paying. Chat apps that support MCP Apps show them as cards the owner can swipe through and approve.",
    _meta: withView,
    inputSchema: { include_done: z.boolean().optional().describe("Also list paid, ignored and duplicate invoices") },
  }, async ({ include_done }) => {
    const items = d.inbox.list().filter((i) => include_done || pending.includes(i.status));
    return { ...text(items.slice(0, 50).map((i) => summarise(i, base))), structuredContent: { items: cards(d, base, include_done) } };
  });

  server.registerResource("cards", VIEW_URI, { title: "Sayso cards", description: "Invoices as cards: swipe, tap to open, swipe to approve in Sayso.", mimeType: VIEW_MIME }, async () => ({
    contents: [{
      uri: VIEW_URI, mimeType: VIEW_MIME, text: viewHtml,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] } } },
    }],
  }));

  if (d.mailbox) {
    const mb = d.mailbox;
    const senders = () => d.inbox.list().map((i) => i.from);
    const mailFail = (err: unknown) => fail(err instanceof MailError ? err.message : "email failed");

    server.registerTool("ask_for_details", {
      description: "Email whoever sent an invoice that's missing details (payee, amount, bank account) and ask for them, from Sayso's own address. Their reply comes back into Sayso. Use this rather than your own email.",
      _meta: { ui: { resourceUri: VIEW_URI, visibility: ["model", "app"] } },
      inputSchema: { invoice_id: z.string(), note: z.string().max(1000).optional().describe("Anything to add, in plain words") },
    }, async ({ invoice_id, note }) => {
      const r = await askForDetails(d, agent, invoice_id, note);
      return "error" in r ? fail(r.error ?? "failed") : text(r);
    });

    server.registerTool("email_inbox", {
      description: "Sayso's own email address and the newest emails in it: invoices, suppliers' replies, and what Sayso sent. Use it to see if a supplier answered.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    }, async ({ limit }) => {
      try { return text({ ...mb.status(), messages: await mb.list(limit ?? 20) }); } catch (err) { return mailFail(err); }
    });

    server.registerTool("read_email", {
      description: "One email in Sayso's inbox, with its full text.",
      inputSchema: { message_id: z.string() },
    }, async ({ message_id }) => {
      try { const m = await mb.get(message_id); return m ? text(m) : fail("no such email"); } catch (err) { return mailFail(err); }
    });

    server.registerTool("send_email", {
      description: "Send an email from Sayso's own address, so you don't need another email account. Only to people who already emailed Sayso or sent it an invoice; to answer an email, use reply_email so it stays in the thread.",
      inputSchema: { to: z.string().email(), subject: z.string().min(1).max(200), text: z.string().min(1).max(10_000) },
    }, async ({ to, subject, text: body }) => {
      try {
        if (!(await mb.knows(to, senders()))) return fail(`Sayso only emails people who have emailed it or sent an invoice in, and ${to} hasn't.`);
        if (!spend(agent)) return fail(`This agent has sent its ${EMAILS_PER_DAY} emails for today.`);
        const r = await mb.send(to, subject, body);
        emit("observe", `${agent.name} emailed ${to} from Sayso: "${subject}"`);
        return text({ ...r, from: mb.status().address });
      } catch (err) { return mailFail(err); }
    });

    server.registerTool("reply_email", {
      description: "Reply to an email in Sayso's inbox, from Sayso's address, in the same thread.",
      inputSchema: { message_id: z.string(), text: z.string().min(1).max(10_000) },
    }, async ({ message_id, text: body }) => {
      try {
        if (!spend(agent)) return fail(`This agent has sent its ${EMAILS_PER_DAY} emails for today.`);
        const r = await mb.reply(message_id, body);
        emit("observe", `${agent.name} replied from Sayso to email ${message_id.slice(0, 40)}`);
        return text({ ...r, from: mb.status().address });
      } catch (err) { return mailFail(err); }
    });
  }

  server.registerTool("quote_payout", {
    description: "Price a payout in local currency, for free. Returns the USDZ price and a pay_url an x402-capable agent can pay from its own Metal wallet, or why Sayso won't pay it as asked.",
    inputSchema: invoiceShape,
  }, async (i) => {
    try {
      const p = await d.svc.quote(toRequest(i as Invoice));
      if (overCap(agent, publicView(p).price_usdz)) return fail(`Price ${publicView(p).price_usdz} USDZ is above this agent's cap.`);
      return text({ ...publicView(p), pay_url: p.status === "quoted" ? `${base}/v1/payouts/${p.id}/pay` : null });
    } catch (err) {
      return fail(err instanceof PayoutError ? err.message : "quote failed");
    }
  });

  server.registerTool("payout_status", {
    description: "Where a payout is: quoted, needs_review, accepted, funded, submitted, paid, failed, refunded.",
    inputSchema: { payout_id: z.string() },
  }, async ({ payout_id }) => {
    const p = d.svc.book.get(payout_id);
    return p ? text(publicView(p)) : fail("no such payout");
  });

  return server;
}

export function hostedMcpRouter(d: HostedDeps): express.Router {
  const r = express.Router();
  const agentOf = (req: Request) => {
    const key = (req.params.key as string | undefined) ?? req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    return key ? d.keys.verify(key) : undefined;
  };

  // The same two actions as plain REST, for agent frameworks that run curl from a skill (OpenClaw, Hermes).
  r.post("/v1/agent/invoices", express.json({ limit: "256kb" }), async (req, res) => {
    const agent = agentOf(req);
    if (!agent) return void res.status(401).setHeader("www-authenticate", resourceMetadata(req)).json({ error: `send your Sayso agent key or access token as a Bearer token; to sign up, read ${baseUrl(req)}/auth.md` });
    const b = req.body as { text?: unknown; from?: unknown; subject?: unknown };
    if (typeof b?.text !== "string" || !b.text.trim()) return void res.status(400).json({ error: "text is required: the whole invoice or email" });
    const r2 = await forward(d, agent, baseUrl(req), { text: b.text.slice(0, 20_000), from: typeof b.from === "string" ? b.from : undefined, subject: typeof b.subject === "string" ? b.subject : undefined });
    res.status("error" in r2 ? 422 : 201).json(r2);
  });
  r.get("/v1/agent/invoices", (req, res) => {
    const agent = agentOf(req);
    if (!agent) return void res.status(401).setHeader("www-authenticate", resourceMetadata(req)).json({ error: `send your Sayso agent key or access token as a Bearer token; to sign up, read ${baseUrl(req)}/auth.md` });
    res.json(d.inbox.list().filter((i) => pending.includes(i.status)).slice(0, 50).map((i) => summarise(i, baseUrl(req))));
  });

  // /mcp with a Bearer header, or /mcp/k/<key> for chat apps whose "add connector by URL" box can't set headers.
  r.post(["/mcp", "/mcp/k/:key"], express.json({ limit: "512kb" }), async (req, res) => {
    const agent = agentOf(req);
    if (!agent) {
      res.setHeader("www-authenticate", resourceMetadata(req));
      return void res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Send your Sayso agent key or access token as a Bearer token. To sign up for your user, read /auth.md." }, id: null });
    }
    // Stateless: a fresh server and transport per request, so nothing leaks between agents.
    const server = buildServer(d, agent, baseUrl(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  r.all(["/mcp", "/mcp/k/:key"], (_req, res) => res.status(405).setHeader("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "POST only (stateless Streamable HTTP)" }, id: null }));
  return r;
}
