// Sayso as an MCP server: any Claude agent (Claude Code, Claude Desktop, the Agent SDK) can
// pay a real-world invoice in local currency. The agent's own Metal key pays over x402; Sayso
// pays the invoice through Airwallex.
//
//   claude mcp add sayso -- npx tsx src/mcp/server.ts
//   env: SAYSO_URL, SAYSO_BUYER_KEY (a Metal testnet key), SAYSO_MAX_USDZ (spend cap per payout)
//   or:  SAYSO_MANDATE (a credential from `npm run setup:agent-budget`): pay from the owner's account,
//        within the limits the owner bound on Metal, signing each exact order with the mandate key
//   offline: SAYSO_SIM_PAYER=0x... (or SAYSO_SIM_MANDATE=<ref>) against `npm run serve:offline`

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { createMetalPaymentClient, usdzBaseUnits } from "@metalntwx/metal-pay";
import { createMandatePaymentClient, p256DigestSigner, parseCredential, privateKeyHex, type Es256Key } from "@metalntwx/metal-pay/mandates";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { invoiceShape, toRequest, type Invoice } from "./tools.js";

const base = process.env.SAYSO_URL ?? "http://127.0.0.1:4021";
const maxUsdz = process.env.SAYSO_MAX_USDZ ?? "250";
const simPayer = process.env.SAYSO_SIM_PAYER;
const simMandate = process.env.SAYSO_SIM_MANDATE;

function payingFetch(): typeof fetch {
  if (simMandate) return (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-sim-mandate": simMandate, "x-sim-signed-order": "sim" } });
  if (simPayer) return (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-sim-payer": simPayer } });
  const mandate = process.env.SAYSO_MANDATE;
  if (mandate) {
    // The owner's account pays; Metal refuses anything outside the mandate the owner bound, and the
    // agent's mandate key signs Sayso's exact offer, so a payment can't be replayed for another quote.
    const agentKeyFile = process.env.SAYSO_MANDATE_AGENT_KEY ?? mandate.replace(/\.json$/, ".agent-key.json");
    const agent = JSON.parse(readFileSync(agentKeyFile, "utf8")) as Es256Key;
    const credential = parseCredential(JSON.parse(readFileSync(mandate, "utf8")));
    return createMandatePaymentClient({ credential, signDigest: p256DigestSigner(privateKeyHex(agent)), network: "testnet", signedOffer: "always" }).fetchWithPayment as typeof fetch;
  }
  const key = process.env.SAYSO_BUYER_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("Set SAYSO_BUYER_KEY (a Metal testnet private key) or SAYSO_SIM_PAYER for offline use");
  // Metal refuses to sign above maxAmount, so a wrong quote can never overspend the agent's wallet.
  return createMetalPaymentClient({ account: privateKeyToAccount(key), network: "testnet", maxAmount: BigInt(usdzBaseUnits(maxUsdz)) }).fetchWithPayment as typeof fetch;
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

async function quote(i: Invoice) {
  const res = await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toRequest(i)) });
  return (await res.json()) as { id: string; status: string; price_usdz: string; pay_url: string | null; reasons: string[] };
}

async function pay(id: string) {
  const res = await payingFetch()(`${base}/v1/payouts/${id}/pay`, { method: "POST" });
  return { http_status: res.status, ...((await res.json().catch(() => ({}))) as object) };
}

const server = new McpServer({ name: "sayso", version: "0.1.0" });

server.registerTool("quote_payout", {
  description: "Price a real-world payout in local currency (free). Returns the USDZ price, or why Sayso will not pay it as asked.",
  inputSchema: invoiceShape,
}, async (i) => text(await quote(i as Invoice)));

server.registerTool("pay_invoice", {
  description: "Pay a real-world invoice in local currency through Airwallex, paying Sayso in USDZ over x402 on Metal. Quotes first and pays only if the price is at most max_usdz. Suspicious invoices are held for a human, and failed payouts are refunded in full.",
  inputSchema: { ...invoiceShape, max_usdz: z.string().describe("The most this agent will pay in USDZ, fees included") },
}, async (i) => {
  const q = await quote(i as Invoice);
  if (q.status !== "quoted" || !q.pay_url) return text({ paid: false, ...q });
  if (Number(q.price_usdz) > Number(i.max_usdz)) return text({ paid: false, reason: `price ${q.price_usdz} USDZ is above max_usdz ${i.max_usdz}`, quote: q });
  const r = await pay(q.id);
  return text({ paid: r.http_status < 400, quote_id: q.id, ...r });
});

server.registerTool("pay_batch", {
  description: "Pay many people at once (e.g. a marketplace's sellers or a team of contractors) with ONE USDZ payment over x402. Each line is checked like a single payout; lines Sayso won't pay are set aside with reasons and not charged. Pays only if the batch price is at most max_usdz. A line that bounces is refunded on its own.",
  inputSchema: { items: z.array(z.object(invoiceShape)).min(1).max(100), reference: z.string().optional(), max_usdz: z.string().describe("The most this agent will pay for the whole batch, fees included") },
}, async ({ items, reference, max_usdz }) => {
  const res = await fetch(`${base}/v1/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: reference ?? "Batch payout", items: items.map((i) => toRequest(i as Invoice)) }) });
  const b = (await res.json()) as { id?: string; price_usdz?: string; pay_url?: string | null; set_aside?: unknown[]; error?: string };
  if (!b.pay_url) return text({ paid: false, ...b });
  if (Number(b.price_usdz) > Number(max_usdz)) return text({ paid: false, reason: `batch price ${b.price_usdz} USDZ is above max_usdz ${max_usdz}`, batch: b });
  const paid = await payingFetch()(`${base}${b.pay_url}`, { method: "POST" });
  return text({ paid: paid.status < 400, http_status: paid.status, ...((await paid.json().catch(() => ({}))) as object) });
});

server.registerTool("batch_status", {
  description: "Progress of a batch payout: how many lines are paid, on their way, or refunded.",
  inputSchema: { batch_id: z.string() },
}, async ({ batch_id }) => text(await (await fetch(`${base}/v1/batches/${batch_id}`)).json()));

server.registerTool("pay_quote", {
  description: "Pay an existing Sayso quote by id.",
  inputSchema: { quote_id: z.string() },
}, async ({ quote_id }) => text(await pay(quote_id)));

server.registerTool("payout_receipt", {
  description: "A final payout's receipt and the Metal transaction anchoring its hash, so the agent can prove the money was delivered (or refunded) without trusting Sayso.",
  inputSchema: { payout_id: z.string() },
}, async ({ payout_id }) => text(await (await fetch(`${base}/v1/payouts/${payout_id}/receipt`)).json()));

server.registerTool("payout_status", {
  description: "Where a payout is: quoted, needs_review, accepted, funded, submitted, paid, failed, refunded.",
  inputSchema: { payout_id: z.string() },
}, async ({ payout_id }) => text(await (await fetch(`${base}/v1/payouts/${payout_id}`)).json()));

await server.connect(new StdioServerTransport());
