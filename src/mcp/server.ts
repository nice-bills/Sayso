// Sayso as an MCP server: any Claude agent (Claude Code, Claude Desktop, the Agent SDK) can
// pay a real-world invoice in local currency. The agent's own Metal key pays over x402; Sayso
// pays the invoice through Airwallex.
//
//   claude mcp add sayso -- npx tsx src/mcp/server.ts
//   env: SAYSO_URL, SAYSO_BUYER_KEY (a Metal testnet key), SAYSO_MAX_USDZ (spend cap per payout),
//        SAYSO_SPENDABLE_USDZ (what the agent can spend now; a short budget waits or splits)
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
import { disputeMessage } from "../payouts/dispute-auth.js";

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

/** Offline, the same headers that paid say who is disputing. */
const simHeaders = (): Record<string, string> => (simMandate ? { "x-sim-mandate": simMandate } : simPayer ? { "x-sim-payer": simPayer } : {});

/** Live, the key that paid signs the dispute, so only the payer can start one. A mandate's payer is the owner's account, which signs in Sayso instead. */
async function signDispute(payoutId: string, claim: string): Promise<{ signature?: string; issued_at?: string }> {
  const key = process.env.SAYSO_BUYER_KEY as `0x${string}` | undefined;
  if (!key || simPayer || simMandate) return {};
  const issued_at = new Date().toISOString();
  return { issued_at, signature: await privateKeyToAccount(key).signMessage({ message: disputeMessage(payoutId, claim, issued_at) }) };
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

type Decision = { verdict: "pay" | "wait" | "split" | "hold" | "reject"; decided_by: string; reason: string };

async function quote(i: Invoice, limits: { max_usdz?: string; spendable_usdz?: string } = {}) {
  const res = await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...toRequest(i), ...limits }) });
  return (await res.json()) as { id: string; status: string; price_usdz: string; pay_url: string | null; reasons: string[]; decision?: Decision | null };
}

async function pay(id: string) {
  try {
    const res = await payingFetch()(`${base}/v1/payouts/${id}/pay`, { method: "POST", signal: AbortSignal.timeout(90_000) });
    return { http_status: res.status, ...((await res.json().catch(() => ({}))) as object) };
  } catch (err) {
    // A timeout is unconfirmed, not failed: the payment may have settled. Look it up before anyone pays again.
    const status = await fetch(`${base}/v1/payouts/${id}`).then((r) => (r.ok ? (r.json() as Promise<{ status: string; funding_tx: string | null }>) : undefined)).catch(() => undefined);
    const settled = status && !["quoted", "expired", "rejected", "needs_review"].includes(status.status);
    return settled
      ? { http_status: 200, unconfirmed_then_found: true, status: status.status, funding_tx: status.funding_tx }
      : { http_status: 504, unconfirmed: true, error: `No answer from Sayso (${String(err).slice(0, 120)}). Check payout_status for ${id} before paying again; the same quote can't be paid twice.` };
  }
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
  const q = await quote(i as Invoice, { max_usdz: i.max_usdz, spendable_usdz: process.env.SAYSO_SPENDABLE_USDZ });
  if (q.status !== "quoted" || !q.pay_url) return text({ paid: false, ...q });
  // Waiting for funds means there is nothing to pay with yet; ask again after the next top-up.
  if (q.decision?.verdict === "wait" && q.decision.decided_by === "balance") return text({ paid: false, decision: q.decision, quote: q });
  if (Number(q.price_usdz) > Number(i.max_usdz)) return text({ paid: false, reason: `price ${q.price_usdz} USDZ is above max_usdz ${i.max_usdz}`, quote: q });
  // A price wait is still paid now: the USDZ waits in escrow at this price and Airwallex pays once the rate is back in band.
  const r = await pay(q.id);
  return text({ paid: r.http_status < 400, quote_id: q.id, decision: q.decision, ...r });
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

server.registerTool("prove_payout", {
  description: "Everything Sayso can prove about a payout, as the seller: the order the agent placed, the Metal mandate that allowed it, the owner's approval if it was held, the Metal payment, the Airwallex transfer and the receipt on chain. Each piece is proven, missing, or against.",
  inputSchema: { payout_id: z.string() },
}, async ({ payout_id }) => text(await (await fetch(`${base}/v1/payouts/${payout_id}/proof`)).json()));

server.registerTool("dispute_payout", {
  description: "Dispute a delivered payout. Name what went wrong; Sayso's rules check the claim against the proof. Denied: the proof answers it, and that answer is anchored on Metal. Upheld: Sayso's record shows it got it wrong, and the agent's USDZ is refunded on Metal. Review: the owner decides. Signed with the agent's own key; only the agent that paid can dispute.",
  inputSchema: {
    payout_id: z.string(),
    claim: z.enum(["not_authorized", "wrong_amount", "not_delivered", "wrong_payee", "other"]),
    note: z.string().max(200).optional(),
  },
}, async ({ payout_id, claim, note }) => {
  const res = await fetch(`${base}/v1/payouts/${payout_id}/disputes`, { method: "POST", headers: { "content-type": "application/json", ...simHeaders() }, body: JSON.stringify({ claim, note, ...(await signDispute(payout_id, claim)) }) });
  return text(await res.json());
});

server.registerTool("payout_status", {
  description: "Where a payout is: quoted, needs_review, accepted, funded, submitted, paid, failed, refunded.",
  inputSchema: { payout_id: z.string() },
}, async ({ payout_id }) => text(await (await fetch(`${base}/v1/payouts/${payout_id}`)).json()));

await server.connect(new StdioServerTransport());
