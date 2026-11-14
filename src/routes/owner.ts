// Everything the owner's app calls: it moves the business's money or shows its payees, so the routes
// here ask for the owner (or, for a few, a viewer). Mounted after the viewer mask, so a viewer sees masked bank ids.

import express from "express";
import type { createAuth } from "../auth.js";
import { emit } from "../events.js";
import type { AgentKeys } from "../agents/keys.js";
import type { RampLedger } from "../bridge/ledger.js";
import type { Inbox } from "../inbox/inbox.js";
import { MailError, type Mailbox } from "../inbox/mailbox.js";
import type { PennyChecks } from "../inbox/penny.js";
import { say } from "../inbox/say.js";
import { escrow } from "../metal/escrow.js";
import type { Anchorer, Receipts } from "../metal/receipts.js";
import { whatIf } from "../payouts/decide.js";
import { DISPUTE_SIGNATURE_TTL_MS, disputeMessage, type PayerCheck } from "../payouts/dispute-auth.js";
import { CLAIMS, judge, type Claim, type Disputes, type Proof } from "../payouts/proof.js";
import type { Payout } from "../payouts/book.js";
import type { RiskVerdict } from "../payouts/risk.js";
import { decisionView, PayoutError, publicView, type PayoutService } from "../payouts/service.js";
import type { Store } from "../store.js";
import type { Trail } from "../trail.js";
import { toMinor } from "../treasury/money.js";

export interface OwnerDeps {
  auth: ReturnType<typeof createAuth>;
  store: Store;
  svc: PayoutService;
  inbox: Inbox;
  penny: PennyChecks;
  mailbox: Mailbox;
  keys: AgentKeys;
  trail: Trail;
  receipts: Receipts;
  disputes: Disputes;
  ledger: RampLedger;
  anchorer: Anchorer;
  payerCheck: PayerCheck;
  proofOf: (p: Payout) => Promise<Proof>;
  offline: boolean;
  sandbox: boolean;
  policy: unknown;
  payTo: string;
  refundReserveMinor: () => number;
  /** These change as the tick runs, so they are read at request time. */
  lastBalances: () => unknown;
  lastReconcile: () => unknown;
}

export function ownerRoutes(d: OwnerDeps): express.Router {
  const { auth, store, svc, inbox, penny, mailbox, keys, trail, receipts, disputes, ledger, anchorer, payerCheck, proofOf, offline, sandbox, policy, payTo, refundReserveMinor, lastBalances, lastReconcile } = d;
  const router = express.Router();
  // Sayso's email: its address, and the owner's one-time AgentMail code that lets it email people.
  router.get("/v1/mailbox", auth.requireOwner, (_req, res) => res.json(mailbox.status()));
  router.post("/v1/mailbox/verify", auth.requireOwner, express.json(), async (req, res) => {
    try { res.json(await mailbox.verify(String(req.body?.code ?? ""))); } catch (err) { res.status(err instanceof MailError ? 400 : 502).json({ error: err instanceof Error ? err.message : "failed" }); }
  });
  router.get("/v1/agents", auth.requireOwner, (_req, res) => res.json(keys.list()));
  router.post("/v1/agents", auth.requireOwner, express.json(), (req, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return void res.status(400).json({ error: "name the agent" });
    const cap = req.body?.cap_usd ? Number(req.body.cap_usd) : null;
    if (cap !== null && !(cap > 0)) return void res.status(400).json({ error: "cap_usd must be a positive number" });
    res.status(201).json(keys.create(name, cap === null ? null : toMinor(cap)));
  });
  router.post("/v1/agents/:id/revoke", auth.requireOwner, express.json(), (req, res) => {
    if (!keys.revoke(String(req.params.id))) return void res.status(404).json({ error: "no such agent" });
    res.json({ ok: true });
  });
  const fail = (res: express.Response, err: unknown) => res.status(err instanceof PayoutError ? err.status : 500).json({ error: String((err as Error).message) });

  // A dispute names what it says went wrong; judge() settles it from the proof, in code.
  router.post("/v1/payouts/:id/disputes", express.json(), async (req, res) => {
    if (auth.isViewer(req) && !auth.isOwner(req)) return void res.status(403).json({ error: "This is a read-only look around. Only the owner can pay, approve or change anything.", read_only: true });
    const p = svc.book.get(String(req.params.id));
    if (!p) return void res.status(404).json({ error: "no such payout" });
    const claim = String(req.body?.claim ?? "") as Claim;
    if (!(claim in CLAIMS)) return void res.status(400).json({ error: `claim must be one of ${Object.keys(CLAIMS).join(", ")}` });
    if (p.status !== "paid") return void res.status(409).json({ error: `only a delivered payout can be disputed; this one is ${p.status}` });
    if (!p.buyer || p.buyer.startsWith("internal:")) return void res.status(409).json({ error: "only an agent's payout can be disputed" });
    if (disputes.open(p.id)) return void res.status(409).json({ error: "a dispute on this payout is already waiting for the owner" });
    // Only the owner, signed in, or the agent that paid: a payout id alone is public, so it can't be enough.
    const owner = auth.isOwner(req);
    if (!owner) {
      const mandateRef = (trail.last(p.id, "mandate")?.detail as { ref?: string } | undefined)?.ref;
      const why = await payerCheck({ buyer: p.buyer, payoutId: p.id, claim, body: req.body ?? {}, header: (n) => req.header(n), mandateRef });
      if (why) return void res.status(401).json({ error: why, sign: { message: disputeMessage(p.id, claim, "<issued_at>"), address: p.buyer } });
      // A signed dispute counts once: replaying it inside its 10 minutes would re-run the judgment and re-anchor.
      const sig = String(req.body?.signature ?? "");
      if (sig) {
        store.db.prepare("DELETE FROM used_dispute_signatures WHERE used_at < ?").run(Date.now() - 2 * DISPUTE_SIGNATURE_TTL_MS);
        const fresh = store.db.prepare("INSERT OR IGNORE INTO used_dispute_signatures (signature, used_at) VALUES (?, ?)").run(sig.toLowerCase(), Date.now());
        if (Number(fresh.changes) === 0) return void res.status(409).json({ error: "this signed dispute was already used; sign a new one" });
      }
    }
    const note = String(req.body?.note ?? "").trim().slice(0, 200);
    const by = owner ? "you" : `the paying agent (${p.buyer.slice(0, 8)}…${p.buyer.slice(-4)})`;
    const proof = await proofOf(p);
    const j = judge(claim, proof);
    const d = disputes.add({ payout: p.id, claim, note, by, verdict: j.verdict, reason: j.reason, cites: j.cites, proof_hash: proof.hash });
    trail.add(p.id, "decide", `Disputed by ${by} (${CLAIMS[claim].toLowerCase()}): ${j.verdict}. ${j.reason}`, { claim, note, cites: j.cites, proof_hash: proof.hash });
    try {
      if (j.verdict === "upheld") await svc.dispute(p.id, "Sayso's dispute rules", `${CLAIMS[claim].toLowerCase()}; upheld from the proof`);
      else if (j.verdict === "review") emit("escalate", `A dispute on ${p.payeeName}'s payout needs you: ${CLAIMS[claim]}. ${j.reason}`, { payout: p.id });
      else {
        // Denied: the proof it rests on is anchored on Metal (the tick retries if this fails), so the answer can't be rewritten later.
        const a = await anchorer.anchor(proof.hash as `0x${string}`, (tx) => disputes.anchored(d.id, tx)).catch(() => undefined);
        if (a) disputes.anchored(d.id, a.tx);
        emit("refuse", `Dispute on ${p.payeeName}'s payout denied: ${j.reason}`, { payout: p.id }, a?.explorer);
      }
    } catch (err) { return void fail(res, err); }
    res.status(201).json({ dispute: disputes.for(p.id).find((x) => x.id === d.id), proof, payout: publicView(svc.book.get(p.id)!) });
  });

  // The inbox: forward an invoice here (from the app, or a mail hook holding INBOX_SECRET).
  router.post("/v1/inbox", auth.requireOwnerOrInboxSecret, express.json({ limit: "256kb" }), async (req, res) => {
    const b = req.body as { message_id?: unknown; from?: unknown; subject?: unknown; body?: unknown };
    if (typeof b?.body !== "string" || !b.body || typeof b.from !== "string" || !b.from
      || (b.message_id !== undefined && typeof b.message_id !== "string")
      || (b.subject !== undefined && typeof b.subject !== "string")) return void res.status(400).json({ error: "from, subject, body and message_id must be strings" });
    try {
      const item = await inbox.receive({ messageId: b.message_id ?? `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, from: b.from, subject: b.subject ?? "(no subject)", body: b.body, receivedAt: new Date() });
      res.status(201).json(item);
    } catch (err) { fail(res, err); }
  });
  router.get("/v1/inbox", auth.requireOwner, (_req, res) => res.json(inbox.list().map((i) => i.status === "needs_verification"
    ? { ...i, penny: penny.forInbox(i.id) ?? null, contact_on_file: i.fields.payeeName ? penny.contactOnFile(i.fields.payeeName) ?? null : null }
    : i)));
  // Say a payment. The browser transcribes; Sayso shows what it heard and what it understood, and the
  // invoice it made waits for the same passkey approval as any other.
  router.post("/v1/say", auth.requireOwner, express.json({ limit: "16kb" }), async (req, res) => {
    const transcript = String(req.body?.transcript ?? "").trim();
    if (!transcript) return void res.status(400).json({ error: "say something first" });
    try {
      const r = await say(inbox, transcript);
      if (r.item?.payoutId) trail.add(r.item.payoutId, "heard", `You said: "${r.heard}"`, { understood: r.understood, reader: r.reader });
      res.json({ ...r, item: r.item ? inbox.view(r.item.id) ?? r.item : null });
    } catch (err) { fail(res, err); }
  });
  router.post("/v1/inbox/:id/approve", auth.requireOwner, express.json(), async (req, res) => {
    if (!(await auth.confirmed(req, req.body?.confirmation, "approve", String(req.params.id)))) return void res.status(401).json({ error: "Confirm with your passkey to pay.", need: "passkey" });
    const id = String(req.params.id);
    if (penny.forInbox(id)?.status === "denied") return void res.status(409).json({ error: "The payee said these are not their bank details. Sayso won't pay this invoice." });
    try { res.json(await inbox.approve(id, String(req.body?.approver ?? "owner"), { verifiedWithPayee: req.body?.verified_with_payee === true || penny.confirmed(id) })); } catch (err) { fail(res, err); }
  });
  // Start the one-cent code check on a held invoice, and see where it is.
  router.post("/v1/inbox/:id/penny", auth.requireOwner, express.json(), async (req, res) => {
    try { res.status(201).json(await penny.start(String(req.params.id))); } catch (err) { fail(res, err); }
  });
  router.get("/v1/inbox/:id/penny", auth.requireOwner, (req, res) => {
    const c = penny.forInbox(String(req.params.id));
    const item = inbox.get(String(req.params.id));
    res.json({ check: c ?? null, contact_on_file: item?.fields.payeeName ? penny.contactOnFile(item.fields.payeeName) ?? null : null });
  });
  router.post("/v1/inbox/:id/details", auth.requireOwner, express.json(), async (req, res) => {
    try { res.json(await inbox.complete(String(req.params.id), req.body ?? {})); } catch (err) { fail(res, err); }
  });
  router.post("/v1/inbox/:id/ignore", auth.requireOwner, express.json(), (req, res) => {
    try { res.json(inbox.ignore(String(req.params.id))); } catch (err) { fail(res, err); }
  });

  // The app's own views: every payout (agents' and the inbox's), and the money on hand.
  router.get("/v1/payouts", auth.requireOwner, (_req, res) => res.json(svc.book.list().map(publicView)));
  router.get("/v1/summary", auth.requireOwner, (_req, res) => res.json({ offline: offline, sandbox, balances: lastBalances(), sweeps: ledger.all(), reconcile: lastReconcile(), escrow: escrow(svc.book, ledger, refundReserveMinor()), mandates: policy, pay_to: payTo }));
  // Why a payment happened: every step, with its proof.
  router.get("/v1/payouts/:id/why", auth.requireOwner, (req, res) => {
    const p = svc.book.get(String(req.params.id));
    if (!p) return void res.status(404).json({ error: "no such payout" });
    res.json({ payout: publicView(p), steps: trail.for(p.id), receipts: receipts.get(p.id), disputes: disputes.for(p.id) });
  });
  // What the agent would decide with one input changed. Sandbox and offline only; nothing moves.
  router.post("/v1/payouts/:id/what-if", auth.requireOwnerOrViewer, express.json(), (req, res) => {
    if (!sandbox && !offline) return void res.status(404).json({ error: "what-if is only on the sandbox" });
    const p = svc.book.get(String(req.params.id));
    if (!p?.decision) return void res.status(404).json({ error: "no decision for this payout" });
    const b = req.body ?? {};
    const risk = b.risk === "hold" ? { verdict: "hold" as const, reasons: ["this IBAN has never been paid and the invoice asks to switch bank details"] } : b.risk === "allow" ? { verdict: "allow" as const } : undefined;
    const d = whatIf(p.decision, p.amountMinor, p.currency, new Date(p.createdAt), p.reasons, {
      rateDrift: typeof b.rate_drift_pct === "number" ? b.rate_drift_pct / 100 : undefined,
      spendableUsdzMinor: typeof b.spendable_usdz === "number" ? toMinor(b.spendable_usdz) : undefined,
      risk,
    });
    res.json({ simulated: true, decision: decisionView(d) });
  });
  // The landing's decision board: one sample invoice (EUR 480.00, part payment allowed) run through
  // the same pricing and decide() as a real quote, at Airwallex's EUR rate now, with the inputs a
  // visitor sets. Public; nothing is stored or moved.
  router.post("/v1/decide/preview", express.json({ limit: "1kb" }), async (req, res) => {
    const b = req.body ?? {};
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
    const drift = num(b.rate_drift_pct, -5, 10, 0.3) / 100, spendable = num(b.spendable_usdz, 0, 5000, 820), dueDays = num(b.due_in_days, 0, 60, 6);
    const RISK: Record<string, string> = { newbank: "the invoice asks to pay new bank details that have never been paid", mismatch: "the bank says this account belongs to Mark Lehmann, not Kreuzberg Studio" };
    const why = RISK[String(b.risk)];
    const risk: RiskVerdict = why ? { verdict: "hold", reasons: [why] } : { verdict: "allow" };
    const now = new Date();
    try {
      const r = await svc.preview({ amountMinor: 48000, currency: "EUR", rateDrift: drift, spendableUsdzMinor: toMinor(spendable), risk, dueAt: new Date(now.getTime() + dueDays * 86_400_000), partPaymentAllowed: true, capUsdzMinor: toMinor(800) }, now);
      // Rates as USD per EUR, the way people read them.
      res.json({ sample: true, rate_source: offline ? "simulated" : "airwallex", median: Number((1 / r.liveRate).toFixed(4)), rate: Number((1 / r.rate).toFixed(4)), decision: decisionView(r.decision) });
    } catch (err) { fail(res, err); }
  });
  // A dispute the owner upholds: the agent gets its USDZ back under the refund mandate.
  router.post("/v1/payouts/:id/dispute", auth.requireOwner, express.json(), async (req, res) => {
    if (!(await auth.confirmed(req, req.body?.confirmation, "dispute", String(req.params.id)))) return void res.status(401).json({ error: "Confirm with your passkey to refund it.", need: "passkey" });
    const reason = String(req.body?.reason ?? "").trim().slice(0, 200);
    if (!reason) return void res.status(400).json({ error: "say why the payout was wrong" });
    try {
      const p = await svc.dispute(String(req.params.id), "owner", reason);
      const open = disputes.open(p.id);
      if (open) disputes.settle(open.id, "refunded_by_owner", `You refunded it: ${reason}`);
      res.json(publicView(p));
    } catch (err) { fail(res, err); }
  });
  // The owner keeps a dispute the proof couldn't settle: the payout stands.
  router.post("/v1/payouts/:id/dispute/deny", auth.requireOwner, express.json(), (req, res) => {
    const open = disputes.open(String(req.params.id));
    if (!open) return void res.status(409).json({ error: "no dispute is waiting for you" });
    disputes.settle(open.id, "denied_by_owner", "You kept the payout after reading the proof.");
    trail.add(open.payout, "decide", "You kept the payout after reading the proof");
    res.json({ dispute: disputes.for(open.payout).at(-1) });
  });
  // Accounts agents may pay without the owner reviewing a first payout. Adding one needs the passkey.
  router.get("/v1/payees/trusted", auth.requireOwner, (_req, res) => res.json(svc.book.trustedPayees()));
  router.post("/v1/payees/trust", auth.requireOwner, express.json(), async (req, res) => {
    // The passkey signs for this exact account: name|currency|bank country|bank ids, sorted. A swapped IBAN is a different subject.
    const b = req.body ?? {}, subject = [b.name, b.currency, b.bank_country_code, ...Object.values(b.bank ?? {}).map(String).sort()].map((x) => String(x ?? "")).join("|");
    if (!(await auth.confirmed(req, req.body?.confirmation, "trust", subject))) return void res.status(401).json({ error: "Confirm with your passkey to allow agents to pay this account.", need: "passkey" });
    try { res.json(svc.trustPayee(req.body, "owner")); } catch (err) { fail(res, err); }
  });
  router.post("/v1/payouts/:id/review", auth.requireOwner, express.json(), async (req, res) => {
    if (req.body?.decision !== "reject" && !(await auth.confirmed(req, req.body?.confirmation, "review", String(req.params.id)))) return void res.status(401).json({ error: "Confirm with your passkey to allow it.", need: "passkey" });
    try {
      const approver = String(req.body?.approver ?? "owner");
      res.json(publicView(req.body?.decision === "reject" ? svc.rejectReview(String(req.params.id), approver) : svc.approveReview(String(req.params.id), approver)));
    } catch (err) { fail(res, err); }
  });
  return router;
}
