// The demo, driven the way real users drive Coin Slot: AI agents through the MCP tools, a business
// through its invoice inbox. Runs against the live sandboxes, or fully offline with --offline.
//   1. Three agents pay real-world invoices through Coin Slot's MCP tool (x402 on Metal -> Airwallex).
//   2. A business forwards invoices; one tap pays them. A fake "landlord" asking for new bank details is held.
//   3. A payout bounces (closed account): the agent is refunded in full under a Metal refund mandate.
//   4. Earnings move into the Airwallex float under a ramp-only mandate, exactly once.
//   5. A compromised agent tries to drain the earnings to an attacker: Metal refuses it on chain.
//   6. Reconciliation: every cent explained.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AddressInfo } from "node:net";
import { buildCoinSlot } from "./app.js";
import { emit } from "./events.js";
import { designerInvoice, fakeLandlord, studioInvoice, vagueEmail } from "../samples/invoices.js";

const offline = process.argv.includes("--offline") || !process.env.AWX_CLIENT_ID;
const exit = process.argv.includes("--exit");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beat = async (n: number, title: string) => { emit("observe", `Beat ${n}: ${title}`); await sleep(offline ? 500 : 0); };

const cs = await buildCoinSlot({ offline });
const server = cs.app.listen(Number(process.env.PORT ?? 4021));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
emit("observe", `Coin Slot on ${base}; open it and sign in with ${cs.offline ? cs.ownerToken : "your owner token"}`);
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await cs.tick(); };

/** One buying agent: its own MCP connection to Coin Slot, paying with its own Metal identity. */
async function agent(name: string, payerOrKey: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), COINSLOT_URL: base, COINSLOT_MAX_USDZ: "500" };
  if (offline) env.COINSLOT_SIM_PAYER = payerOrKey; else env.COINSLOT_BUYER_KEY = payerOrKey;
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], env, stderr: "ignore" }));
  return client;
}

const result = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
const payee = (name: string, iban: string, city: string) => ({
  payee_name: name, payee_country: iban.slice(0, 2), payee_city: city, payee_street: "1 Main Street", payee_postcode: "10000", bank_country: iban.slice(0, 2), bank: { iban },
});

// ---- 1. agents pay invoices over MCP ----
await beat(1, "three AI agents pay real-world invoices through Coin Slot's MCP tool");
const buyers = offline
  ? ["0xA9e0000000000000000000000000000000000001", "0xA9e0000000000000000000000000000000000002", "0xA9e0000000000000000000000000000000000003"]
  : (process.env.METAL_BUYER_KEYS ?? "").split(",").filter(Boolean);
const jobs = [
  { amount: "180.00", currency: "EUR", reference: "Translation Oct", ...payee("Lingua Freelance", "FR1420041010050500013M02606", "Paris") },
  { amount: "95.50", currency: "EUR", reference: "GPU rental 44", ...payee("Rechenzentrum Nord GmbH", "DE75512108001245126199", "Hamburg") },
  { amount: "240.00", currency: "EUR", reference: "Data labelling", ...payee("Etiqueta SL", "ES9121000418450200051332", "Madrid") },
];
const agents = await Promise.all(buyers.slice(0, 3).map((b, i) => agent(`buyer-agent-${i + 1}`, b)));
for (const [i, a] of agents.entries()) {
  const r = result(await a.callTool({ name: "pay_invoice", arguments: { ...jobs[i]!, max_usdz: "400" } }));
  emit("observe", `buyer-agent-${i + 1}: ${r.paid ? `paid quote ${String(r.quote_id).slice(0, 8)}, HTTP ${r.http_status}` : `not paid: ${r.reason ?? r.status}`}`);
}
await settle();

// ---- 2. the invoice inbox ----
await beat(2, "a business forwards invoices; one tap pays each");
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

// ---- 3. a bounced payout is refunded ----
await beat(3, "a payout bounces; the agent gets every cent back");
if (offline && agents[0]) {
  const r = result(await agents[0].callTool({ name: "pay_invoice", arguments: { amount: "60.00", currency: "EUR", reference: "Old supplier", ...payee("Closed Account Co (CLOSED)", "DE02100100109307118603", "Berlin"), max_usdz: "100" } }));
  emit("observe", `buyer-agent-1 paid quote ${String(r.quote_id).slice(0, 8)}`);
  await settle();
} else {
  emit("observe", "Live: bounce a payout with the Airwallex transfer simulation (next_status CANCELLED) to see the refund");
}

// ---- 4. sweep ----
await beat(4, "earnings have been moving into the Airwallex float on every tick, under a ramp-only Metal mandate");
await settle(1);

// ---- 5. heist ----
await beat(5, "a compromised agent tries to drain the earnings to an attacker");
await cs.attemptHeist("0x9f3a6C0b9a2b9E3d7F1c5aE4B2d8C6e0F1a2B3c4", 25_000);

// ---- 6. reconcile ----
await beat(6, "reconcile every cent");
await cs.reconcileNow();

for (const a of agents) await a.close();
emit("observe", `Demo complete. ${offline ? "Offline: no real money moved." : "Live sandbox run."} App: ${base}/`);
if (exit) { server.close(); process.exit(0); }
