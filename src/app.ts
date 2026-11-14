// Sayso as one service: the x402 payout API, the invoice inbox, Airwallex webhooks, the
// back office, and the background loop that keeps the float funded and payouts moving.
// `offline: true` swaps Airwallex and Metal for the simulators; everything else is the same code.

import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme, sellerToken } from "@metalntwx/metal-pay";
import { createPublicClient, erc20Abi, http, isAddress, type Address } from "viem";
import { Airwallex, type Transfer } from "./airwallex/client.js";
import { AgentCard, type CardPort } from "./airwallex/card.js";
import { Agent, type LoopAirwallex } from "./agent/loop.js";
import { beneficiaries, obligations, policyConfig } from "./scenario.js";
import { ApprovalGate } from "./treasury/approval.js";
import { webhookRouter } from "./airwallex/webhooks.js";
import { createAuth, publicBase } from "./auth.js";
import { authMdRouter } from "./agents/authmd.js";
import { AgentKeys } from "./agents/keys.js";
import { approvalPath, hostedMcpRouter } from "./mcp/hosted.js";
import { notifierFromEnv } from "./notify.js";
import { RampLedger } from "./bridge/ledger.js";
import { SimulatedDepositCredit } from "./bridge/deposit-credit.js";
import { sweepEpoch, type MetalSettlementVerifier } from "./bridge/ramp.js";
import { dashboardRouter } from "./dashboard/server.js";
import { ownerRoutes } from "./routes/owner.js";
import { proofRoutes } from "./routes/proof.js";
import { webRoutes } from "./routes/web.js";
import { pennyPages } from "./routes/penny.js";
import { forViewer, viewerMask } from "./routes/viewer.js";
import { emit } from "./events.js";
import { Inbox } from "./inbox/inbox.js";
import { machines } from "./machine.js";
import { Platform } from "./platform/platform.js";
import { platformRouter } from "./platform/router.js";
import { PennyChecks } from "./inbox/penny.js";
import { imapFromEnv, pollImap } from "./inbox/imap.js";
import { AgentMailPoller, agentMailRouter } from "./inbox/agentmail.js";
import { Mailbox } from "./inbox/mailbox.js";
import { ChainEarnings, type EarningsSource } from "./metal/earnings.js";
import { MandateRefunder, MandateSweepVerifier, MetalMandate, USDZ, type PullResult } from "./metal/mandate.js";
import { ChainMandateChecker, describeMandate, mandatePolicy, SimMandates } from "./metal/agent-mandate.js";
import { escrow } from "./metal/escrow.js";
import { MetalAnchorer, Receipts, SimAnchorer, type Anchorer } from "./metal/receipts.js";
import { requireSignedOffer } from "@metalntwx/metal-pay/mandates";
import { Trail } from "./trail.js";
import { LIMITS, rateLimit } from "./ratelimit.js";
import { payoutApi, type PaymentMode } from "./payouts/http.js";
import { BatchBook } from "./payouts/batch.js";
import { PayoutError, PayoutService, publicView, type PayoutAirwallex, type Refunder } from "./payouts/service.js";
import { RateMedian } from "./payouts/rates.js";
import type { Payout, PayoutBook } from "./payouts/book.js";
import { booksBefore, flowsFromBooks, rampSince, reconcile, reportReconcile, type CurrencyFlows } from "./reconcile.js";
import { FakeAirwallex, FakeMandate, FakeRefunder } from "./sim/offline.js";
import { Disputes } from "./payouts/proof.js";
import { OfferSigner, storedKey, type BatchTerms } from "./payouts/offer.js";
import { chainPayerCheck, simPayerCheck, type PayerCheck } from "./payouts/dispute-auth.js";
import { Store } from "./store.js";
import { fmt, toMinor } from "./treasury/money.js";

/** Sweep cap per pull, and the USDZ left on the earnings account to cover refunds. */
const SWEEP_CAP_MINOR = toMinor(5000);
/** USDZ kept on the principal for refunds instead of being swept. */
const refundReserveMinor = () => toMinor(Number(process.env.SAYSO_REFUND_RESERVE_USDZ ?? 200));

/** Offline earnings: what delivered payouts earned that has not been released from escrow yet. */
class BookEarnings implements EarningsSource {
  constructor(private readonly book: PayoutBook, private readonly ledger: RampLedger) {}
  async pending() {
    const amountMinor = Math.min(escrow(this.book, this.ledger, refundReserveMinor()).releasableMinor, SWEEP_CAP_MINOR);
    return amountMinor > 0 ? { epoch: `epoch-${this.ledger.all().length + 1}`, amountMinor } : undefined;
  }
}

/** Sayso's own Metal address in offline mode, where agents' payments and mandates name it as payee. */
export const SIM_PAY_TO = "0x5a7505a7505a7505a7505a7505a7505a7505a750";

export interface Sayso {
  offline: boolean;
  /** Sayso's own email address. */
  mailbox: Mailbox;
  app: express.Express;
  svc: PayoutService;
  inbox: Inbox;
  awx: PayoutAirwallex;
  /** Tries to pay a non-ramp address under the sweep mandate, so Metal records the refusal. */
  attemptHeist(to: string, amountMinor: number): Promise<PullResult>;
  tick(): Promise<void>;
  reconcileNow(): Promise<ReturnType<typeof reconcile>>;
  balances(): Promise<Record<string, number>>;
  /** Each payout's reasons, step by step. */
  trail: Trail;
  receipts: Receipts;
  /** Offline only: the simulator's Metal mandates, so a demo can bind one for an agent. */
  simMandates?: SimMandates;
  /** The owner's sign-in token (Bearer, or POST /auth/login). */
  ownerToken: string;
  keys: AgentKeys;
  /** The agent's own Airwallex card for its compute bills. */
  card: AgentCard;
  /** The card's id: AWX_CARD_ID, or a card issued now. Undefined when Airwallex won't issue one. */
  cardReady(): Promise<string | undefined>;
  /**
   * The treasury agent over Sayso's own bills (rent, contractor, designer, data licence): it plans
   * hold / convert / pay with the policy and acts on the same Airwallex account and books.
   * Sweeping stays with Sayso's tick, so the agent's own earnings source is empty.
   */
  treasury(confidence?: number, now?: Date): Agent;
}

/** `simMetal` runs the real Airwallex sandbox with Metal simulated, for when no Metal testnet endpoint is set up yet. */
export async function buildSayso(opts: { offline: boolean; simMetal?: boolean; dbPath?: string }): Promise<Sayso> {
  const dbPath = opts.dbPath ?? (opts.offline ? ":memory:" : process.env.SAYSO_DB ?? "sayso.db");
  const store = new Store(dbPath);
  const ledger = new RampLedger(dbPath);

  let awx: PayoutAirwallex & ConstructorParameters<typeof SimulatedDepositCredit>[0];
  let refunder: Refunder;
  let verifier: MetalSettlementVerifier;
  let heist: (to: string, cents: number) => Promise<PullResult>;
  let mode: PaymentMode;
  let earningsFor: (svc: PayoutService) => EarningsSource;
  let anchorer: Anchorer;
  let anchorAddress: Address | undefined;
  let simMandates: SimMandates | undefined;
  let payerCheck: PayerCheck;
  const policy = mandatePolicy();

  if (opts.offline || opts.simMetal) {
    if (opts.offline) emit("observe", "Running OFFLINE: Airwallex and Metal are simulated; every proof starts with sim:");
    else emit("observe", "Running on the live Airwallex sandbox with Metal simulated; Metal proofs start with sim:");
    awx = opts.offline ? new FakeAirwallex({ USD: toMinor(2000) }) : Airwallex.fromEnv();
    refunder = new FakeRefunder();
    const sweepMandate = new FakeMandate("0xRamp000000000000000000000000000000000001", SWEEP_CAP_MINOR);
    verifier = sweepMandate;
    heist = (to, cents) => sweepMandate.attemptAndRecordRefusal(to, cents);
    simMandates = new SimMandates(SIM_PAY_TO);
    mode = { kind: "sim", mandates: simMandates };
    const sims = simMandates;
    payerCheck = simPayerCheck((ref) => sims.principalOf(ref));
    earningsFor = (svc) => new BookEarnings(svc.book, ledger);
    anchorer = new SimAnchorer();
  } else {
    const rpc = process.env.METAL_RPC_URL;
    if (!rpc) throw new Error("Set METAL_RPC_URL");
    awx = Airwallex.fromEnv();
    const sweep = MetalMandate.fromEnv();
    const principal = (process.env.METAL_PRINCIPAL as Address | undefined) ?? (await sweep.account());
    refunder = MandateRefunder.fromEnv();
    payerCheck = chainPayerCheck(rpc);
    verifier = new MandateSweepVerifier(sweep, store, principal, rpc);
    heist = (to, cents) => sweep.attemptAndRecordRefusal(to as Address, cents);
    const token = process.env.METAL_SELLER_TOKEN;
    const facilitator = new HTTPFacilitatorClient({ url: METAL_NETWORKS.testnet.facilitatorUrl, ...(token ? { createAuthHeaders: sellerToken(token) } : {}) });
    const server = registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] });
    // "required": the agent must sign Sayso's exact offer with its mandate key, checked before settlement.
    if (policy === "required") requireSignedOffer(server, { rpcUrl: rpc });
    mode = { kind: "x402", server, network: METAL_NETWORKS.testnet.network, payTo: principal, mandates: new ChainMandateChecker(rpc) };
    earningsFor = (svc) => {
      const chain = new ChainEarnings(rpc, principal, ledger, SWEEP_CAP_MINOR);
      // The chain says what is there; escrow says how much of it delivered payouts have earned.
      return { pending: async () => {
        const e = await chain.pending();
        const amountMinor = Math.min((e?.amountMinor ?? 0) - refundReserveMinor(), escrow(svc.book, ledger, refundReserveMinor()).releasableMinor);
        return e && amountMinor > 0 ? { ...e, amountMinor } : undefined;
      } };
    };
    let live = MetalAnchorer.fromEnv();
    if (!live && process.env.METAL_RECEIPT_KEY !== "off") {
      // No key given: Sayso makes its own, keeps it in its database, and asks the testnet faucet for gas.
      live = new MetalAnchorer(storedKey(store, "receipts"), rpc);
      const address = live.address;
      emit("observe", `No METAL_RECEIPT_KEY: receipts are anchored on Metal by Sayso's own key ${address}`);
      void sweep.cli(["fund", address])
        .then(() => emit("observe", `Testnet faucet funded the receipt key ${address}`))
        .catch((err) => emit("observe", `Faucet didn't fund the receipt key ${address} (it may already have gas): ${String(err).slice(0, 160)}`));
    }
    if (!live) emit("observe", "METAL_RECEIPT_KEY=off: payout receipts are kept but anchored by the simulator (sim:)");
    anchorer = live ?? new SimAnchorer();
    anchorAddress = live?.address;
  }

  // The Airwallex sandbox says NOT_MATCHED for every payee name, so the name check is off there unless asked for.
  const sandbox = (process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");
  const nameCheck = opts.offline || process.env.AWX_NAME_CHECK === "on" || (!sandbox && process.env.AWX_NAME_CHECK !== "off");
  if (!nameCheck) emit("observe", "Airwallex sandbox: payee name matching is off (the sandbox answers NOT_MATCHED for every name); account existence is still checked");
  if (!process.env.ANTHROPIC_API_KEY) emit("observe", "No ANTHROPIC_API_KEY: invoices and speech are read by keyword rules, not Claude, and every trail says so");
  const trail = new Trail(store);
  trail.follow();
  const receipts = new Receipts(store, anchorer, anchorAddress);
  // Offline, the week's median comes from the ECB history; live, from the rates Airwallex has quoted.
  const rates = opts.offline ? RateMedian.fromCsv() : new RateMedian();
  // Live, what an agent says it can spend is checked against what its address holds on Metal.
  const rpcUrl = process.env.METAL_RPC_URL;
  const balanceOf = !opts.offline && !opts.simMetal && rpcUrl ? (() => {
    const client = createPublicClient({ transport: http(rpcUrl) });
    return async (address: string) => isAddress(address) ? Number((await client.readContract({ address: USDZ, abi: erc20Abi, functionName: "balanceOf", args: [address] })) / 10n ** 16n) : undefined;
  })() : undefined;
  const svc = new PayoutService({ awx, store, refunder, nameCheck, trail, rates, floatReserveMinor: policyConfig.reserveFloorMinor, onFinal: (p) => void receipts.issue(p).catch((e) => emit("escalate", `Receipt for ${p.id.slice(0, 8)} failed: ${String(e).slice(0, 200)}`)), balanceOf, batches: () => batches });
  const inbox = new Inbox(store, svc);
  const keys = new AgentKeys(store);
  const platform = new Platform(store, keys, inbox, { offline: opts.offline, baseUrl: () => publicBase() ?? "", approvalPath });
  // Live, the ramp credits Sayso's own USD global account; a made-up id would only fail later at Airwallex.
  const globalAccount = process.env.AWX_GLOBAL_ACCOUNT_ID || (opts.offline ? "sim:ga_usd" : undefined);
  if (!globalAccount) emit("escalate", "AWX_GLOBAL_ACCOUNT_ID is not set: earnings will not be swept into Airwallex until it is");
  const credit = new SimulatedDepositCredit(awx, globalAccount ?? "");
  const earnings = earningsFor(svc);

  const balances = async () => Object.fromEntries((await awx.currentBalances()).map((b) => [b.currency, toMinor(b.available_amount)]));
  const opening = await balances();
  // The books are reconciled from this moment: what an earlier run did is already in the opening balances.
  const before = booksBefore(store, ledger);
  let lastReconcile: ReturnType<typeof reconcile> | undefined;
  let lastBalances = opening;

  async function sweep() {
    if (!globalAccount) return;
    // Finish the oldest unfinished epoch with its stored amount before starting a new one, so a stuck pull is never repeated.
    const open = ledger.unfinished();
    const e = open ? { epoch: open.epoch, amountMinor: open.amountMinor } : await earnings.pending();
    if (!e) return;
    const r = await sweepEpoch({ ...e, currency: "USD" }, ledger, verifier, credit);
    if (r.outcome === "credited") emit("act", `Moved ${fmt(e.amountMinor, "USD")} of earnings into the Airwallex float, exactly once`, { epoch: e.epoch }, r.sweep.airwallexDepositId ?? undefined);
    else if (r.outcome === "rejected") emit("refuse", `Sweep ${e.epoch} not credited: ${r.sweep.reason}`);
    else if (r.outcome === "pending") emit("observe", `Sweep ${e.epoch} is not final yet (${r.reason}); retrying on the next tick`);
  }

  // Set once the live sandbox refuses to issue a card and the simulator stands in for it.
  let cardSimulated = false;
  async function reconcileNow() {
    await platform.tick().catch((e) => emit("escalate", `Sending events to connected apps failed: ${String(e).slice(0, 200)}`));
    lastBalances = await balances();
    const books = flowsFromBooks(store, ledger, "USD", before, { cardOnAirwallex: !cardSimulated });
    const currencies: Record<string, CurrencyFlows> = {};
    for (const ccy of new Set([...Object.keys(opening), ...Object.keys(lastBalances), ...Object.keys(books)])) {
      const b = books[ccy] ?? { depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 };
      currencies[ccy] = { openingMinor: opening[ccy] ?? 0, closingMinor: lastBalances[ccy] ?? 0, ...b };
    }
    const ramp = rampSince(ledger, "USD", before);
    lastReconcile = reconcile({ rampCurrency: "USD", metalSweptMinor: ramp.verifiedMinor, rampCreditedMinor: ramp.creditedMinor, airwallexDepositsMinor: credit.depositedMinor(), currencies });
    reportReconcile(lastReconcile);
    return lastReconcile;
  }

  const imap = imapFromEnv();
  // Sayso's own email address: made on first start if there isn't one, so nobody sets one up.
  const mailbox = new Mailbox(store, { offline: opts.offline, ownerEmail: process.env.OWNER_EMAIL?.trim().toLowerCase() || undefined });
  if (!opts.offline) await mailbox.ensure().catch((e) => emit("escalate", `Couldn't make Sayso's email address: ${String(e).slice(0, 200)}`));
  // RECONCILE_EVERY_MS=0 turns it off (the demo reconciles once, at the end).
  const reconcileEveryMs = Number(process.env.RECONCILE_EVERY_MS ?? (opts.offline ? 60_000 : 10 * 60_000));
  // The first tick after start reconciles once the opening snapshot has settled.
  let lastReconcileAt = Date.now() - reconcileEveryMs + Math.min(reconcileEveryMs, opts.offline ? 5_000 : 60_000);

  // On the Airwallex sandbox no bank ever answers, so a transfer stays PROCESSING until someone calls
  // the simulation API. Here Sayso plays the payee's bank after a delay, through Airwallex's own
  // simulator, and says so; everything after it (follow, receipts, escrow, sweeps) is the same code a
  // live account runs. Off on a live account, or with AWX_SANDBOX_DELIVER=off.
  const deliverAfterMs = Number(process.env.AWX_SANDBOX_DELIVER_AFTER_MS ?? 60_000);
  const simulateTransfer = "simulateTransfer" in awx ? (awx as Airwallex).simulateTransfer : undefined;
  async function sandboxBank() {
    if (opts.offline || !sandbox || !simulateTransfer || process.env.AWX_SANDBOX_DELIVER === "off") return;
    for (const p of svc.book.byStatus("submitted").filter((x) => x.transferId)) {
      const t = await awx.transferByRequestId(p.id).catch(() => undefined);
      if (!t || Date.now() - new Date(p.createdAt).getTime() < deliverAfterMs) continue;
      const next = t.status === "SENT" ? "PAID" : ["PROCESSING", "SCHEDULED", "SUBMITTED", "PENDING"].includes(t.status) ? "SENT" : undefined;
      if (!next) continue;
      await simulateTransfer(p.transferId!, { next_status: next });
      trail.add(p.id, "observe", `Sandbox: Airwallex's simulator moved transfer ${p.transferId} to ${next}, standing in for the payee's bank`);
    }
  }

  // Without a public URL for the webhook, the AgentMail inbox is polled instead.
  let agentMail: AgentMailPoller | undefined;
  async function tickOnce() {
    await sweep().catch((e) => emit("escalate", `Sweep failed: ${String(e).slice(0, 200)}`));
    await sandboxBank().catch((e) => emit("escalate", `Sandbox delivery failed: ${String(e).slice(0, 200)}`));
    await svc.follow().catch((e) => emit("escalate", `Following payouts failed: ${String(e).slice(0, 200)}`));
    await svc.releaseWaiting().catch((e) => emit("escalate", `Releasing waiting payouts failed: ${String(e).slice(0, 200)}`));
    try { inbox.rescueStranded(); } catch (e) { emit("escalate", `Rescuing stranded invoices failed: ${String(e).slice(0, 200)}`); }
    await receipts.retry().catch((e) => emit("escalate", `Anchoring receipts failed: ${String(e).slice(0, 200)}`));
    try {
      for (const d of disputes.unanchored()) {
        // A denied dispute rests on its anchored proof; one that failed to anchor is tried again here.
        const a = await anchorer.anchor(d.proof_hash as `0x${string}`, (tx) => disputes.anchored(d.id, tx)).catch(() => undefined);
        if (a) disputes.anchored(d.id, a.tx);
      }
    } catch (e) { emit("escalate", `Retrying dispute anchors failed: ${String(e).slice(0, 200)}`); }
    if (imap) await pollImap(imap, inbox).catch((e) => emit("escalate", `Inbox read failed: ${String(e).slice(0, 200)}`));
    const mc = opts.offline || process.env.AGENTMAIL_WEBHOOK_SECRET ? undefined : mailbox.credentials();
    if (mc) agentMail ??= new AgentMailPoller(mc.apiKey, mc.inboxId);
    if (agentMail) await agentMail.poll((e) => inbox.receive(e)).catch((e) => emit("escalate", `AgentMail poll failed: ${String(e).slice(0, 200)}`));
    await platform.tick().catch((e) => emit("escalate", `Sending events to connected apps failed: ${String(e).slice(0, 200)}`));
    lastBalances = await balances().catch(() => lastBalances);
    // The books are checked on their own, not only when someone runs the demo.
    if (reconcileEveryMs > 0 && Date.now() - lastReconcileAt >= reconcileEveryMs) {
      lastReconcileAt = Date.now();
      await reconcileNow().catch((e) => emit("escalate", `Reconciliation failed: ${String(e).slice(0, 200)}`));
    }
  }
  // A slow tick must not overlap the next timer's: a caller that arrives mid-run waits for that run instead of starting another.
  let ticking: Promise<void> | undefined;
  const tick = () => (ticking ??= tickOnce().finally(() => { ticking = undefined; }));

  store.db.exec("CREATE TABLE IF NOT EXISTS used_dispute_signatures (signature TEXT PRIMARY KEY, used_at INTEGER NOT NULL)");

  // ---------- HTTP ----------
  const app = express();
  app.disable("x-powered-by");
  // Nothing the service serves is meant to be framed elsewhere; MCP Apps get view.html as a resource, not an HTTP page.
  app.use((_req, res, next) => {
    res.setHeader("content-security-policy", "frame-ancestors 'self'");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    next();
  });
  // pay_to is Sayso's Metal address: what an owner names as the only payee of an agent's mandate.
  const payTo = (mode.kind === "x402" ? mode.payTo : SIM_PAY_TO) as Address;
  // Sayso's quote key signs every payable quote; agents check offers against this address.
  const offers = new OfferSigner(store);
  // Signed only while the quote is still open: a payout first looked at after it moved on gets no back-dated offer.
  const signBatch = (t: Omit<BatchTerms, "payTo">) => offers.signBatch({ ...t, payTo });
  const signOffer = async (p: Payout) => p.status === "quoted" ? offers.offer(p, payTo) : offers.recorded(p.id) ?? null;
  app.get("/healthz", (_req, res) => res.json({ ok: true, offline: opts.offline, pay_to: payTo, quote_signer: offers.address, agent_mandates: policy }));
  // Public and read-only: every state machine, so an agent or an app never has to guess what a status means.
  app.get("/v1/machines", (_req, res) => res.json(Object.values(machines).map((m) => m.describe())));
  // Public routes that spend Airwallex, Metal RPC or Claude calls get a per-client limit.
  const limited: [string | string[], ReturnType<typeof rateLimit>][] = [
    ["/v1/quotes", rateLimit("quote", LIMITS.quotes)],
    ["/v1/batches", rateLimit("batch", LIMITS.batches)],
    [["/v1/payouts/:id/pay", "/v1/batches/:id/pay", "/v1/payouts/:id/remainder"], rateLimit("payment", LIMITS.pay)],
    ["/v1/payouts/:id/disputes", rateLimit("dispute", LIMITS.disputes)],
    [["/v1/decide/preview", "/v1/payouts/:id/what-if"], rateLimit("preview", LIMITS.preview)],
    [["/auth/login", "/auth/email", "/auth/passkey/login", "/auth/passkey/login/options", "/auth/viewer", "/agent/identity", "/agent/identity/claim", "/oauth2/token", "/oauth2/register"], rateLimit("sign-in", LIMITS.auth)],
    [["/mcp", "/mcp/k/:key", "/v1/agent/invoices"], rateLimit("agent", LIMITS.mcp)],
    [["/v1/platform/payouts"], rateLimit("platform", LIMITS.mcp)],
    ["/v/:token", rateLimit("link", LIMITS.links)],
  ];
  for (const [path, limit] of limited) app.post(path, limit);
  app.get("/v1/payouts/:id/proof", rateLimit("proof", LIMITS.preview));
  app.get("/oauth2/authorize", rateLimit("sign-in", LIMITS.auth));
  app.get("/v1/receipts/latest", rateLimit("receipt", LIMITS.preview));
  // Offline too, so tests can drive the real path; the signature check is what guards it.
  if (process.env.AWX_WEBHOOK_SECRET) {
    app.use("/webhooks/airwallex", webhookRouter(process.env.AWX_WEBHOOK_SECRET, store, async (e) => {
      if (e.name.startsWith("payout.transfer.")) await svc.onTransfer(e.data.object as unknown as Transfer);
    }));
  }
  if (process.env.AGENTMAIL_WEBHOOK_SECRET) app.use(agentMailRouter(process.env.AGENTMAIL_WEBHOOK_SECRET, (e) => inbox.receive(e)));
  const batches = new BatchBook(store, svc);
  app.use(payoutApi(svc, mode, batches, { policy, record: (ids, proof) => ids.forEach((id) => trail.add(id, "mandate", describeMandate(proof), proof as unknown as Record<string, unknown>)) }, signOffer, signBatch));

  // Receipts and proofs are public; disputes are built here because the tick and the owner's routes use them too.
  const disputes = new Disputes(store);
  const { router: proofRouter, receiptView, proofView, proofOf } = proofRoutes({ svc, receipts, anchorAddress, offline: opts.offline, awx, trail, offers, disputes });
  app.use(proofRouter);
  app.use(webRoutes({ inbox }));

  // The one-cent code check: the payee's side, reached from the email sent to the contact on file.
  // Plain HTML forms, no script, so it works in any mail app's browser.
  const penny = new PennyChecks({ store, svc, inbox, awx, send: mailbox.sender(), publicUrl: publicBase(), offline: opts.offline });
  app.use(pennyPages(penny, svc));

  // Everything below moves the business's money or shows its payees, so it needs the owner.
  const auth = createAuth({ offline: opts.offline, log: (l) => emit("observe", l, undefined, undefined, { private: true }), store, send: mailbox.sender() });
  app.use(auth.router);
  app.use(viewerMask((req) => auth.isViewer(req)));

  // Agents connect over the hosted MCP endpoint, with a key the owner makes here or by signing
  // themselves up through auth.md, which the owner confirms with their passkey.
  app.use(authMdRouter({ store, keys, auth }));
  const notify = notifierFromEnv();
  // Apps that pay through Sayso (Base44 apps, any backend) use their own keys and rules; those keys don't open the agent MCP.
  app.use(platformRouter(platform, keys, auth.requireOwner));
  app.use(hostedMcpRouter({ svc, inbox, keys, notify, mailbox, isPlatformKey: platform.isPlatformKey, views: { receipt: receiptView, proof: proofView } }));
  app.use(ownerRoutes({ auth, store, svc, inbox, penny, mailbox, keys, trail, receipts, disputes, ledger, anchorer, payerCheck, proofOf, offline: opts.offline, sandbox, policy, payTo, refundReserveMinor, lastBalances: () => lastBalances, lastReconcile: () => lastReconcile }));

  app.use("/ops", auth.requireOwner, dashboardRouter({
    viewFor: (req) => (auth.isOwner(req) ? "owner" : auth.isViewer(req) ? "viewer" : undefined),
    forViewer,
    state: () => ({
      offline: opts.offline,
      balances: lastBalances,
      pendingApprovals: [
        ...inbox.list().filter((i) => i.status === "awaiting_approval").map((i) => ({ obligationId: i.id, label: `Pay ${i.payout?.amount} ${i.payout?.currency} to ${i.payout?.payee}` })),
        ...svc.book.list().filter((p) => p.status === "needs_review" && !inbox.list().some((i) => i.payoutId === p.id)).map((p) => ({ obligationId: p.id, label: `Review ${fmt(p.amountMinor, p.currency)} to ${p.payeeName}: ${p.reasons.join("; ")}` })),
      ],
      payouts: svc.book.list().map(publicView),
      inbox: inbox.list(),
      sweeps: ledger.all(),
      reconcile: lastReconcile,
    }),
    approve: async (id, approver, body) => {
      if (!opts.offline || auth.hasPasskey()) throw new PayoutError(403, "Approve this in the app, where your passkey confirms it.");
      if (penny.forInbox(id)?.status === "denied") throw new PayoutError(409, "The payee said these are not their bank details. Sayso won't pay this invoice.");
      if (inbox.get(id)) return inbox.approve(id, approver, { verifiedWithPayee: body.verified_with_payee === true });
      return publicView(svc.approveReview(id, approver));
    },
  }));

  let card = new AgentCard(awx as unknown as CardPort, store, undefined, process.env.AWX_CARD_ID || undefined);
  async function cardReady(): Promise<string | undefined> {
    if (card.cardId) return card.cardId;
    try {
      return await card.issue(process.env.AWX_CARDHOLDER_EMAIL ?? "agent@sayso.example", process.env.AWX_CARD_CREATED_BY ?? "Sayso Agent");
    } catch (err) {
      if (opts.offline) {
        emit("escalate", `Airwallex would not issue the agent card: ${String(err).slice(0, 200)}`);
        return undefined;
      }
      // Our sandbox account can't issue cards, so the card runs on the simulator, which applies the
      // same category and amount rules; its ids start with sim: so nobody mistakes them for Airwallex's.
      emit("observe", `Airwallex would not issue the agent card (${String(err).slice(0, 120)}); using the simulated card, which applies the same limits`);
      card = new AgentCard(new FakeAirwallex({}) as unknown as CardPort, store);
      cardSimulated = true;
      return card.issue("agent@sayso.example", "Sayso Agent");
    }
  }

  const treasury = (confidence = 0.85, now = new Date()) => {
    const ben = beneficiaries(!opts.offline);
    const unused = async () => { throw new Error("sweeps run in Sayso's tick"); };
    return new Agent({
      awx: awx as unknown as LoopAirwallex, store, ledger, verifier: { verify: unused } as unknown as MetalSettlementVerifier, credit: { credit: unused },
      earnings: { pending: async () => undefined }, gate: new ApprovalGate(), approvals: new Map(), evidenceHash: (id) => id, reference: (id) => `Sayso ${id}`.slice(0, 35),
      baseCurrency: "USD", cfg: policyConfig, obligations: obligations(now, ben), allowlist: new Set(Object.values(ben).filter(Boolean)),
      forecast: { expectedInflowMinor: toMinor(300), confidence },
    });
  };

  return { offline: opts.offline, app, svc, inbox, awx, attemptHeist: heist, tick, reconcileNow, balances, ownerToken: auth.ownerToken, keys, mailbox, get card() { return card; }, cardReady, treasury, trail, receipts, simMandates };
}
