// The demo, driven the way real users drive Sayso: AI agents through the MCP tools, a business
// through its invoice inbox. Runs against the live sandboxes, or fully offline with --offline.
//   1. Three agents pay real-world invoices through Sayso's MCP tool (x402 on Metal -> Airwallex).
//   2. A marketplace agent pays four sellers with one x402 payment (batch payouts).
//   3. A business forwards invoices; one tap pays them. A fake "landlord" asking for new bank details is held.
//   4. A payout bounces (closed account): the agent is refunded in full under a Metal refund mandate.
//   5. Earnings move into the Airwallex float under a ramp-only mandate, exactly once.
//   6. Sayso runs its own treasury: an email lowers the earnings forecast, the policy re-plans
//      hold / convert / pay for its bills, and the backtest over real ECB rates is shown.
//   7. The agent pays its compute bill with its own Airwallex card; a bad charge freezes the card.
//   8. Prove it: an agent disputes two of its payouts and Sayso answers each from the proof.
//   9. A compromised agent tries to drain the earnings to an attacker: Metal refuses it on chain.
//  10. Reconciliation: every cent explained.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { getAddress } from "viem";
import type { Airwallex } from "./airwallex/client.js";
import { buildSayso } from "./app.js";
import { emit } from "./events.js";
import { designerInvoice, fakeLandlord, studioInvoice, vagueEmail } from "../samples/invoices.js";
import { churnEmail } from "./scenario.js";

const offline = process.argv.includes("--offline") || !process.env.AWX_CLIENT_ID;
// Live Airwallex, simulated Metal: buyers pay as simulated payers until a Metal testnet endpoint is set up.
const simMetal = !offline && (process.argv.includes("--sim-metal") || !process.env.METAL_PRINCIPAL);
const simPayers = offline || simMetal;
// The Metal testnet faucet grants each buyer 100 USDZ once, so a live Metal run pays a tenth of
// each invoice and keeps a smaller refund reserve, so earnings still sweep.
const scale = simPayers ? 1 : 0.1;
const amt = (major: string) => (Number(major) * scale).toFixed(2);
if (!simPayers) process.env.SAYSO_REFUND_RESERVE_USDZ ??= "20";
const exit = process.argv.includes("--exit");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beat = async (n: number, title: string) => { emit("observe", `Beat ${n}: ${title}`); await sleep(offline ? 500 : 0); };

const cs = await buildSayso({ offline, simMetal });
const server = cs.app.listen(Number(process.env.PORT ?? 4021));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
emit("observe", `Sayso on ${base}; open it and sign in with ${cs.offline ? cs.ownerToken : "your owner token"}`);
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await cs.tick(); };

/** One buying agent: its own MCP connection to Sayso, paying with its own Metal identity. */
async function agent(name: string, payerOrKey: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SAYSO_URL: base, SAYSO_MAX_USDZ: "500" };
  if (simPayers) env.SAYSO_SIM_PAYER = payerOrKey; else env.SAYSO_BUYER_KEY = payerOrKey;
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], env, stderr: "ignore" }));
  return client;
}

const result = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
// Airwallex wants a state (province) on Spanish payee addresses.
const payee = (name: string, iban: string, city: string) => ({
  payee_name: name, payee_country: iban.slice(0, 2), payee_city: city, payee_street: "1 Main Street", payee_postcode: "10000", bank_country: iban.slice(0, 2), bank: { iban },
  ...(iban.startsWith("ES") ? { payee_state: city } : {}),
});

// ---- 1. agents pay invoices over MCP ----
await beat(1, "three AI agents pay real-world invoices through Sayso's MCP tool");
const buyers = simPayers
  ? ["0xA9e0000000000000000000000000000000000001", "0xA9e0000000000000000000000000000000000002", "0xA9e0000000000000000000000000000000000003"]
  : (process.env.METAL_BUYER_KEYS ?? "").split(",").filter(Boolean);
const jobs = [
  { amount: amt("180.00"), currency: "EUR", reference: "Translation Oct", ...payee("Lingua Freelance", "FR1420041010050500013M02606", "Paris") },
  { amount: amt("95.50"), currency: "EUR", reference: "GPU rental 44", ...payee("Rechenzentrum Nord GmbH", "DE75512108001245126199", "Hamburg") },
  { amount: amt("240.00"), currency: "EUR", reference: "Data labelling", ...payee("Etiqueta SL", "ES9121000418450200051332", "Madrid") },
];
const agents = await Promise.all(buyers.slice(0, 3).map((b, i) => agent(`buyer-agent-${i + 1}`, b)));
for (const [i, a] of agents.entries()) {
  const r = result(await a.callTool({ name: "pay_invoice", arguments: { ...jobs[i]!, max_usdz: "400" } }));
  emit("observe", `buyer-agent-${i + 1}: ${r.paid ? `paid quote ${String(r.quote_id).slice(0, 8)}, HTTP ${r.http_status}` : `not paid: ${r.reason ?? r.status}`}`);
}
await settle();

// ---- 2. batch payouts ----
await beat(2, "a marketplace agent settles four sellers with one payment");
if (agents[1]) {
  const sellers = [
    ["Atelier Nord", "DE89370400440532013000", "Hamburg", "64.00"], ["Keramik Sud", "DE75512108001245126199", "Munich", "38.50"],
    ["Linen & Co", "FR1420041010050500013M02606", "Lyon", "52.00"], ["Papel SL", "ES9121000418450200051332", "Valencia", "27.25"],
  ];
  const r = result(await agents[1].callTool({ name: "pay_batch", arguments: { reference: "Sellers week 44", max_usdz: "250", items: sellers.map(([n, iban, city, amount]) => ({ amount: amt(amount!), currency: "EUR", reference: "Sellers week 44", ...payee(n!, iban!, city!) })) } }));
  emit("observe", `buyer-agent-2 (marketplace): ${r.paid ? `paid ${r.payouts?.length} sellers with one payment of ${r.price_usdz} USDZ` : `not paid: ${r.reason ?? r.error}`}`);
  await settle();
}

// ---- 3. the invoice inbox ----
await beat(3, "a business forwards invoices; one tap pays each");
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}` }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ id: string; status: string; error?: string }>);
const items = [];
for (const e of [studioInvoice, designerInvoice, fakeLandlord, vagueEmail]) items.push(await post("/v1/inbox", { message_id: e.messageId, from: e.from, subject: e.subject, body: e.body }));
for (const it of items.filter((i) => i.status === "awaiting_approval")) await post(`/v1/inbox/${encodeURIComponent(it.id)}/approve`, { approver: "will" });
const held = items.find((i) => i.status === "needs_verification");
if (held) {
  const r = await post(`/v1/inbox/${encodeURIComponent(held.id)}/approve`, { approver: "will" });
  emit("refuse", `Approving the "landlord" invoice without confirming by phone: ${r.error}`);
}
await settle();

// ---- 4. a bounced payout is refunded ----
await beat(4, "a payout bounces; the agent gets every cent back");
if (offline && agents[0]) {
  const r = result(await agents[0].callTool({ name: "pay_invoice", arguments: { amount: "60.00", currency: "EUR", reference: "Old supplier", ...payee("Closed Account Co (CLOSED)", "DE02100100109307118603", "Berlin"), max_usdz: "100" } }));
  emit("observe", `buyer-agent-1 paid quote ${String(r.quote_id).slice(0, 8)}`);
  await settle();
} else if (agents[0]) {
  // Live sandbox: pay a real transfer, then have Airwallex's simulation return it as a closed account.
  const r = result(await agents[0].callTool({ name: "pay_invoice", arguments: { amount: amt("60.00"), currency: "EUR", reference: "Old supplier", ...payee("Closed Account Co", "DE02100100109307118603", "Berlin"), max_usdz: "100" } }));
  // The payout reaches Airwallex once the payment settles on chain and a tick submits it.
  let transferId: string | null | undefined;
  for (let i = 0; r.paid && !transferId && i < 20; i++) { await settle(1); transferId = cs.svc.book.get(r.quote_id)?.transferId; if (!transferId) await sleep(3000); }
  if (transferId && "simulateTransfer" in cs.awx) {
    // The sandbox only fails a transfer that has been SENT; PROCESSING -> FAILED is a 500.
    await (cs.awx as Airwallex).simulateTransfer(transferId, { next_status: "SENT" });
    await (cs.awx as Airwallex).simulateTransfer(transferId, { next_status: "FAILED", failure_type: "ACCOUNT_CLOSED" });
    emit("observe", `Airwallex sandbox bounced transfer ${transferId.slice(0, 8)} (ACCOUNT_CLOSED)`);
  } else emit("observe", `buyer-agent-1 bounce payout not submitted: ${r.reason ?? r.status ?? r.error}`);
  await settle();
} else {
  emit("observe", "Live: bounce a payout with the Airwallex transfer simulation (next_status SENT, then FAILED with failure_type ACCOUNT_CLOSED) to see the refund");
}

// ---- 5. sweep ----
await beat(5, "earnings have been moving into the Airwallex float on every tick, under a ramp-only Metal mandate");
await settle(1);

// ---- 6. treasury ----
await beat(6, "Sayso plans its own bills: hold, convert or pay, and an email changes the plan");
const treasury = cs.treasury();
treasury.inbox.push(churnEmail);
await treasury.tick().catch((err) => emit("escalate", `Treasury tick failed: ${String(err).slice(0, 160)}`));
if (existsSync("results/backtest.json")) {
  const bt = JSON.parse(readFileSync("results/backtest.json", "utf8")) as { seeds: number; data: { from: string; to: string }; meanPerRun: Record<"policy" | "baseline", { missedBills: number; reserveBreaches: number; spreadPaidMinor: number }> };
  const p = bt.meanPerRun.policy, b = bt.meanPerRun.baseline;
  emit("observe", `Backtest, ${bt.seeds} earnings paths over ECB rates ${bt.data.from} to ${bt.data.to}: policy missed ${p.missedBills} bills and breached the reserve ${p.reserveBreaches} times; FX spread ${(p.spreadPaidMinor / 100).toFixed(2)} USD vs ${(b.spreadPaidMinor / 100).toFixed(2)} converting each bill on its due date`);
}

// ---- 7. the agent's own card ----
await beat(7, "the agent pays its compute bill with its own Airwallex card");
if (await cs.cardReady()) {
  await cs.card.simulateBill("ANTHROPIC PBC", "7372", 4_200);
  await cs.card.simulateBill("LUXURY WATCHES", "5944", 15_000); // Airwallex's own controls decline it
  await cs.card.simulateBill("GPU RESELLER LTD", "7372", 9_000); // allowed category, unknown merchant: Sayso freezes the card
}

// ---- 8. prove it ----
await beat(8, "an agent questions two of its payouts; Sayso answers each from the proof");
{
  const ofAgent = (reference: string) => cs.svc.book.list(500).find((p) => p.reference === reference && p.buyer && !p.buyer.startsWith("internal:"));
  // Live sandbox: transfers sit in PROCESSING until the simulation moves them, so deliver these two first.
  if (!offline && "simulateTransfer" in cs.awx) {
    for (const ref of ["Translation Oct", "Data labelling"]) {
      const t = ofAgent(ref)?.transferId;
      if (!t || ofAgent(ref)?.status !== "submitted") continue;
      await (cs.awx as Airwallex).simulateTransfer(t, { next_status: "SENT" }).catch(() => undefined);
      await (cs.awx as Airwallex).simulateTransfer(t, { next_status: "PAID" }).catch((e) => emit("observe", `Could not mark ${t.slice(0, 8)} paid: ${String(e).slice(0, 120)}`));
    }
    await settle(2);
  }
  const paidFor = (reference: string) => { const p = ofAgent(reference); return p?.status === "paid" ? p : undefined; };
  // buyer-agent-3: "never arrived", against a transfer Airwallex reports as paid. Denied, and the answer is anchored on Metal.
  const labelling = paidFor("Data labelling");
  if (labelling && agents[2]) {
    const proof = result(await agents[2].callTool({ name: "prove_payout", arguments: { payout_id: labelling.id } }));
    emit("observe", `Proof for ${labelling.payeeName}: ${proof.evidence?.map((e: { id: string; status: string }) => `${e.id} ${e.status}`).join(", ")}`);
    const d = result(await agents[2].callTool({ name: "dispute_payout", arguments: { payout_id: labelling.id, claim: "not_delivered", note: "the payee says nothing arrived" } }));
    emit("observe", `buyer-agent-3 disputed ${labelling.payeeName} (never arrived): ${d.dispute?.verdict}. ${d.dispute?.reason ?? d.error}`);
  }
  // buyer-agent-1's owner: "wasn't allowed", against a payment from a bare key under no mandate. Upheld, refunded on Metal.
  const translation = paidFor("Translation Oct");
  if (translation && agents[0]) {
    const d = result(await agents[0].callTool({ name: "dispute_payout", arguments: { payout_id: translation.id, claim: "not_authorized", note: "the owner never allowed this" } }));
    emit("observe", `buyer-agent-1 disputed ${translation.payeeName} (wasn't allowed): ${d.dispute?.verdict}. ${d.dispute?.reason ?? d.error}`);
    await settle(1);
  }
}

// ---- 9. heist ----
await beat(9, "a compromised agent tries to drain the earnings to an attacker");
await cs.attemptHeist(getAddress("0x9f3a6c0b9a2b9e3d7f1c5ae4b2d8c6e0f1a2b3c4"), 25_000);

// ---- 10. reconcile ----
await beat(10, "reconcile every cent");
// Live: a simulated Airwallex deposit, or a bounced transfer's return, takes a few seconds to reach the balance.
if (!offline) await sleep(15_000);
await cs.reconcileNow();

for (const a of agents) await a.close();
emit("observe", `Demo complete. ${offline ? "Offline: no real money moved." : simMetal ? "Live Airwallex sandbox run, Metal simulated." : "Live sandbox run."} App: ${base}/`);
if (exit) { server.close(); process.exit(0); }
