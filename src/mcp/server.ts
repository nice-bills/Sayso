// Coin Slot as an MCP server: any Claude agent (Claude Code, Claude Desktop, the Agent SDK) can
// pay a real-world invoice in local currency. The agent's own Metal key pays over x402; Coin Slot
// pays the invoice through Airwallex.
//
//   claude mcp add coinslot -- npx tsx src/mcp/server.ts
//   env: COINSLOT_URL, COINSLOT_BUYER_KEY (a Metal testnet key), COINSLOT_MAX_USDZ (spend cap per payout)
//   offline: COINSLOT_SIM_PAYER=0x... against `npm run serve:offline`

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMetalPaymentClient, usdzBaseUnits } from "@metalntwx/metal-pay";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const base = process.env.COINSLOT_URL ?? "http://127.0.0.1:4021";
const maxUsdz = process.env.COINSLOT_MAX_USDZ ?? "250";
const simPayer = process.env.COINSLOT_SIM_PAYER;

function payingFetch(): typeof fetch {
  if (simPayer) return (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-sim-payer": simPayer } });
  const key = process.env.COINSLOT_BUYER_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("Set COINSLOT_BUYER_KEY (a Metal testnet private key) or COINSLOT_SIM_PAYER for offline use");
  // Metal refuses to sign above maxAmount, so a wrong quote can never overspend the agent's wallet.
  return createMetalPaymentClient({ account: privateKeyToAccount(key), network: "testnet", maxAmount: BigInt(usdzBaseUnits(maxUsdz)) }).fetchWithPayment as typeof fetch;
}

const invoiceShape = {
  amount: z.string().describe("Amount in major units, e.g. \"480.00\""),
  currency: z.string().describe("ISO currency of the payout, e.g. EUR, GBP, USD"),
  method: z.enum(["LOCAL", "SWIFT"]).optional().describe("LOCAL (default, free) or SWIFT"),
  payee_name: z.string(),
  payee_type: z.enum(["COMPANY", "PERSONAL"]).optional(),
  payee_country: z.string().describe("Two-letter country of the payee's address"),
  payee_city: z.string(),
  payee_street: z.string(),
  payee_postcode: z.string(),
  bank_country: z.string().describe("Two-letter country of the bank"),
  bank: z.record(z.string(), z.string()).describe("Bank details as Airwallex bank_details fields, e.g. {\"iban\": \"DE89...\"} or {\"account_number\": \"...\", \"account_routing_type1\": \"sort_code\", \"account_routing_value1\": \"...\"}"),
  reference: z.string().describe("Payment reference shown to the payee, max 35 characters"),
  invoice_text: z.string().optional().describe("The invoice or email text that asked for this payment. Coin Slot reads it and holds anything suspicious."),
};

type Invoice = { [K in keyof typeof invoiceShape]: z.infer<(typeof invoiceShape)[K]> };

const toRequest = (i: Invoice) => ({
  amount: i.amount, currency: i.currency.toUpperCase(), method: i.method, reference: i.reference, invoice_text: i.invoice_text,
  payee: { name: i.payee_name, entity_type: i.payee_type, bank: i.bank, bank_country_code: i.bank_country.toUpperCase(), address: { country_code: i.payee_country.toUpperCase(), city: i.payee_city, street_address: i.payee_street, postcode: i.payee_postcode } },
});

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

async function quote(i: Invoice) {
  const res = await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toRequest(i)) });
  return (await res.json()) as { id: string; status: string; price_usdz: string; pay_url: string | null; reasons: string[] };
}

async function pay(id: string) {
  const res = await payingFetch()(`${base}/v1/payouts/${id}/pay`, { method: "POST" });
  return { http_status: res.status, ...((await res.json().catch(() => ({}))) as object) };
}

const server = new McpServer({ name: "coinslot", version: "0.1.0" });

server.registerTool("quote_payout", {
  description: "Price a real-world payout in local currency (free). Returns the USDZ price, or why Coin Slot will not pay it as asked.",
  inputSchema: invoiceShape,
}, async (i) => text(await quote(i as Invoice)));

server.registerTool("pay_invoice", {
  description: "Pay a real-world invoice in local currency through Airwallex, paying Coin Slot in USDZ over x402 on Metal. Quotes first and pays only if the price is at most max_usdz. Suspicious invoices are held for a human, and failed payouts are refunded in full.",
  inputSchema: { ...invoiceShape, max_usdz: z.string().describe("The most this agent will pay in USDZ, fees included") },
}, async (i) => {
  const q = await quote(i as Invoice);
  if (q.status !== "quoted" || !q.pay_url) return text({ paid: false, ...q });
  if (Number(q.price_usdz) > Number(i.max_usdz)) return text({ paid: false, reason: `price ${q.price_usdz} USDZ is above max_usdz ${i.max_usdz}`, quote: q });
  return text({ paid: true, quote_id: q.id, ...(await pay(q.id)) });
});

server.registerTool("pay_quote", {
  description: "Pay an existing Coin Slot quote by id.",
  inputSchema: { quote_id: z.string() },
}, async ({ quote_id }) => text(await pay(quote_id)));

server.registerTool("payout_status", {
  description: "Where a payout is: quoted, needs_review, accepted, funded, submitted, paid, failed, refunded.",
  inputSchema: { payout_id: z.string() },
}, async ({ payout_id }) => text(await (await fetch(`${base}/v1/payouts/${payout_id}`)).json()));

await server.connect(new StdioServerTransport());
