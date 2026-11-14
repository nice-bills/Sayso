// Sayso as an MCP server: any Claude agent (Claude Code, Claude Desktop, the Agent SDK) can
// pay a real-world invoice in local currency. The agent's own Metal key pays over x402; Sayso
// pays the invoice through Airwallex.
//
//   claude mcp add sayso -- npx tsx src/mcp/server.ts
//   env: SAYSO_URL, SAYSO_BUYER_KEY (a Metal testnet key), SAYSO_MAX_USDZ (spend cap per payout),
//        SAYSO_SPENDABLE_USDZ (what the agent can spend now; a short budget waits or splits)
//   or:  SAYSO_MANDATE (a credential from `npm run setup:agent-budget`): pay from the owner's account,
//        within the limits the owner bound on Metal, signing each exact order with the mandate key,
//        and showing the owner-signed credential (SAYSO_MANDATE_ISSUER: the issuer's public key file)
//   offline: SAYSO_SIM_PAYER=0x... (or SAYSO_SIM_MANDATE=<ref>) against `npm run serve:offline`

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createMetalPaymentClient, usdzBaseUnits } from "@metalntwx/metal-pay";
import { createMandatePaymentClient, p256DigestSigner, parseCredential, privateKeyHex, type Es256Key } from "@metalntwx/metal-pay/mandates";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { invoiceShape, toRequest, usdzLimit, type Invoice } from "./tools.js";
import { failed, SaysoClient, type Failure, type PayOutcome, type Reply } from "./sayso.js";
import { disputeDigest, disputeMessage } from "../payouts/dispute-auth.js";
import { verifyBatchOffer, verifyOffer, type SignedBatchOffer, type SignedOffer } from "../payouts/offer.js";
import { PAYOUT } from "../payouts/book.js";

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
    const agentKeyFile = process.env.SAYSO_MANDATE_AGENT_KEY ?? mandate.replace(/\.json$/, ".key.json");
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
async function signDispute(payoutId: string, claim: string): Promise<{ signature?: string; issued_at?: string; signer?: string }> {
  if (simPayer || simMandate) return {};
  const issued_at = new Date().toISOString();
  const mandate = process.env.SAYSO_MANDATE;
  if (mandate) {
    // Paid from the owner's account under a mandate: sign with the mandate key Metal has bound to it.
    const agent = JSON.parse(readFileSync(process.env.SAYSO_MANDATE_AGENT_KEY ?? mandate.replace(/\.json$/, ".key.json"), "utf8")) as Es256Key;
    const signature = await p256DigestSigner(privateKeyHex(agent))(disputeDigest(disputeMessage(payoutId, claim, issued_at)));
    return { issued_at, signature, signer: "mandate_key" };
  }
  const key = process.env.SAYSO_BUYER_KEY as `0x${string}` | undefined;
  if (!key) return {};
  return { issued_at, signature: await privateKeyToAccount(key).signMessage({ message: disputeMessage(payoutId, claim, issued_at) }) };
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });

/** A call that could not be completed. isError is set so the agent does not read it as a result. */
const failure = (f: Failure, extra: Record<string, unknown> = {}) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify({ ...extra, ...f }, null, 2) }],
});

const unexpected = (what: string, err: unknown): Failure =>
  failed(`${what}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, next: "Retry in about a minute." });

const api = new SaysoClient({ base, payingFetch });

type Decision = { verdict: "pay" | "wait" | "split" | "hold" | "reject"; decided_by: string; reason: string };

type Quote = { id: string; status: string; amount: string; currency: string; reference: string; price_usdz: string; pay_url: string | null; reasons: string[]; decision?: Decision | null; offer?: SignedOffer | null };

async function quote(i: Invoice, limits: { max_usdz?: string; spendable_usdz?: string } = {}): Promise<Reply<Quote>> {
  // Name the paying address, so Sayso checks what it really holds on Metal, not just what the agent says.
  const key = process.env.SAYSO_BUYER_KEY as `0x${string}` | undefined;
  const buyer = simPayer ?? (key ? privateKeyToAccount(key).address : undefined);
  return api.post<Quote>("/v1/quotes", { ...toRequest(i), ...limits, ...(buyer ? { buyer } : {}) }, "quoting the payout");
}

/** What is wrong with a signed offer, and whether waiting would fix it. */
type Doubt = { reason: string; retryable: boolean };

/** Before paying: Sayso's own key signed exactly this invoice, at this price, payable to its published address. Returns why not. */
async function checkOffer(q: Quote, i: Invoice): Promise<Doubt | undefined> {
  if (!q.offer) return { reason: "Sayso sent no signed offer with this quote", retryable: false };
  const h = await api.healthz();
  if (!h.ok) return { reason: `couldn't check Sayso's signing key: ${h.error}`, retryable: true };
  const published = h.data;
  if (!(await verifyOffer(q.offer, published.quote_signer))) return { reason: "the offer is not signed by Sayso's published quote key", retryable: false };
  const t = q.offer.terms;
  if (t.quote !== q.id) return { reason: "the signed offer is for another quote", retryable: false };
  if ((Number(t.priceUsdzMinor) / 100).toFixed(2) !== q.price_usdz) return { reason: `the signed price (${t.priceUsdzMinor} cents) is not the quoted price ${q.price_usdz}`, retryable: false };
  if (t.payTo.toLowerCase() !== published.pay_to.toLowerCase()) return { reason: "the signed offer pays an address Sayso doesn't publish", retryable: false };
  if (t.currency !== i.currency.toUpperCase() || (q.decision?.verdict !== "split" && Number(t.amountMinor) !== Math.round(Number(i.amount) * 100))) return { reason: "the signed offer is for a different amount or currency than this invoice", retryable: false };
  if (Number(t.expiresAt) * 1000 < Date.now()) return { reason: "the signed offer has expired", retryable: false };
  return undefined;
}

/** Before paying a batch: Sayso signed these lines, this total and its own address, and each line's offer matches the invoice it came from. */
async function checkBatch(b: { id?: string; price_usdz?: string; offer?: SignedBatchOffer | null; payouts?: Quote[]; set_aside?: Array<{ index: number }> }, items: Invoice[]): Promise<Doubt | undefined> {
  if (!b.offer || !b.payouts) return { reason: "Sayso sent no signed offer with this batch", retryable: false };
  const h = await api.healthz();
  if (!h.ok) return { reason: `couldn't check Sayso's signing key: ${h.error}`, retryable: true };
  if (!(await verifyBatchOffer(b.offer, h.data.quote_signer))) return { reason: "the batch offer is not signed by Sayso's published quote key", retryable: false };
  const t = b.offer.terms;
  if (t.batch !== b.id) return { reason: "the signed batch offer is for another batch", retryable: false };
  if (t.quotes !== b.payouts.map((l) => l.id).join(",")) return { reason: "the signed batch offer covers different lines", retryable: false };
  if ((Number(t.priceUsdzMinor) / 100).toFixed(2) !== b.price_usdz) return { reason: `the signed batch price (${t.priceUsdzMinor} cents) is not the quoted price ${b.price_usdz}`, retryable: false };
  if (t.payTo.toLowerCase() !== h.data.pay_to.toLowerCase()) return { reason: "the signed batch offer pays an address Sayso doesn't publish", retryable: false };
  if (Number(t.expiresAt) * 1000 < Date.now()) return { reason: "the signed batch offer has expired", retryable: false };
  const aside = new Set((b.set_aside ?? []).map((s) => s.index));
  const kept = items.filter((_, i) => !aside.has(i));
  if (kept.length !== b.payouts.length) return { reason: "the batch's lines don't match the invoices sent", retryable: false };
  for (const [n, line] of b.payouts.entries()) {
    const doubt = await checkOffer(line, kept[n]!);
    if (doubt) return { reason: `line ${n + 1}: ${doubt.reason}`, retryable: doubt.retryable };
  }
  return undefined;
}

/**
 * Paying under a mandate, the agent also shows the credential its owner signed and the issuer's
 * public key, so Sayso can check the owner's signature against what is bound on chain.
 */
function presented(): string | undefined {
  if (simMandate) return JSON.stringify({ mandate_credential: "sim", mandate_issuer: "sim" });
  const mandate = process.env.SAYSO_MANDATE;
  if (!mandate) return undefined;
  // The issuer key sits beside the mandate, so an agent started outside the repo still presents it.
  const issuerFile = process.env.SAYSO_MANDATE_ISSUER ?? join(dirname(mandate), "agent-owner.issuer.public.json");
  try {
    return JSON.stringify({ mandate_credential: JSON.parse(readFileSync(mandate, "utf8")), mandate_issuer: JSON.parse(readFileSync(issuerFile, "utf8")) });
  } catch {
    return undefined;
  }
}

/** Both pay tools answer the same way, including an unconfirmed payment that must be looked up, not retried. */
function payReply(q: Quote, r: PayOutcome) {
  const split = q.decision?.verdict === "split" && r.http_status < 400;
  return text({
    paid: r.http_status < 400, quote_id: q.id, decision: q.decision, ...r,
    ...(split ? { remainder: `Only part of the invoice was paid. After your next top-up, call pay_remainder with payout_id ${q.id} to pay the rest.` } : {}),
  });
}

const server = new McpServer({ name: "sayso", version: "0.1.0" }, {
  instructions: [
    "Sayso pays real-world invoices in the payee's own currency through Airwallex. Agents pay Sayso in USDZ on Metal.",
    "Flow: quote_payout (free) to see the price and Sayso's decision, then pay_invoice (or pay_batch), then payout_status until final is true.",
    "Units: amount, currency, and every amount inside bank details are in the payee's local currency (e.g. EUR), never USDZ. max_usdz and every *_usdz field are USDZ (the agent's money), as a decimal string.",
    "Required invoice fields: amount, currency, payee_name, payee_country, payee_city, payee_street, payee_postcode, bank_country, bank, reference. payee_state is required for US and Canadian payees. method, payee_type, invoice_text, due_date and part_payment are optional.",
    "A quote expires. Never pay the same invoice twice: if a pay times out or its answer is unclear, call payout_status first. If it is still quoted, pay that same quote with pay_quote; if it is paid or submitted, it went through.",
    "payout_status returns status (a machine state), status_means (plain English), waiting_on (agent, owner, bank, sayso or nobody) and final. Stop polling when final is true.",
    "Errors say whether they are retryable. A Sayso that is restarting answers HTTP 502: wait about a minute and retry; nothing was charged.",
  ].join("\n"),
});

server.registerTool("quote_payout", {
  description: "Price a real-world payout in the payee's local currency, free and without paying anything. Returns the USDZ price, a pay_url, Sayso's decision (pay, wait, split, hold or reject) and why. Required: amount, currency, payee_name, payee_country, payee_city, payee_street, payee_postcode, bank_country, bank, reference; payee_state is required for US and Canadian payees.",
  inputSchema: invoiceShape,
}, async (i) => {
  const q = await quote(i as Invoice);
  return q.ok ? text(q.data) : failure(q, { paid: false });
});

server.registerTool("pay_invoice", {
  description: "Pay a real-world invoice in the payee's local currency through Airwallex, paying Sayso in USDZ over x402 on Metal. Quotes first and pays only if the price is at most max_usdz (USDZ, fees included); amount and currency are the payee's local currency. Suspicious invoices are held for a human, and a failed payout is refunded in full. If this times out or the answer is unclear, call payout_status before paying again: the payment may have gone through and a quote can't be paid twice.",
  inputSchema: { ...invoiceShape, max_usdz: usdzLimit("The most this agent will pay, in USDZ (not the payee's currency)") },
}, async (i) => {
  const q = await quote(i as Invoice, { max_usdz: String(i.max_usdz), spendable_usdz: process.env.SAYSO_SPENDABLE_USDZ });
  if (!q.ok) return failure(q, { paid: false });
  const quoted = q.data;
  if (quoted.status !== "quoted" || !quoted.pay_url) return text({ paid: false, ...quoted });
  // Waiting for funds means there is nothing to pay with yet; ask again after the next top-up.
  if (quoted.decision?.verdict === "wait" && quoted.decision.decided_by === "balance") return text({ paid: false, decision: quoted.decision, quote: quoted });
  if (Number(quoted.price_usdz) > Number(i.max_usdz)) return text({ paid: false, reason: `price ${quoted.price_usdz} USDZ is above max_usdz ${i.max_usdz}`, quote: quoted });
  const bad = await checkOffer(quoted, i as Invoice);
  if (bad) return text({ paid: false, reason: `Not paying: ${bad.reason}`, ...(bad.retryable ? { retryable: true, next: "Nothing was charged. Retry in about a minute." } : {}), quote: quoted });
  // A price wait is still paid now: the USDZ waits in escrow at this price and Airwallex pays once the rate is back in band.
  let body: string | undefined;
  try {
    body = presented();
  } catch (err) {
    return failure(unexpected("reading the payment credential", err), { paid: false });
  }
  return payReply(quoted, await api.pay(quoted.id, body));
});

server.registerTool("pay_remainder", {
  description: "Pay the rest of an invoice Sayso split because the agent's budget was short. Pass the first part's payout_id; Sayso quotes what is left to the same payee, checks its signed offer, and pays it if it is at most max_usdz (USDZ, not the payee's currency).",
  inputSchema: {
    payout_id: z.string().describe("The first part's payout id, from pay_invoice's reply when Sayso decided to split"),
    max_usdz: usdzLimit("The most this agent will pay for the remainder, in USDZ (not the payee's currency)"),
  },
}, async ({ payout_id, max_usdz }) => {
  const first = await api.get<{ amount: string; currency: string; remainder?: { amount: string } }>(`/v1/payouts/${encodeURIComponent(payout_id)}`, "reading the split payout");
  if (!first.ok) return failure(first, { paid: false });
  if (!first.data.remainder) return text({ paid: false, reason: "that payout was not split; nothing is left to pay" });
  const rest = await api.post<Quote & { error?: string }>(`/v1/payouts/${encodeURIComponent(payout_id)}/remainder`, {}, "quoting the rest");
  if (!rest.ok) return failure(rest, { paid: false });
  const q = rest.data;
  if (!q.pay_url) return text({ paid: false, ...q });
  if (Number(q.price_usdz) > Number(max_usdz)) return text({ paid: false, reason: `price ${q.price_usdz} USDZ is above max_usdz ${max_usdz}`, quote: q });
  const bad = await checkOffer(q, { amount: first.data.remainder.amount, currency: first.data.currency } as Invoice);
  if (bad) return text({ paid: false, reason: `Not paying: ${bad.reason}`, ...(bad.retryable ? { retryable: true, next: "Nothing was charged. Retry in about a minute." } : {}), quote: q });
  return payReply(q, await api.pay(q.id));
});

server.registerTool("pay_batch", {
  description: "Pay many people at once (e.g. a marketplace's sellers or a team of contractors) with ONE USDZ payment over x402. Each line is an invoice with the same required fields as pay_invoice; lines Sayso won't pay are set aside with reasons and not charged. Pays only if the batch price is at most max_usdz (USDZ, fees included). It pays only if Sayso's signed batch offer and every line's signed offer match what was asked. A line that bounces is refunded on its own. If this times out, call batch_status before paying again: the payment may have gone through.",
  inputSchema: {
    items: z.array(z.object(invoiceShape)).min(1).max(100).describe("The invoices to pay, one object per payee. Each needs the same required fields as pay_invoice."),
    reference: z.string().trim().max(35).optional().describe("Optional. A label for the whole batch, at most 35 characters."),
    max_usdz: usdzLimit("The most this agent will pay for the whole batch, in USDZ (not the payee's currency)"),
  },
}, async ({ items, reference, max_usdz }) => {
  const created = await api.post<{ id?: string; status?: string; price_usdz?: string; pay_url?: string | null; set_aside?: Array<{ index: number }>; error?: string; offer?: SignedBatchOffer | null; payouts?: Quote[] }>(
    "/v1/batches", { reference: reference ?? "Batch payout", items: items.map((i) => toRequest(i as Invoice)) }, "creating the batch",
  );
  if (!created.ok) return failure(created, { paid: false });
  const b = created.data;
  if (!b.pay_url) return text({ paid: false, ...b });
  if (Number(b.price_usdz) > Number(max_usdz)) return text({ paid: false, reason: `batch price ${b.price_usdz} USDZ is above max_usdz ${max_usdz}`, batch: b });
  if (!b.id) return failure(failed("Sayso created a batch without an id; nothing was charged.", { retryable: true }), { paid: false });
  const bad = await checkBatch(b, items as Invoice[]);
  if (bad) return text({ paid: false, reason: `Not paying: ${bad.reason}`, ...(bad.retryable ? { retryable: true, next: "Nothing was charged. Retry in about a minute." } : {}), batch: b });
  const r = await api.payBatch(b.id, b.pay_url);
  return text({ paid: r.http_status < 400, batch_id: b.id, ...r });
});

server.registerTool("batch_status", {
  description: "Progress of a batch payout: overall status, a count per status (progress), every line's payout, and the lines Sayso set aside and why. Pass the batch_id from pay_batch, and stop when each line is final.",
  inputSchema: { batch_id: z.string().describe("The batch id from pay_batch") },
}, async ({ batch_id }) => {
  const r = await api.get(`/v1/batches/${encodeURIComponent(batch_id)}`, "reading the batch");
  return r.ok ? text(r.data) : failure(r);
});

server.registerTool("pay_quote", {
  description: "Pay an existing Sayso quote by id, if Sayso signed it and its price is at most this agent's limit (SAYSO_MAX_USDZ, USDZ). Use it to retry the same quote after an unclear pay result; do not create a new quote for the same invoice, because a quote can't be paid twice.",
  inputSchema: { quote_id: z.string().describe("The quote id (a UUID) from quote_payout or a payout reply") },
}, async ({ quote_id }) => {
  // A quote id can come from anywhere (an invoice, another agent), so it gets the same checks pay_invoice makes
  // on its own quotes: Sayso's signature over exactly this quote, its published payee, and the agent's cap.
  const found = await api.get<Quote & { error?: string }>(`/v1/payouts/${encodeURIComponent(quote_id)}`, "reading the quote");
  if (!found.ok) return failure(found, { paid: false });
  const q = found.data;
  if (!q.offer || q.status !== "quoted") return text({ paid: false, reason: q.error ?? `quote is ${q.status}`, quote: q });
  const cap = Number(maxUsdz);
  if (!Number.isFinite(cap) || cap <= 0) return failure(failed(`This agent's SAYSO_MAX_USDZ limit (${maxUsdz}) is not a USDZ amount; not paying.`, { retryable: false }), { paid: false });
  if (Number(q.price_usdz) > cap) return text({ paid: false, reason: `price ${q.price_usdz} USDZ is above this agent's limit of ${maxUsdz}`, quote: q });
  const bad = await checkOffer(q, { amount: (Number(q.offer.terms.amountMinor) / 100).toFixed(2), currency: q.currency } as Invoice);
  if (bad) return text({ paid: false, reason: `Not paying: ${bad.reason}`, ...(bad.retryable ? { retryable: true, next: "Nothing was charged. Retry in about a minute." } : {}), quote: q });
  return payReply(q, await api.pay(quote_id));
});

server.registerTool("payout_receipt", {
  description: "A final payout's receipt and the Metal transaction anchoring its hash, so the agent can prove the money was delivered (or refunded) without trusting Sayso. A receipt exists only once the payout is paid or refunded; until then Sayso answers that it is not final yet.",
  inputSchema: { payout_id: z.string().describe("The payout id (a UUID)") },
}, async ({ payout_id }) => {
  const r = await api.get(`/v1/payouts/${encodeURIComponent(payout_id)}/receipt`, "reading the receipt");
  return r.ok ? text(r.data) : failure(r);
});

server.registerTool("prove_payout", {
  description: "Everything Sayso can prove about a payout, as the seller: the order the agent placed, the Metal mandate that allowed it, the owner's approval if it was held, the Metal payment, the Airwallex transfer and the receipt on chain. Each piece is proven, missing, or against.",
  inputSchema: { payout_id: z.string().describe("The payout id (a UUID)") },
}, async ({ payout_id }) => {
  const r = await api.get(`/v1/payouts/${encodeURIComponent(payout_id)}/proof`, "reading the proof");
  return r.ok ? text(r.data) : failure(r);
});

server.registerTool("dispute_payout", {
  description: "Dispute a delivered payout. Name what went wrong; Sayso's rules check the claim against the proof. Denied: the proof answers it, and that answer is anchored on Metal. Upheld: Sayso's record shows it got it wrong, and the agent's USDZ is refunded on Metal. Review: the owner decides. Signed with the agent's own key; only the agent that paid can dispute.",
  inputSchema: {
    payout_id: z.string().describe("The payout id (a UUID) of the payout you paid"),
    claim: z.enum(["not_authorized", "wrong_amount", "not_delivered", "wrong_payee", "other"]),
    note: z.string().max(200).optional().describe("Optional. A short explanation of what went wrong, at most 200 characters."),
  },
}, async ({ payout_id, claim, note }) => {
  let r: Reply<unknown>;
  try {
    r = await api.post(`/v1/payouts/${encodeURIComponent(payout_id)}/disputes`, { claim, note, ...(await signDispute(payout_id, claim)) }, "filing the dispute", simHeaders());
  } catch (err) {
    return failure(unexpected("signing the dispute", err));
  }
  return r.ok ? text(r.data) : failure(r);
});

server.registerTool("payout_status", {
  description: `Where a payout is. status is one of: ${Object.keys(PAYOUT.states).join(", ")}. The reply also says what the status means (status_means), who it is waiting on (waiting_on) and whether it is final. Stop polling when final is true. After a timed-out payment, call this before paying again.`,
  inputSchema: { payout_id: z.string().describe("The payout id (a UUID) from pay_invoice, pay_quote or pay_remainder") },
}, async ({ payout_id }) => {
  const r = await api.get(`/v1/payouts/${encodeURIComponent(payout_id)}`, "reading the payout");
  return r.ok ? text(r.data) : failure(r);
});

await server.connect(new StdioServerTransport());
