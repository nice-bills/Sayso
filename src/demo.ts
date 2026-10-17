// The demo, in five beats, against the real sandboxes or fully offline (`--offline`, or no keys).
//   1. Customers pay the agent per call over x402 on Metal.
//   2. Earnings sweep to the off-ramp under a Metal mandate and land on Airwallex exactly once.
//   3. The agent plans its bills, converts only what it must, pays, and puts its compute on its own card.
//   4. A "landlord" email asks for new bank details: escalated. A compromised agent's payout to the
//      attacker's wallet is refused by Metal on chain.
//   5. Reconciliation: every cent explained, by arithmetic.
//
// Flags: --offline  use the simulators;  --manual  wait for approvals on the dashboard instead of auto-approving.

import { spawn } from "node:child_process";
import { Agent, type AgentDeps } from "./agent/loop.js";
import { approvalKey, onTransferState, termsOf } from "./agent/executor.js";
import { Airwallex, type Transfer } from "./airwallex/client.js";
import { webhookRouter } from "./airwallex/webhooks.js";
import { AgentCard, type CardTransaction } from "./airwallex/card.js";
import { RampLedger } from "./bridge/ledger.js";
import { SimulatedDepositCredit } from "./bridge/deposit-credit.js";
import { startDashboard } from "./dashboard/server.js";
import { emit } from "./events.js";
import { ChainEarnings } from "./metal/earnings.js";
import { MandateSweepVerifier, MetalMandate, type PullResult } from "./metal/mandate.js";
import { flowsFromBooks, reconcile, reportReconcile, type CurrencyFlows } from "./reconcile.js";
import { ATTACKER_WALLET, beneficiaries, churnEmail, heistEmail, obligations, policyConfig } from "./scenario.js";
import { FakeAirwallex, FakeMandate, FakeSwarm } from "./sim/offline.js";
import { Store } from "./store.js";
import { ApprovalGate, grant, hashEvidence } from "./treasury/approval.js";
import { fmt, toMinor } from "./treasury/money.js";
import type { Address } from "viem";

const args = new Set(process.argv.slice(2));
const offline = args.has("--offline") || !process.env.AWX_CLIENT_ID || !process.env.METAL_RPC_URL;
const manual = args.has("--manual");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beat = async (n: number, title: string) => {
  emit("observe", `Beat ${n}: ${title}`);
  await sleep(offline ? 600 : 0);
};

const CAP_MINOR = toMinor(500);
const now = new Date();
const store = new Store(offline ? ":memory:" : undefined);
const ledger = new RampLedger(offline ? ":memory:" : process.env.COINSLOT_DB ?? "coinslot.db");
const ben = beneficiaries(!offline);

// --- wire live or offline services behind the same interfaces ---
let awx: AgentDeps["awx"] & ConstructorParameters<typeof SimulatedDepositCredit>[0] & ConstructorParameters<typeof AgentCard>[0];
let verifier: AgentDeps["verifier"];
let earnings: AgentDeps["earnings"];
let refuser: { attemptAndRecordRefusal(to: Address, cents: number): Promise<PullResult> };
let runSwarm: () => Promise<void>;
let advancePayouts: (ids: string[]) => Promise<void> = async () => {};

if (offline) {
  emit("observe", "Running OFFLINE: Airwallex and Metal are simulated; every proof starts with sim:");
  const fake = new FakeAirwallex({ USD: toMinor(400), EUR: toMinor(10) });
  const mandate = new FakeMandate("0xRamp000000000000000000000000000000000001", CAP_MINOR);
  const swarm = new FakeSwarm(ledger);
  awx = fake;
  verifier = mandate;
  earnings = swarm;
  refuser = mandate;
  runSwarm = () => swarm.run(8, 600);
} else {
  const live = Airwallex.fromEnv();
  const mandate = MetalMandate.fromEnv();
  const rpc = process.env.METAL_RPC_URL!;
  const principal = (process.env.METAL_PRINCIPAL as Address | undefined) ?? (await mandate.account());
  awx = live;
  verifier = new MandateSweepVerifier(mandate, store, principal, rpc);
  earnings = new ChainEarnings(rpc, principal, ledger, CAP_MINOR);
  refuser = mandate;
  runSwarm = () => liveSwarm();
  // Sandbox transfers stay PROCESSING until simulated. VERIFY the transition names with the docs MCP.
  advancePayouts = async (ids) => {
    for (const id of ids) for (const next of ["SENT", "PAID"]) await live.simulateTransfer(id, { next_status: next }).catch((e) => emit("observe", `simulate ${next} on ${id}: ${String(e).slice(0, 120)}`));
  };
}

const globalAccountId = process.env.AWX_GLOBAL_ACCOUNT_ID ?? "sim:ga_usd";
const credit = new SimulatedDepositCredit(awx, globalAccountId);
const deps: AgentDeps = {
  awx, store, ledger, verifier, credit, earnings,
  gate: new ApprovalGate(), approvals: new Map(),
  evidenceHash: (id) => hashEvidence(`invoice:${id}`), reference: (id) => `Coin Slot ${id}`.slice(0, 35),
  baseCurrency: "USD", cfg: policyConfig,
  obligations: obligations(now, ben), allowlist: new Set(Object.values(ben).filter(Boolean)),
  forecast: { expectedInflowMinor: toMinor(300), confidence: 0.85 },
};
const agent = new Agent(deps);
const card = new AgentCard(awx, store, undefined, process.env.AWX_CARD_ID);
let lastReconcile: ReturnType<typeof reconcile> | undefined;

// --- approvals: a person approves the exact terms on screen ---
const pendingApprovals = () => (agent.lastPlan?.actions ?? [])
  .filter((a): a is Extract<typeof a, { kind: "convert" | "pay" }> => (a.kind === "convert" || a.kind === "pay") && a.needsApproval && !deps.approvals.has(approvalKey(a.obligationId, a.kind)))
  .filter((a) => { const op = store.latestOp(a.obligationId, a.kind); return !op || op.status === "failed"; })
  .filter((a, i, all) => all.findIndex((b) => b.obligationId === a.obligationId) === i)
  .map((a) => {
    const o = deps.obligations.find((x) => x.id === a.obligationId);
    return { obligationId: a.obligationId, label: `Pay ${o ? fmt(o.amountMinor, o.currency) : ""} to ${o?.payee ?? a.obligationId}` };
  });

function approve(obligationId: string, approver: string) {
  const granted: string[] = [];
  for (const a of agent.lastPlan?.actions ?? []) {
    if ((a.kind === "convert" || a.kind === "pay") && a.obligationId === obligationId && a.needsApproval) {
      deps.approvals.set(approvalKey(a.obligationId, a.kind), grant(termsOf(a, deps.evidenceHash(a.obligationId)), approver, 10 * 60_000));
      granted.push(a.kind);
    }
  }
  if (granted.length) emit("decide", `${approver} approved ${obligationId} (${granted.join(" + ")}), bound to the exact amount and beneficiary`);
  return { granted };
}

const server = startDashboard({
  state: () => ({ offline, balances: agent.balancesMinor, pendingApprovals: pendingApprovals(), plan: agent.lastPlan, ops: store.ops(), sweeps: ledger.all(), flagged: agent.flagged, reconcile: lastReconcile }),
  approve,
}, undefined, (app) => {
  // Live payouts settle through webhooks when the dashboard is reachable from Airwallex (e.g. via a tunnel).
  const secret = process.env.AWX_WEBHOOK_SECRET;
  if (!secret || offline) return;
  app.use("/webhooks/airwallex", webhookRouter(secret, store, async (e) => {
    const o = e.data.object;
    if (e.name.startsWith("payout.transfer.")) {
      const t = o as unknown as Transfer;
      const ben = deps.obligations.find((x) => x.id === store.opByAirwallexId(t.id)?.obligationId)?.beneficiaryId;
      onTransferState(deps, t, ben !== undefined && deps.allowlist.has(ben));
    } else {
      emit("observe", `Webhook ${e.name}`, { id: o.id });
    }
  }));
});

// --- the five beats ---
await sleep(offline ? 1500 : 0); // time to open the dashboard
const opening = await agent.observe();
const openingMinor = { ...opening.balancesMinor };

await beat(1, "customers pay per call over x402 on Metal");
await runSwarm();

await beat(2, "sweep earnings to Airwallex under a Metal mandate");
await agent.sweep();

await beat(3, "plan the bills, convert only what is needed, pay");
agent.inbox.push(churnEmail);
await agent.tick(now);
const waiting = pendingApprovals();
if (waiting.length) {
  if (manual) {
    emit("escalate", `Waiting for approval on the dashboard: ${waiting.map((w) => w.obligationId).join(", ")}`);
    for (let i = 0; i < 300 && pendingApprovals().length; i++) await sleep(1000);
  } else {
    await sleep(offline ? 2500 : 0);
    for (const w of waiting) approve(w.obligationId, "demo operator");
  }
  await agent.tick(now);
}
await agent.followPayouts();
await advancePayouts(store.ops().filter((o) => o.kind === "pay" && o.status === "submitted" && o.airwallexId).map((o) => o.airwallexId!));
await agent.followPayouts();
await computeBill();

await beat(4, "a fake landlord asks for new bank details");
agent.inbox.push(heistEmail);
await agent.readInbox();
const target = (agent.flagged.at(-1)?.addresses[0] ?? ATTACKER_WALLET) as Address;
emit("decide", `Stress test: suppose the agent were fooled and tried to pay ${target}. Metal's mandate decides, not the agent.`);
await refuser.attemptAndRecordRefusal(target, toMinor(60));

await beat(5, "reconcile every cent");
await agent.observe();
lastReconcile = reconcileNow();
reportReconcile(lastReconcile);

emit("observe", `Demo complete. ${offline ? "Offline run: no real money moved." : "Live sandbox run."} Dashboard stays up; Ctrl+C to exit.`);
if (args.has("--exit")) server.close();

// --- helpers ---
async function computeBill() {
  if (!card.cardId) await card.issue("agent@coinslot.example");
  const merchant = { name: "ANTHROPIC PBC", mcc: "7372", amountMinor: toMinor(12.4) };
  const { transaction_id } = await card.simulateBill(merchant.name, merchant.mcc, merchant.amountMinor);
  // Live, the issuing.transaction webhook carries this; the sandbox simulation returns the id directly.
  const tx: CardTransaction = { id: transaction_id, card_id: card.cardId!, amountMinor: merchant.amountMinor, currency: "USD", merchantName: merchant.name, mcc: merchant.mcc, status: "APPROVED" };
  await card.onTransaction(tx, now);
}

function reconcileNow() {
  const books = flowsFromBooks(store, ledger, "USD");
  const closing = agent.balancesMinor;
  const currencies: Record<string, CurrencyFlows> = {};
  for (const ccy of new Set([...Object.keys(openingMinor), ...Object.keys(closing), ...Object.keys(books)])) {
    const b = books[ccy] ?? { depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 };
    currencies[ccy] = { openingMinor: openingMinor[ccy] ?? 0, closingMinor: closing[ccy] ?? 0, ...b };
  }
  return reconcile({
    rampCurrency: "USD",
    metalSweptMinor: ledger.verifiedOnChainMinor("USD"),
    rampCreditedMinor: ledger.creditedMinor("USD"),
    airwallexDepositsMinor: credit.depositedMinor(),
    currencies,
  });
}

/** Live beat 1: run the buyer swarm against the running seller and mirror its meter. */
async function liveSwarm() {
  const sellerUrl = process.env.SELLER_URL ?? "http://127.0.0.1:4021/v1/answer";
  const meterUrl = new URL("/meter", sellerUrl).toString();
  if (!process.env.METAL_BUYER_KEYS) {
    emit("observe", "METAL_BUYER_KEYS not set: skipping the swarm, sweeping whatever the account already earned");
    return;
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/metal/swarm.ts"], { stdio: "inherit", env: process.env });
  const poll = setInterval(async () => {
    const m = (await fetch(meterUrl).then((r) => r.json()).catch(() => null)) as { paidCalls: number } | null;
    if (m) emit("observe", `${m.paidCalls} paid calls (x402 on Metal testnet)`, { paidCalls: m.paidCalls, earnedMinor: m.paidCalls });
  }, 2000);
  await new Promise((r) => child.on("exit", r));
  clearInterval(poll);
}
