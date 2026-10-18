// Coin Slot's hosted MCP endpoint (Streamable HTTP at /mcp). Any agent that speaks MCP can add it by
// URL with its own key: Claude, ChatGPT, Cursor, OpenClaw, Hermes, or the assistant someone texts
// from iMessage. An agent can quote, forward an invoice and check status. Approving is not a tool:
// the owner gets a link and taps it while signed in, so a hijacked agent can't pay anyone.
// Agents with their own USDZ still pay quotes directly over x402 (pay_url), capped by Metal.

import express, { type Request } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentKey, AgentKeys } from "../agents/keys.js";
import { emit } from "../events.js";
import type { Inbox, InboxItem } from "../inbox/inbox.js";
import type { Notifier } from "../notify.js";
import { PayoutError, publicView, type PayoutService } from "../payouts/service.js";
import { toMinor } from "../treasury/money.js";
import { invoiceShape, toRequest, type Invoice } from "./tools.js";

export interface HostedDeps { svc: PayoutService; inbox: Inbox; keys: AgentKeys; notify: Notifier }

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const fail = (message: string) => ({ ...text({ error: message }), isError: true });

/** Where people reach this server: PUBLIC_URL, or the host the agent called. */
const baseUrl = (req: Request) => process.env.PUBLIC_URL ?? `${req.header("x-forwarded-proto") ?? req.protocol}://${req.header("host")}`;
export const approvalPath = (id: string) => `/approve/${encodeURIComponent(id)}`;

function summarise(item: InboxItem & { payout?: ReturnType<typeof publicView> | null }, base: string) {
  const p = item.payout;
  const what = p ? `${p.amount} ${p.currency} to ${p.payee}` : item.subject;
  const next: Record<string, string> = {
    awaiting_approval: `Waiting for the owner's tap. Send them this link: ${base}${approvalPath(item.id)}`,
    needs_verification: `Held: ${p?.reasons.join("; ") || "looks risky"}. The owner must confirm the bank details with the payee directly, not by email. Link: ${base}${approvalPath(item.id)}`,
    needs_details: `Missing: ${item.missing.join(", ")}. Forward it again with those details, or the owner can fill them in: ${base}${approvalPath(item.id)}`,
    duplicate: "Already in the inbox; not queued again.",
    rejected: `Coin Slot won't pay this: ${p?.reasons.join("; ")}`,
    paying: `Approved and paying. Payout status: ${p?.status}.`,
    ignored: "The owner ignored it.",
  };
  return { invoice_id: item.id, status: item.status, what, next: next[item.status], approval_url: `${base}${approvalPath(item.id)}`, payout_id: item.payoutId };
}

function buildServer(d: HostedDeps, agent: AgentKey, base: string): McpServer {
  const server = new McpServer({ name: "coinslot", version: "0.2.0" }, { instructions: "Coin Slot pays real-world invoices in local currency through Airwallex. Forward invoices with forward_invoice; the owner approves each payment themselves from a link. Never tell the owner a payment is made until payout_status says paid." });
  const overCap = (priceUsdz: string) => agent.capMinor !== null && toMinor(Number(priceUsdz)) > agent.capMinor;

  server.registerTool("forward_invoice", {
    description: "Put an invoice in the owner's Coin Slot inbox. Paste the whole invoice or email text (OCR the photo first if you were sent one). Coin Slot reads it, checks the payee with Airwallex, and sends the owner a one-tap approval link. Returns the link and what happens next.",
    inputSchema: {
      text: z.string().min(1).max(20_000).describe("The full invoice or email text, including bank details and the total"),
      from: z.string().optional().describe("Who sent the invoice, e.g. \"Kreuzberg Studio <billing@kreuzberg.de>\""),
      subject: z.string().optional(),
    },
  }, async ({ text: body, from, subject }) => {
    const item = await d.inbox.receive({ messageId: `agent-${agent.id.slice(0, 8)}-${randomUUID()}`, from: from ?? `${agent.name} (agent)`, subject: subject ?? `Forwarded by ${agent.name}`, body, receivedAt: new Date() });
    const full = d.inbox.list().find((i) => i.id === item.id)!;
    if (full.payout && overCap(full.payout.price_usdz) && ["awaiting_approval", "needs_verification"].includes(full.status)) {
      d.inbox.ignore(item.id);
      emit("refuse", `${agent.name} forwarded ${full.payout.amount} ${full.payout.currency}, above its cap; not queued`);
      return fail(`That's above this agent's cap of ${(agent.capMinor! / 100).toFixed(2)} USD per payout. Ask the owner to forward it themselves.`);
    }
    const s = summarise(full, base);
    if (["awaiting_approval", "needs_verification", "needs_details"].includes(full.status)) {
      void d.notify(full.status === "needs_verification" ? "Check before paying" : full.status === "needs_details" ? "Invoice needs details" : "Invoice to approve", `${s.what} (from ${agent.name})`, approvalPath(item.id));
    }
    return text(s);
  });

  server.registerTool("list_invoices", {
    description: "The owner's Coin Slot inbox: invoices waiting for their tap, held for a check, missing details, or paying.",
    inputSchema: { include_done: z.boolean().optional().describe("Also list paid, ignored and duplicate invoices") },
  }, async ({ include_done }) => {
    const items = d.inbox.list().filter((i) => include_done || ["awaiting_approval", "needs_verification", "needs_details", "paying"].includes(i.status));
    return text(items.slice(0, 50).map((i) => summarise(i, base)));
  });

  server.registerTool("quote_payout", {
    description: "Price a payout in local currency, for free. Returns the USDZ price and a pay_url an x402-capable agent can pay from its own Metal wallet, or why Coin Slot won't pay it as asked.",
    inputSchema: invoiceShape,
  }, async (i) => {
    try {
      const p = await d.svc.quote(toRequest(i as Invoice));
      if (overCap(publicView(p).price_usdz)) return fail(`Price ${publicView(p).price_usdz} USDZ is above this agent's cap.`);
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
  // /mcp with a Bearer header, or /mcp/k/<key> for chat apps whose "add connector by URL" box can't set headers.
  r.post(["/mcp", "/mcp/k/:key"], express.json({ limit: "512kb" }), async (req, res) => {
    const key = (req.params.key as string | undefined) ?? req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const agent = key ? d.keys.verify(key) : undefined;
    if (!agent) {
      res.setHeader("www-authenticate", 'Bearer realm="coinslot"');
      return void res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Send your Coin Slot agent key as a Bearer token. The owner creates one in the app's Agents tab." }, id: null });
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
