// Sayso as one service: the x402 payout API, the invoice inbox, Airwallex webhooks, the
// back office, and the background loop that keeps the float funded and payouts moving.
// `offline: true` swaps Airwallex and Metal for the simulators; everything else is the same code.

import express from "express";
import { fileURLToPath } from "node:url";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme, sellerToken } from "@metalntwx/metal-pay";
import type { Address } from "viem";
import { Airwallex, type Transfer } from "./airwallex/client.js";
import { AgentCard, type CardPort } from "./airwallex/card.js";
import { Agent, type LoopAirwallex } from "./agent/loop.js";
import { beneficiaries, obligations, policyConfig } from "./scenario.js";
import { ApprovalGate } from "./treasury/approval.js";
import { webhookRouter } from "./airwallex/webhooks.js";
import { createAuth } from "./auth.js";
import { authMdRouter } from "./agents/authmd.js";
import { AgentKeys } from "./agents/keys.js";
import { hostedMcpRouter, shortCode } from "./mcp/hosted.js";
import { notifierFromEnv } from "./notify.js";
import { RampLedger } from "./bridge/ledger.js";
import { SimulatedDepositCredit } from "./bridge/deposit-credit.js";
import { sweepEpoch, type MetalSettlementVerifier } from "./bridge/ramp.js";
import { dashboardRouter } from "./dashboard/server.js";
import { emit } from "./events.js";
import { Inbox } from "./inbox/inbox.js";
import { say } from "./inbox/say.js";
import { last4, PennyChecks } from "./inbox/penny.js";
import { imapFromEnv, pollImap } from "./inbox/imap.js";
import { AgentMailPoller, agentMailRouter, agentMailSenderFromEnv } from "./inbox/agentmail.js";
import { ChainEarnings, type EarningsSource } from "./metal/earnings.js";
import { MandateRefunder, MandateSweepVerifier, MetalMandate, type PullResult } from "./metal/mandate.js";
import { ChainMandateChecker, describeMandate, mandatePolicy, SimMandates } from "./metal/agent-mandate.js";
import { escrow } from "./metal/escrow.js";
import { MetalAnchorer, Receipts, SimAnchorer, type Anchorer } from "./metal/receipts.js";
import { requireSignedOffer } from "@metalntwx/metal-pay/mandates";
import { Trail } from "./trail.js";
import { payoutApi, type PaymentMode } from "./payouts/http.js";
import { BatchBook } from "./payouts/batch.js";
import { PayoutError, PayoutService, publicView, type PayoutAirwallex, type Refunder } from "./payouts/service.js";
import type { PayoutBook } from "./payouts/book.js";
import { flowsFromBooks, reconcile, reportReconcile, type CurrencyFlows } from "./reconcile.js";
import { FakeAirwallex, FakeMandate, FakeRefunder } from "./sim/offline.js";
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
export const SIM_PAY_TO = "0x5a7505a7505a7505a7505a7505a7505a7505a75";

export interface Sayso {
  offline: boolean;
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
    earningsFor = (svc) => new BookEarnings(svc.book, ledger);
    anchorer = new SimAnchorer();
  } else {
    const rpc = process.env.METAL_RPC_URL;
    if (!rpc) throw new Error("Set METAL_RPC_URL");
    awx = Airwallex.fromEnv();
    const sweep = MetalMandate.fromEnv();
    const principal = (process.env.METAL_PRINCIPAL as Address | undefined) ?? (await sweep.account());
    refunder = MandateRefunder.fromEnv();
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
    const live = MetalAnchorer.fromEnv();
    if (!live) emit("observe", "No METAL_RECEIPT_KEY: payout receipts are kept but anchored by the simulator (sim:)");
    anchorer = live ?? new SimAnchorer();
    anchorAddress = live?.address;
  }

  // The Airwallex sandbox says NOT_MATCHED for every payee name, so the name check is off there unless asked for.
  const sandbox = (process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com").includes("sandbox");
  const nameCheck = opts.offline || process.env.AWX_NAME_CHECK === "on" || (!sandbox && process.env.AWX_NAME_CHECK !== "off");
  if (!nameCheck) emit("observe", "Airwallex sandbox: payee name matching is off (the sandbox answers NOT_MATCHED for every name); account existence is still checked");
  const trail = new Trail(store);
  trail.follow();
  const receipts = new Receipts(store, anchorer, anchorAddress);
  const svc = new PayoutService({ awx, store, refunder, nameCheck, trail, onFinal: (p) => void receipts.issue(p) });
  const inbox = new Inbox(store, svc);
  const credit = new SimulatedDepositCredit(awx, process.env.AWX_GLOBAL_ACCOUNT_ID ?? "sim:ga_usd");
  const earnings = earningsFor(svc);

  const balances = async () => Object.fromEntries((await awx.currentBalances()).map((b) => [b.currency, toMinor(b.available_amount)]));
  const opening = await balances();
  let lastReconcile: ReturnType<typeof reconcile> | undefined;
  let lastBalances = opening;

  async function sweep() {
    const e = await earnings.pending();
    if (!e) return;
    const r = await sweepEpoch({ ...e, currency: "USD" }, ledger, verifier, credit);
    if (r.outcome === "credited") emit("act", `Moved ${fmt(e.amountMinor, "USD")} of earnings into the Airwallex float, exactly once`, { epoch: e.epoch }, r.sweep.airwallexDepositId ?? undefined);
    else if (r.outcome === "rejected") emit("refuse", `Sweep ${e.epoch} not credited: ${r.sweep.reason}`);
  }

  async function reconcileNow() {
    lastBalances = await balances();
    const books = flowsFromBooks(store, ledger, "USD");
    const currencies: Record<string, CurrencyFlows> = {};
    for (const ccy of new Set([...Object.keys(opening), ...Object.keys(lastBalances), ...Object.keys(books)])) {
      const b = books[ccy] ?? { depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 };
      currencies[ccy] = { openingMinor: opening[ccy] ?? 0, closingMinor: lastBalances[ccy] ?? 0, ...b };
    }
    lastReconcile = reconcile({ rampCurrency: "USD", metalSweptMinor: ledger.verifiedOnChainMinor("USD"), rampCreditedMinor: ledger.creditedMinor("USD"), airwallexDepositsMinor: credit.depositedMinor(), currencies });
    reportReconcile(lastReconcile);
    return lastReconcile;
  }

  const imap = imapFromEnv();
  // Without a public URL for the webhook, the AgentMail inbox is polled instead.
  const agentMail = opts.offline || process.env.AGENTMAIL_WEBHOOK_SECRET ? undefined : AgentMailPoller.fromEnv();
  async function tick() {
    await sweep().catch((e) => emit("escalate", `Sweep failed: ${String(e).slice(0, 200)}`));
    await svc.follow().catch((e) => emit("escalate", `Following payouts failed: ${String(e).slice(0, 200)}`));
    await receipts.retry();
    if (imap) await pollImap(imap, inbox);
    if (agentMail) await agentMail.poll((e) => inbox.receive(e)).catch((e) => emit("escalate", `AgentMail poll failed: ${String(e).slice(0, 200)}`));
    lastBalances = await balances().catch(() => lastBalances);
  }

  // ---------- HTTP ----------
  const app = express();
  // pay_to is Sayso's Metal address: what an owner names as the only payee of an agent's mandate.
  app.get("/healthz", (_req, res) => res.json({ ok: true, offline: opts.offline, pay_to: mode.kind === "x402" ? mode.payTo : SIM_PAY_TO, agent_mandates: policy }));
  if (!opts.offline && process.env.AWX_WEBHOOK_SECRET) {
    app.use("/webhooks/airwallex", webhookRouter(process.env.AWX_WEBHOOK_SECRET, store, async (e) => {
      if (e.name.startsWith("payout.transfer.")) await svc.onTransfer(e.data.object as unknown as Transfer);
    }));
  }
  if (process.env.AGENTMAIL_WEBHOOK_SECRET) app.use(agentMailRouter(process.env.AGENTMAIL_WEBHOOK_SECRET, (e) => inbox.receive(e)));
  const batches = new BatchBook(store, svc);
  app.use(payoutApi(svc, mode, batches, { policy, record: (ids, proof) => ids.forEach((id) => trail.add(id, "mandate", describeMandate(proof), proof as unknown as Record<string, unknown>)) }));

  // A payout's receipt, and the Metal transaction that anchors its hash. Public, like the payout itself:
  // it holds no bank details, and anyone can check it against the chain.
  app.get("/v1/payouts/:id/receipt", (req, res) => {
    const p = svc.book.get(String(req.params.id));
    if (!p) return void res.status(404).json({ error: "no such payout" });
    const anchored = receipts.get(p.id);
    if (!anchored.length) return void res.status(409).json({ error: `payout is ${p.status}; a receipt is issued once it is paid or refunded` });
    res.json({
      anchors: anchored, anchor_address: anchorAddress ?? null,
      how_to_verify: "SHA-256 the receipt's JSON with its keys sorted (no spaces); the anchor transaction's data is 0x534159534f31 (\"SAYSO1\") followed by that hash, sent by anchor_address to itself.",
    });
  });

  const webDir = fileURLToPath(new URL("./web", import.meta.url));
  // The app itself: static files under a strict CSP, since it renders text from strangers' emails.
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });
  // On-device Whisper for "say a payment": the worker may fetch the model from Hugging Face and run WASM, nothing else.
  const nodeModules = fileURLToPath(new URL("../node_modules/", import.meta.url));
  app.get("/whisper-worker.js", (_req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co");
    res.sendFile("whisper-worker.js", { root: webDir });
  });
  app.use("/vendor/transformers", express.static(nodeModules + "@huggingface/transformers/dist", { immutable: true, maxAge: "30d" }));
  app.use("/vendor/ort", express.static(nodeModules + "onnxruntime-web/dist", { immutable: true, maxAge: "30d" }));
  app.use("/", (req, res, next) => {
    if (req.method === "GET" && /^\/(index\.html|app\.js|app\.css|claim|c\/[\w-]+|approve\/.+)?$/.test(req.path)) {
      res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader("cache-control", "no-cache");
    }
    next();
  }, express.static(webDir, { index: "index.html" }));
  // A one-tap approval link opens the app on that invoice (the page asks for sign-in if needed).
  app.get("/approve/:id", (_req, res) => res.sendFile("index.html", { root: webDir }));
  // The short form agents send: /p/ and a hash of the invoice id.
  app.get("/p/:code", (req, res) => {
    const item = inbox.list().find((i) => shortCode(i.id) === req.params.code);
    res.redirect(302, item ? `/approve/${encodeURIComponent(item.id)}` : "/");
  });
  // An agent's auth.md claim link lands here (/c/ is the short form); the app asks for the code and a passkey check.
  app.get(["/claim", "/c/:token"], (_req, res) => res.sendFile("index.html", { root: webDir }));

  // The one-cent code check: the payee's side, reached from the email sent to the contact on file.
  // Plain HTML forms, no script, so it works in any mail app's browser.
  const penny = new PennyChecks({ store, svc, inbox, awx, send: opts.offline ? undefined : agentMailSenderFromEnv(), publicUrl: process.env.PUBLIC_URL, offline: opts.offline });
  const pennyPage = (res: express.Response, status: number, body: string) => {
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayso: confirm your bank details</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 16px;color:#111;background:#fafafa}h1{font-size:1.3rem}input{font:inherit;font-size:1.6rem;letter-spacing:.3em;width:100%;padding:.5rem;box-sizing:border-box;border:1px solid #bbb;border-radius:10px}button{font:inherit;width:100%;padding:.75rem;margin-top:.75rem;border:0;border-radius:10px;background:#111;color:#fff}.no{background:none;color:#b00020;border:1px solid #e3b5bc}.m{padding:.75rem;border-radius:10px;background:#eef}</style></head><body>${body}</body></html>`);
  };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  app.get("/v/:token", (req, res) => {
    const c = penny.byToken(String(req.params.token));
    if (!c) return pennyPage(res, 404, "<h1>This link isn't valid.</h1>");
    if (c.status !== "sent") return pennyPage(res, 200, `<h1>${c.status === "confirmed" ? "Already confirmed. Thank you." : "This check is closed."}</h1>`);
    const p = svc.book.get(c.payoutId);
    const who = esc(c.item?.fields.payeeName ?? "you");
    pennyPage(res, 200, `<h1>Did ${who} change its bank details?</h1><p>Someone sent an invoice asking to be paid ${esc(p ? `${(p.amountMinor / 100).toFixed(2)} ${p.currency}` : "")} into an account ending <b>${esc(p ? last4(p.beneficiary) : "")}</b>.</p><p>If that account is yours, we sent it 0.01 with a 6-digit code in the reference. Enter the code:</p>
<form method="post"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button>Confirm</button></form>
<form method="post"><input type="hidden" name="denied" value="1"><button class="no">These aren't our bank details</button></form>`);
  });
  app.post("/v/:token", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const r = penny.answer(String(req.params.token), { code: String(req.body?.code ?? ""), denied: req.body?.denied === "1" });
    pennyPage(res, r.ok ? 200 : 400, `<h1>${esc(r.message)}</h1>${!r.ok && /left/.test(r.message) ? `<form method="get"><button>Try again</button></form>` : ""}`);
  });

  // Everything below moves the business's money or shows its payees, so it needs the owner.
  const auth = createAuth({ offline: opts.offline, log: (l) => emit("observe", l), store, send: opts.offline ? undefined : agentMailSenderFromEnv() });
  app.use(auth.router);

  // Agents connect over the hosted MCP endpoint, with a key the owner makes here or by signing
  // themselves up through auth.md, which the owner confirms with their passkey.
  const keys = new AgentKeys(store);
  app.use(authMdRouter({ store, keys, auth }));
  const notify = notifierFromEnv();
  app.use(hostedMcpRouter({ svc, inbox, keys, notify }));
  app.get("/v1/agents", auth.requireOwner, (_req, res) => res.json(keys.list()));
  app.post("/v1/agents", auth.requireOwner, express.json(), (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return void res.status(400).json({ error: "name the agent" });
    const cap = req.body?.cap_usd ? Number(req.body.cap_usd) : null;
    if (cap !== null && !(cap > 0)) return void res.status(400).json({ error: "cap_usd must be a positive number" });
    res.status(201).json(keys.create(name, cap === null ? null : toMinor(cap)));
  });
  app.post("/v1/agents/:id/revoke", auth.requireOwner, express.json(), (req, res) => {
    if (!keys.revoke(String(req.params.id))) return void res.status(404).json({ error: "no such agent" });
    res.json({ ok: true });
  });
  const fail = (res: express.Response, err: unknown) => res.status(err instanceof PayoutError ? err.status : 500).json({ error: String((err as Error).message) });

  // The inbox: forward an invoice here (from the app, or a mail hook holding INBOX_SECRET).
  app.post("/v1/inbox", auth.requireOwnerOrInboxSecret, express.json({ limit: "256kb" }), async (req, res) => {
    const b = req.body as { message_id?: string; from?: string; subject?: string; body?: string };
    if (!b?.body || !b.from) return void res.status(400).json({ error: "from and body are required" });
    try {
      const item = await inbox.receive({ messageId: b.message_id ?? `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, from: b.from, subject: b.subject ?? "(no subject)", body: b.body, receivedAt: new Date() });
      res.status(201).json(item);
    } catch (err) { fail(res, err); }
  });
  app.get("/v1/inbox", auth.requireOwner, (_req, res) => res.json(inbox.list().map((i) => i.status === "needs_verification"
    ? { ...i, penny: penny.forInbox(i.id) ?? null, contact_on_file: i.fields.payeeName ? penny.contactOnFile(i.fields.payeeName) ?? null : null }
    : i)));
  // Say a payment. The browser transcribes; Sayso shows what it heard and what it understood, and the
  // invoice it made waits for the same passkey approval as any other.
  app.post("/v1/say", auth.requireOwner, express.json({ limit: "16kb" }), async (req, res) => {
    const transcript = String(req.body?.transcript ?? "").trim();
    if (!transcript) return void res.status(400).json({ error: "say something first" });
    try {
      const r = await say(inbox, transcript);
      if (r.item?.payoutId) trail.add(r.item.payoutId, "heard", `You said: "${r.heard}"`, { understood: r.understood, reader: r.reader });
      res.json({ ...r, item: r.item ? inbox.list().find((i) => i.id === r.item!.id) ?? r.item : null });
    } catch (err) { fail(res, err); }
  });
  app.post("/v1/inbox/:id/approve", auth.requireOwner, express.json(), async (req, res) => {
    if (!(await auth.confirmed(req, req.body?.confirmation, "approve", String(req.params.id)))) return void res.status(401).json({ error: "Confirm with your passkey to pay.", need: "passkey" });
    const id = String(req.params.id);
    if (penny.forInbox(id)?.status === "denied") return void res.status(409).json({ error: "The payee said these are not their bank details. Sayso won't pay this invoice." });
    try { res.json(await inbox.approve(id, String(req.body?.approver ?? "owner"), { verifiedWithPayee: req.body?.verified_with_payee === true || penny.confirmed(id) })); } catch (err) { fail(res, err); }
  });
  // Start the one-cent code check on a held invoice, and see where it is.
  app.post("/v1/inbox/:id/penny", auth.requireOwner, express.json(), async (req, res) => {
    try { res.status(201).json(await penny.start(String(req.params.id))); } catch (err) { fail(res, err); }
  });
  app.get("/v1/inbox/:id/penny", auth.requireOwner, (req, res) => {
    const c = penny.forInbox(String(req.params.id));
    const item = inbox.get(String(req.params.id));
    res.json({ check: c ?? null, contact_on_file: item?.fields.payeeName ? penny.contactOnFile(item.fields.payeeName) ?? null : null });
  });
  app.post("/v1/inbox/:id/details", auth.requireOwner, express.json(), async (req, res) => {
    try { res.json(await inbox.complete(String(req.params.id), req.body ?? {})); } catch (err) { fail(res, err); }
  });
  app.post("/v1/inbox/:id/ignore", auth.requireOwner, express.json(), (req, res) => {
    try { res.json(inbox.ignore(String(req.params.id))); } catch (err) { fail(res, err); }
  });

  // The app's own views: every payout (agents' and the inbox's), and the money on hand.
  app.get("/v1/payouts", auth.requireOwner, (_req, res) => res.json(svc.book.list().map(publicView)));
  app.get("/v1/summary", auth.requireOwner, (_req, res) => res.json({ offline: opts.offline, sandbox, balances: lastBalances, sweeps: ledger.all(), reconcile: lastReconcile, escrow: escrow(svc.book, ledger, refundReserveMinor()), mandates: policy, pay_to: mode.kind === "x402" ? mode.payTo : SIM_PAY_TO }));
  // Why a payment happened: every step, with its proof.
  app.get("/v1/payouts/:id/why", auth.requireOwner, (req, res) => {
    const p = svc.book.get(String(req.params.id));
    if (!p) return void res.status(404).json({ error: "no such payout" });
    res.json({ payout: publicView(p), steps: trail.for(p.id), receipts: receipts.get(p.id) });
  });
  app.post("/v1/payouts/:id/review", auth.requireOwner, express.json(), async (req, res) => {
    if (req.body?.decision !== "reject" && !(await auth.confirmed(req, req.body?.confirmation, "review", String(req.params.id)))) return void res.status(401).json({ error: "Confirm with your passkey to allow it.", need: "passkey" });
    try {
      const approver = String(req.body?.approver ?? "owner");
      res.json(publicView(req.body?.decision === "reject" ? svc.rejectReview(String(req.params.id), approver) : svc.approveReview(String(req.params.id), approver)));
    } catch (err) { fail(res, err); }
  });

  app.use("/ops", auth.requireOwner, dashboardRouter({
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
      if (auth.hasPasskey()) throw new PayoutError(403, "Approve this in the app, where your passkey confirms it.");
      if (inbox.get(id)) return inbox.approve(id, approver, { verifiedWithPayee: body.verified_with_payee === true });
      return publicView(svc.approveReview(id, approver));
    },
  }));

  const card = new AgentCard(awx as unknown as CardPort, store, undefined, process.env.AWX_CARD_ID || undefined);
  async function cardReady(): Promise<string | undefined> {
    if (card.cardId) return card.cardId;
    try {
      return await card.issue(process.env.AWX_CARDHOLDER_EMAIL ?? "agent@sayso.example", process.env.AWX_CARD_CREATED_BY ?? "Sayso Agent");
    } catch (err) {
      emit("escalate", `Airwallex would not issue the agent card: ${String(err).slice(0, 200)}`);
      return undefined;
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

  return { offline: opts.offline, app, svc, inbox, awx, attemptHeist: heist, tick, reconcileNow, balances, ownerToken: auth.ownerToken, keys, card, cardReady, treasury, trail, receipts, simMandates };
}
