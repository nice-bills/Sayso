// Sayso's product: any agent holding USDZ asks Sayso to pay a real-world invoice, and
// Sayso pays it in local currency through Airwallex.
//
// The order of operations is the safety argument:
//   1. quote   — price it, read the invoice, run risk, have Airwallex validate the payee. Free.
//   2. accept  — the buyer's x402 payment is verified; the quote is locked (single use).
//   3. funded  — the payment SETTLED on Metal. Only now does any fiat move.
//   4. execute — top up the currency float (convert only the shortfall), pay via Airwallex,
//                idempotent on the payout id as request_id.
//   5. settle  — PAID closes it; FAILED or CANCELLED (even after PAID) refunds the buyer in full under a Metal refund mandate.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AirwallexError, chargedFeeDetail, transferFailure, type Airwallex, type Transfer } from "../airwallex/client.js";
import { readAuto, type Findings } from "../agent/reader.js";
import { emit } from "../events.js";
import type { Store } from "../store.js";
import type { Trail } from "../trail.js";
import { fmt, toMajor, toMinor } from "../treasury/money.js";
import { PayoutBook, payeeHash, type Payout } from "./book.js";
import { DEFAULT_PRICING, price, transferFee, type PricingConfig } from "./pricing.js";
import { decide, DEFAULT_DECIDE, type DecideConfig, type Decision } from "./decide.js";
import { assess, DEFAULT_RISK, type RiskConfig, type RiskVerdict } from "./risk.js";

export type PayoutAirwallex = Pick<Airwallex, "fxRate" | "fxConvert" | "createTransfer" | "transferByRequestId" | "validateBeneficiary" | "createBeneficiary" | "currentBalances">
  & Partial<Pick<Airwallex, "verifyAccount">>;

/** Returns a buyer's USDZ. Live: a Metal mandate with a per-refund cap and a total budget. */
export interface Refunder {
  refund(to: string, amountMinor: number, payoutId: string): Promise<{ tx: string }>;
}

export const PayoutRequest = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "major units, at most 2 decimals"),
  currency: z.string().regex(/^[A-Z]{3}$/),
  method: z.enum(["LOCAL", "SWIFT"]).default("LOCAL"),
  payee: z.object({
    name: z.string().min(1).max(140),
    entity_type: z.enum(["COMPANY", "PERSONAL"]).default("COMPANY"),
    address: z.object({ country_code: z.string().length(2), city: z.string(), street_address: z.string(), postcode: z.string(), state: z.string().optional() }),
    /** Airwallex bank_details fields for the destination, e.g. { iban } or { account_number, account_routing_type1, account_routing_value1 }. */
    bank: z.record(z.string(), z.string()).refine((b) => Object.keys(b).length > 0, "bank details required"),
    bank_country_code: z.string().length(2),
  }),
  reference: z.string().min(1).max(35),
  /** The invoice or email that asked for this payment. Read before paying; it can only make Sayso more careful. */
  invoice_text: z.string().max(20_000).optional(),
  /** The buyer's Metal address, if it wants limits checked at quote time. The settled payer is what counts. */
  buyer: z.string().optional(),
  /** The most the agent will pay for this payout, in USDZ. Above it, the agent waits (or asks for a higher cap). */
  max_usdz: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  /** What the agent can spend now, in USDZ: the lower of its mandate's remaining budget and what it holds. */
  spendable_usdz: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  /** When the invoice is due (YYYY-MM-DD). Without one, the bill is treated as due in 30 days. */
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** The payee accepts part payments, so a short budget can split the invoice. */
  part_payment: z.boolean().default(false),
});
export type PayoutRequest = z.input<typeof PayoutRequest>;

export class PayoutError extends Error {
  constructor(readonly status: number, message: string, readonly payout?: Payout) {
    super(message);
  }
}

export interface PayoutDeps {
  awx: PayoutAirwallex;
  store: Store;
  refunder: Refunder;
  pricing?: PricingConfig;
  risk?: RiskConfig;
  quoteTtlMs?: number;
  read?: (text: string) => Promise<Findings>;
  /** Hold payouts whose account name the bank doesn't fully match. Off for the Airwallex sandbox, which answers NOT_MATCHED for every name. */
  nameCheck?: boolean;
  /** Where each payout's reasons are kept, step by step (the app's "why" view). */
  trail?: Trail;
  /** Called once a payout is final (paid, or refunded): Sayso anchors its receipt on Metal. */
  onFinal?: (p: Payout) => void;
  /** This week's median rate for a currency, in units per 1 USD, so decide() can tell a bad rate from a normal one. */
  rates?: { median(currency: string, now?: Date): number | undefined; record(currency: string, rate: number, at?: Date): void };
  decideConfig?: DecideConfig;
  /** The inbox pays from Sayso's own Airwallex float; this much USD always stays in it. */
  floatReserveMinor?: number;
  /** What an address holds in USDZ cents, read from Metal. Undefined when it can't be read. */
  balanceOf?: (address: string) => Promise<number | undefined>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const isAmbiguous = (err: unknown) => !(err instanceof AirwallexError) || err.status >= 500 || err.status === 408 || err.status === 429;

export class PayoutService {
  readonly book: PayoutBook;
  private readonly basePricing: PricingConfig;
  private readonly previewRates = new Map<string, { rate: number; at: number }>();
  private readonly risk: RiskConfig;
  private readonly ttl: number;
  private readonly read: (text: string) => Promise<Findings>;

  constructor(private readonly d: PayoutDeps) {
    this.book = new PayoutBook(d.store);
    this.basePricing = d.pricing ?? DEFAULT_PRICING;
    this.risk = d.risk ?? DEFAULT_RISK;
    this.ttl = d.quoteTtlMs ?? 120_000;
    this.read = d.read ?? readAuto;
    // A split's second part, once quoted: one per split, so it can't be quoted (or paid) twice.
    d.store.db.exec("CREATE TABLE IF NOT EXISTS split_parts (parent TEXT PRIMARY KEY, child TEXT NOT NULL UNIQUE)");
    // The fee Airwallex last charged per method and currency, read off its own transfers.
    d.store.db.exec("CREATE TABLE IF NOT EXISTS observed_fees (method TEXT NOT NULL, currency TEXT NOT NULL, fee_minor INTEGER NOT NULL, transfer_id TEXT, at TEXT NOT NULL, PRIMARY KEY (method, currency))");
  }

  /** Pricing, with each transfer fee replaced by the one Airwallex actually charged last, once seen. */
  get pricing(): PricingConfig {
    const rows = this.d.store.db.prepare("SELECT method, currency, fee_minor FROM observed_fees").all() as Array<{ method: string; currency: string; fee_minor: number }>;
    if (!rows.length) return this.basePricing;
    const swift = { ...this.basePricing.swiftFeeMinor }, local = { ...this.basePricing.localFeeMinor };
    for (const r of rows) (r.method === "SWIFT" ? swift : local)[r.currency] = r.fee_minor;
    return { ...this.basePricing, swiftFeeMinor: swift, localFeeMinor: local };
  }

  /** Remembers what Airwallex charged for a transfer, so the next quote prices that fee, not a guess. */
  private observeFee(method: string, currency: string, t: Pick<Transfer, "id" | "fee_amount" | "fee_currency">) {
    if (t.fee_currency !== currency || typeof t.fee_amount !== "number" || !Number.isFinite(t.fee_amount)) return;
    const fee = Math.round(t.fee_amount * 100);
    const before = transferFee(method as "LOCAL" | "SWIFT", currency, this.pricing);
    this.d.store.db.prepare("INSERT INTO observed_fees (method, currency, fee_minor, transfer_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (method, currency) DO UPDATE SET fee_minor = excluded.fee_minor, transfer_id = excluded.transfer_id, at = excluded.at")
      .run(method, currency, fee, t.id, new Date().toISOString());
    if (fee !== before) emit("observe", `Airwallex charged ${fmt(fee, currency)} for a ${method} ${currency} transfer (priced at ${fmt(before, currency)}); quotes now use what it charged`, { method, currency, fee_minor: fee }, t.id);
  }

  // ---------- a split's second part ----------

  /** What is left of a split, and the quote for it once one exists. Undefined for anything not split. */
  remainder(p: Payout): { amountMinor: number; quoteId: string | null } | undefined {
    const later = p.decision?.verdict === "split" ? p.decision.tranches?.find((t) => t.when === "on_sweep") : undefined;
    if (!later || later.amountMinor <= 0) return undefined;
    const row = this.d.store.db.prepare("SELECT child FROM split_parts WHERE parent = ?").get(p.id) as { child: string } | undefined;
    return { amountMinor: later.amountMinor, quoteId: row?.child ?? null };
  }

  /**
   * Quotes the rest of a split, to the same payee and bank details, once the first part is paid for.
   * The agent pays it like any quote, after its next top-up; asking again returns the same quote while
   * it can still be paid, and a fresh one once it has expired unpaid.
   */
  async quoteRemainder(id: string, now = new Date()): Promise<Payout> {
    const p = this.book.get(id);
    if (!p) throw new PayoutError(404, "no such payout");
    const left = this.remainder(p);
    if (!left) throw new PayoutError(409, "this payout was not split; nothing is left to pay");
    if (!["funded", "waiting", "submitted", "paid"].includes(p.status)) throw new PayoutError(409, `pay the first part first; it is ${p.status}`);
    const prior = left.quoteId ? this.book.get(left.quoteId) : undefined;
    if (prior && !(prior.status === "quoted" && new Date(prior.expiresAt) < now) && !["expired", "rejected"].includes(prior.status)) return prior;
    const bank = { ...(p.beneficiary.bank_details as Record<string, string>) };
    delete bank.account_currency; delete bank.bank_country_code; delete bank.account_name;
    const b = p.beneficiary as { entity_type: "COMPANY" | "PERSONAL"; address: { country_code: string; city: string; street_address: string; postcode: string; state?: string } };
    const child = await this.quote({
      amount: toMajor(left.amountMinor).toFixed(2), currency: p.currency, method: p.method, reference: p.reference,
      payee: { name: p.payeeName, entity_type: b.entity_type, address: b.address, bank, bank_country_code: p.bankCountry },
      ...(p.buyer && !p.buyer.startsWith("internal:") ? { buyer: p.buyer } : {}),
    }, now);
    this.d.store.db.prepare("INSERT INTO split_parts (parent, child) VALUES (?, ?) ON CONFLICT(parent) DO UPDATE SET child = excluded.child").run(p.id, child.id);
    this.d.trail?.add(p.id, "decide", `Quoted the rest of the split: ${fmt(left.amountMinor, p.currency)} as ${child.id.slice(0, 8)}`, { remainder: child.id }, undefined, now);
    this.d.trail?.add(child.id, "decide", `The second part of split ${p.id.slice(0, 8)}`, { parent: p.id }, undefined, now);
    return child;
  }

  // ---------- 1. quote ----------

  async quote(input: unknown, now = new Date(), opts: { ttlMs?: number; fromFloat?: boolean } = {}): Promise<Payout> {
    const parsed = PayoutRequest.safeParse(input);
    if (!parsed.success) throw new PayoutError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const r = parsed.data;
    const amountMinor = toMinor(Number(r.amount));
    const rate = r.currency === "USD" ? 1 : (await this.d.awx.fxRate("USD", r.currency)).rate;
    const pr = price(amountMinor, r.currency, r.method, rate, this.pricing);
    const bank = { account_currency: r.currency, bank_country_code: r.payee.bank_country_code, account_name: r.payee.name, ...r.payee.bank };
    const hash = payeeHash(bank);
    const id = randomUUID();
    const findings = r.invoice_text ? await this.read(r.invoice_text) : undefined;
    if (findings) {
      // Say which reader it was: without ANTHROPIC_API_KEY the keyword rules stand in for Claude.
      const byClaude = (findings as { reader?: string }).reader !== "keywords";
      this.d.trail?.add(id, "read", `${byClaude ? "Claude" : "The keyword reader (no Claude key)"} read the invoice: ${findings.summary}`, {
        kind: findings.kind, asks_for_new_bank_details: findings.requestsNewBankDetails, pressure_tactics: findings.pressureTactics, citations: findings.citations,
      }, undefined, now);
    }

    const verdict = assess({
      usdValueMinor: pr.costMinor,
      bankCountry: r.payee.bank_country_code,
      payeeSeenBefore: Boolean(this.book.payee(hash)?.firstPaidAt),
      buyerSpentTodayMinor: r.buyer ? this.book.buyerSpentSince(r.buyer, new Date(now.getTime() - 24 * HOUR)) : 0,
      buyerPayoutsLastHour: r.buyer ? this.book.buyerCountSince(r.buyer, new Date(now.getTime() - HOUR)) : 0,
      invoice: findings,
    }, this.risk);

    const beneficiary = {
      entity_type: r.payee.entity_type,
      ...(r.payee.entity_type === "COMPANY" ? { company_name: r.payee.name } : nameParts(r.payee.name)),
      address: r.payee.address,
      bank_details: bank,
    };
    const reasons = verdict.verdict === "allow" ? [] : [...verdict.reasons];
    this.d.trail?.add(id, "risk", verdict.verdict === "allow" ? "Within every risk rule: caps, country, velocity and payee history" : `Risk rules said ${verdict.verdict}: ${verdict.reasons.join("; ")}`, { verdict: verdict.verdict }, undefined, now);
    let status: Payout["status"] = verdict.verdict === "reject" ? "rejected" : verdict.verdict === "hold" ? "needs_review" : "quoted";

    // Airwallex checks the bank details before anyone pays for anything.
    if (status !== "rejected") {
      try {
        await this.d.awx.validateBeneficiary(beneficiary, [r.method]);
        this.d.trail?.add(id, "payee", "Airwallex accepted the bank details as valid", undefined, undefined, now);
      } catch (err) {
        if (err instanceof AirwallexError && err.status < 500) {
          status = "rejected";
          reasons.push(`Airwallex rejected the bank details: ${err.code ?? err.status}`);
          this.d.trail?.add(id, "payee", `Airwallex rejected the bank details: ${err.code ?? err.status}`, undefined, undefined, now);
        } else throw err;
      }
    }

    // Then the bank itself: does the account exist, and is it really the payee's? (VoP / CoP)
    if (status !== "rejected" && r.method === "LOCAL") {
      const check = await this.checkAccount(r.payee.entity_type, bank);
      if (check) this.d.trail?.add(id, "payee", check.said, undefined, undefined, now);
      if (check?.verdict === "reject") { status = "rejected"; reasons.push(check.reason); }
      else if (check?.verdict === "hold") { if (status === "quoted") status = "needs_review"; reasons.push(check.reason); }
    }

    // Price, balance and risk decide what happens: pay, wait, split or hold. Code, not the model.
    const risk: RiskVerdict = status === "rejected" ? { verdict: "reject", reasons } : status === "needs_review" ? { verdict: "hold", reasons } : { verdict: "allow" };
    // What the agent can spend: what it says, but never more than Metal says its address holds.
    let spendableMinor = r.spendable_usdz ? toMinor(Number(r.spendable_usdz)) : Number.MAX_SAFE_INTEGER;
    if (r.buyer && this.d.balanceOf && !opts.fromFloat) {
      const held = await this.d.balanceOf(r.buyer).catch(() => undefined);
      if (held !== undefined) {
        this.d.trail?.add(id, "observe", `Metal says ${r.buyer.slice(0, 8)}…${r.buyer.slice(-4)} holds ${toMajor(held).toFixed(2)} USDZ${r.spendable_usdz && held < spendableMinor ? `, less than the ${r.spendable_usdz} it said it could spend` : ""}`, { address: r.buyer, held_usdz: toMajor(held).toFixed(2) }, undefined, now);
        spendableMinor = Math.min(spendableMinor, held);
      }
    }
    const median = r.currency === "USD" ? undefined : this.d.rates?.median(r.currency, now);
    if (r.currency !== "USD") this.d.rates?.record(r.currency, rate, now);
    const decision = decide({
      amountMinor, currency: r.currency, costUsdzMinor: opts.fromFloat ? pr.costMinor : pr.totalMinor,
      capUsdzMinor: r.max_usdz ? toMinor(Number(r.max_usdz)) : Number.MAX_SAFE_INTEGER,
      // Units per USD: fewer of them than the median means the currency got dearer.
      rateDrift: median ? (median - rate) / median : 0,
      // The inbox spends Sayso's own float, so its balance is what Airwallex holds above the reserve.
      spendableUsdzMinor: opts.fromFloat && !r.spendable_usdz ? await this.floatSpendable(r.currency, rate) : spendableMinor,
      risk, dueAt: r.due_date ? new Date(`${r.due_date}T23:59:59Z`) : new Date(now.getTime() + 30 * DAY), partPaymentAllowed: r.part_payment,
    }, now, this.d.decideConfig ?? DEFAULT_DECIDE);
    if (decision.verdict === "hold" && status === "quoted") { status = "needs_review"; reasons.push(decision.reason); }
    // A split quotes the part that can be paid now; the rest is quoted again (quoteRemainder) after the agent tops up.
    const quoted = decision.verdict === "split" ? this.trimSplit(decision, amountMinor, r.currency, r.method, rate, decision.inputs.spendableUsdzMinor, pr.totalMinor) : { amountMinor, ...pr };

    this.d.trail?.add(id, "decide", decision.reason, { verdict: decision.verdict, decided_by: decision.decidedBy }, undefined, now);

    const p: Payout = {
      id, buyer: r.buyer ?? null, currency: r.currency, amountMinor: quoted.amountMinor, method: r.method,
      bankCountry: r.payee.bank_country_code, payeeName: r.payee.name, payeeHash: hash, beneficiary, reference: r.reference,
      costMinor: quoted.costMinor, feeMinor: quoted.feeMinor, totalMinor: quoted.totalMinor, rateUsed: quoted.rateUsed,
      status, reasons, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (status === "needs_review" ? 24 * HOUR : opts.ttlMs ?? this.ttl)).toISOString(),
      fundingTx: null, transferId: null, refundTx: null, failure: null, decision,
    };
    this.book.insert(p);
    const label = `${fmt(quoted.amountMinor, r.currency)} to ${r.payee.name}`;
    if (status === "quoted") emit("decide", `Quoted ${label}: ${toMajor(quoted.totalMinor).toFixed(2)} USDZ (fee ${toMajor(quoted.feeMinor).toFixed(2)}). ${decision.reason}`, { payout: p.id, verdict: decision.verdict });
    else if (status === "needs_review") emit("escalate", `Held ${label} for review: ${reasons.join("; ")}`, { payout: p.id, citations: findings?.citations });
    else emit("refuse", `Refused ${label}: ${reasons.join("; ")}`, { payout: p.id });
    return p;
  }

  /**
   * Fees don't shrink with the amount, so a split's first tranche is trimmed until its full price
   * fits what the agent can spend. Rewrites the decision's tranches and reason to match.
   */
  private trimSplit(decision: Decision, amountMinor: number, currency: string, method: "LOCAL" | "SWIFT", rate: number, spendableMinor: number, fullTotalMinor: number) {
    let part = decision.tranches?.at(0)?.amountMinor ?? amountMinor;
    let pp = price(part, currency, method, rate, this.pricing);
    while (pp.totalMinor > spendableMinor && part > 0) {
      part -= Math.max(1, Math.ceil((pp.totalMinor - spendableMinor) * pp.rateUsed));
      pp = price(part, currency, method, rate, this.pricing);
    }
    decision.tranches = [{ amountMinor: part, costUsdzMinor: pp.totalMinor, when: "now" }, { amountMinor: amountMinor - part, costUsdzMinor: Math.max(0, fullTotalMinor - pp.totalMinor), when: "on_sweep" }];
    decision.reason = `Splitting: ${toMajor(spendableMinor).toFixed(2)} USDZ can be spent and this costs ${toMajor(fullTotalMinor).toFixed(2)} USDZ, so paying ${fmt(part, currency)} now and ${fmt(amountMinor - part, currency)} after the agent's next top-up.`;
    return { amountMinor: part, ...pp };
  }

  /**
   * What decide() says about an invoice, priced exactly as a quote is (Airwallex's rate now, the
   * same fees, the same split trimming), with the visitor's inputs. Nothing is stored or moved.
   */
  async preview(i: { amountMinor: number; currency: string; rateDrift: number; spendableUsdzMinor: number; risk: RiskVerdict; dueAt: Date; partPaymentAllowed: boolean; capUsdzMinor: number }, now = new Date()) {
    // Every slider move asks again, so Airwallex's rate is kept for a minute.
    const cached = this.previewRates.get(i.currency);
    const live = i.currency === "USD" ? 1 : cached && now.getTime() - cached.at < 60_000 ? cached.rate : (await this.d.awx.fxRate("USD", i.currency)).rate;
    if (i.currency !== "USD" && live !== cached?.rate) this.previewRates.set(i.currency, { rate: live, at: now.getTime() });
    // A positive drift is a worse rate than the median: fewer units of the currency per USD.
    const rate = live * (1 - i.rateDrift);
    const pr = price(i.amountMinor, i.currency, "LOCAL", rate, this.pricing);
    const decision = decide({ amountMinor: i.amountMinor, currency: i.currency, costUsdzMinor: pr.totalMinor, capUsdzMinor: i.capUsdzMinor, rateDrift: i.rateDrift, spendableUsdzMinor: i.spendableUsdzMinor, risk: i.risk, dueAt: i.dueAt, partPaymentAllowed: i.partPaymentAllowed }, now, this.d.decideConfig ?? DEFAULT_DECIDE);
    if (decision.verdict === "split") this.trimSplit(decision, i.amountMinor, i.currency, "LOCAL", rate, i.spendableUsdzMinor, pr.totalMinor);
    return { decision, liveRate: live, rate };
  }

  /** The operator looked at a held payout and is happy to quote it. */
  approveReview(id: string, operator: string, now = new Date(), ttlMs = this.ttl): Payout {
    if (!this.book.transition(id, ["needs_review"], "quoted", { expiresAt: new Date(now.getTime() + ttlMs).toISOString() })) throw new PayoutError(409, "not awaiting review");
    emit("decide", `${operator} cleared payout ${id.slice(0, 8)} after review`, { payout: id });
    return this.book.get(id)!;
  }

  rejectReview(id: string, operator: string): Payout {
    if (!this.book.transition(id, ["needs_review"], "rejected")) throw new PayoutError(409, "not awaiting review");
    emit("refuse", `${operator} rejected payout ${id.slice(0, 8)} after review`, { payout: id });
    return this.book.get(id)!;
  }

  /** The x402 price of a quote, in USDZ major units. Undefined for anything not payable. */
  priceOf(id: string, now = new Date()): string | undefined {
    const p = this.book.get(id);
    if (!p || p.status !== "quoted" || new Date(p.expiresAt) < now || waitsForFunds(p)) return undefined;
    return toMajor(p.totalMinor).toFixed(2);
  }

  // ---------- 2. accept (payment verified, not yet settled) ----------

  accept(id: string, now = new Date()): Payout {
    const p = this.book.get(id);
    if (!p) throw new PayoutError(404, "no such quote");
    if (p.status === "quoted" && new Date(p.expiresAt) < now) {
      this.book.transition(id, ["quoted"], "expired");
      throw new PayoutError(410, "quote expired; ask for a new one");
    }
    if (!this.book.transition(id, ["quoted"], "accepted")) throw new PayoutError(409, `quote is ${p.status}`, p);
    return this.book.get(id)!;
  }

  /** Settlement failed or the request was cancelled: the quote can be paid again until it expires. */
  release(id: string): void {
    if (this.book.transition(id, ["accepted"], "quoted")) emit("observe", `Payment for ${id.slice(0, 8)} did not settle; quote released`, { payout: id });
  }

  /**
   * The operator's own invoices (the inbox): no x402 buyer, the payout is funded from the float
   * the agent already holds. The person's tap is the approval; there is no one to refund.
   */
  async payInternally(id: string, approver: string, now = new Date()): Promise<Payout> {
    this.accept(id, now);
    emit("decide", `${approver} approved paying ${id.slice(0, 8)} from Sayso's own balance`, { payout: id });
    return this.onFunded(id, `internal:${approver}`, `internal:${id}`, now);
  }

  // ---------- 3–4. funded, then execute ----------

  async onFunded(id: string, payer: string, fundingTx: string, now = new Date()): Promise<Payout> {
    if (!this.book.transition(id, ["accepted"], "funded", { buyer: payer, fundingTx })) return this.book.get(id)!;
    const p = this.book.get(id)!;
    if (!payer.startsWith("internal:")) emit("observe", `Received ${toMajor(p.totalMinor).toFixed(2)} USDZ from ${short(payer)} for payout ${id.slice(0, 8)}`, { payout: id }, fundingTx);

    // Limits are re-checked against the payer who actually settled, not the one the request claimed.
    const limits = assess({
      usdValueMinor: p.costMinor, bankCountry: p.bankCountry, payeeSeenBefore: true,
      buyerSpentTodayMinor: this.book.buyerSpentSince(payer, new Date(now.getTime() - 24 * HOUR)) - p.costMinor,
      buyerPayoutsLastHour: 0,
    }, this.risk);
    if (limits.verdict === "reject") return this.fail(p, limits.reasons.join("; "));

    // A wait keeps the agent's USDZ in escrow at the price it was quoted; the transfer runs once the rate is back in band or the wait ends.
    const internal = payer.startsWith("internal:");
    const waits = p.decision?.verdict === "wait" && (p.decision.decidedBy === "price" || (internal && p.decision.until?.fundsUsdzMinor !== undefined && (await this.floatSpendable(p.currency, p.rateUsed)) < p.costMinor));
    if (waits && this.book.transition(id, ["funded"], "waiting")) {
      emit("decide", internal ? `Approved, and waiting: ${p.decision!.reason}` : `Holding ${toMajor(p.totalMinor).toFixed(2)} USDZ in escrow for ${p.payeeName}: ${p.decision!.reason}`, { payout: id }, internal ? undefined : fundingTx);
      return this.book.get(id)!;
    }
    return this.execute(p);
  }

  /** Waiting payouts whose rate is back in band, or whose wait has run out, are paid. Runs on every tick. */
  async releaseWaiting(now = new Date()): Promise<Payout[]> {
    const released: Payout[] = [];
    for (const p of this.book.waiting()) {
      const until = p.decision?.until;
      const median = this.d.rates?.median(p.currency, now);
      const rate = (await this.d.awx.fxRate("USD", p.currency).catch(() => undefined))?.rate;
      if (rate) this.d.rates?.record(p.currency, rate, now);
      const drift = median && rate ? (median - rate) / median : 0;
      const inBand = until?.rateWithinPct === undefined || drift <= until.rateWithinPct;
      const timeUp = until?.by !== undefined && now.toISOString().slice(0, 10) >= until.by;
      if (until?.fundsUsdzMinor !== undefined) {
        // Waiting for the float: an earnings sweep on this tick may have just topped it up.
        if ((await this.floatSpendable(p.currency, rate ?? p.rateUsed)) < p.costMinor) continue;
        if (!this.book.transition(p.id, ["waiting"], "funded")) continue;
        emit("decide", `Releasing ${p.payeeName}'s payout: the float now covers it`, { payout: p.id });
        this.d.trail?.add(p.id, "decide", "Earnings landed in the float, so it pays now", undefined, undefined, now);
        released.push(await this.execute(this.book.get(p.id)!));
        continue;
      }
      if (!inBand && !timeUp) continue;
      if (!this.book.transition(p.id, ["waiting"], "funded")) continue;
      emit("decide", `Releasing ${p.payeeName}'s payout: ${inBand ? `${p.currency} is back within ${(until?.rateWithinPct ?? 0) * 100}% of its median` : "the wait ended before the due date"}`, { payout: p.id });
      this.d.trail?.add(p.id, "decide", inBand ? "The rate came back into band, so it pays now" : "The wait ended a day before the due date, so it pays at today's rate", undefined, undefined, now);
      released.push(await this.execute(this.book.get(p.id)!));
    }
    return released;
  }

  /** USD-equivalent cents the float can spend on a payout in `currency`: USD above the reserve, plus that currency already held. */
  private async floatSpendable(currency: string, rate: number): Promise<number> {
    const balances = await this.d.awx.currentBalances();
    const held = (ccy: string) => toMinor(balances.find((b) => b.currency === ccy)?.available_amount ?? 0);
    const usd = Math.max(0, held("USD") - (this.d.floatReserveMinor ?? 0));
    return currency === "USD" ? usd : usd + Math.floor(held(currency) / (rate || 1));
  }

  private async execute(p: Payout): Promise<Payout> {
    try {
      await this.ensureFloat(p);
    } catch (err) {
      return this.fail(p, `could not fund ${p.currency}: ${String(err instanceof Error ? err.message : err)}`);
    }

    let beneficiaryId = this.book.payee(p.payeeHash)?.beneficiaryId;
    if (!beneficiaryId) {
      try {
        beneficiaryId = (await this.d.awx.createBeneficiary({ beneficiary: p.beneficiary, transfer_methods: [p.method], nickname: p.payeeName.slice(0, 50) })).id;
        this.book.savePayee(p.payeeHash, beneficiaryId);
      } catch (err) {
        return this.fail(p, `Airwallex would not create the beneficiary: ${String(err).slice(0, 200)}`);
      }
    }
    return this.submit(p, beneficiaryId);
  }

  private async ensureFloat(p: Payout): Promise<void> {
    const need = p.amountMinor + transferFee(p.method, p.currency, this.pricing);
    const balances = await this.d.awx.currentBalances();
    const have = toMinor(balances.find((b) => b.currency === p.currency)?.available_amount ?? 0);
    if (have >= need) {
      emit("decide", `Paying ${fmt(need, p.currency)} from ${p.currency} already held; no conversion`, { payout: p.id });
      return;
    }
    if (p.currency === "USD") throw new Error(`USD float is ${fmt(have, "USD")}, need ${fmt(need, "USD")}`);
    const buyMinor = need - have;
    const requestId = randomUUID();
    this.d.store.insertOp({ requestId, obligationId: p.id, kind: "convert", attempt: 1, status: "submitted", currency: p.currency, amountMinor: buyMinor });
    const c = await this.d.awx.fxConvert({ request_id: requestId, sell_currency: "USD", buy_currency: p.currency, buy_amount: toMajor(buyMinor).toFixed(2) });
    this.d.store.updateOp(requestId, "settled", c.id, JSON.stringify({ sell_currency: "USD", sell_minor: toMinor(c.sell_amount) }));
    emit("act", `Converted ${toMajor(toMinor(c.sell_amount)).toFixed(2)} USD into the ${fmt(buyMinor, p.currency)} shortfall`, { payout: p.id }, c.id);
  }

  /** Airwallex account verification. Anything short of a full name match waits for a person; an outage never blocks. */
  private async checkAccount(entityType: "COMPANY" | "PERSONAL", bank: Record<string, string>): Promise<{ verdict?: "reject" | "hold"; reason: string; said: string } | undefined> {
    if (!this.d.awx.verifyAccount) return undefined;
    const v = await this.d.awx.verifyAccount({ entity_type: entityType, transfer_method: "LOCAL", bank_details: bank }).catch(() => undefined);
    if (!v) return undefined;
    if (v.code === "INVALID") return { verdict: "reject", reason: "the bank says this account does not exist or is closed", said: "The payee's bank says this account does not exist or is closed" };
    const match = v.details?.account_name_match_result;
    const holder = v.details?.resolved_account_name;
    const said = holder ? `The payee's bank says the account belongs to ${holder}` : `The payee's bank checked the account (${v.code})`;
    if (this.d.nameCheck === false) return { reason: "", said: `The payee's bank says the account exists (name matching is off on the sandbox)` };
    if (v.code !== "VERIFIED" || !match || match === "FULL_MATCH") return { reason: "", said };
    return { verdict: "hold", reason: holder ? `the bank says this account belongs to ${holder}, not ${bank.account_name}` : `the account name does not fully match the bank's record (${match})`, said };
  }

  private async submit(p: Payout, beneficiaryId: string): Promise<Payout> {
    const body = {
      request_id: p.id, beneficiary_id: beneficiaryId, transfer_amount: toMajor(p.amountMinor).toFixed(2), transfer_currency: p.currency,
      transfer_method: p.method, reference: p.reference, source_currency: p.currency, reason: "business_expenses" as const,
    };
    const fee = transferFee(p.method, p.currency, this.pricing);
    this.d.store.insertOp({ requestId: p.id, obligationId: p.id, kind: "pay", attempt: 1, status: "submitted", currency: p.currency, amountMinor: p.amountMinor, detail: JSON.stringify({ fee_minor: fee }) });
    let t: Transfer | undefined;
    try {
      t = await this.d.awx.createTransfer(body);
    } catch (err) {
      if (!isAmbiguous(err)) {
        this.d.store.updateOp(p.id, "failed", null, String(err));
        return this.fail(p, `Airwallex rejected the transfer: ${String(err).slice(0, 200)}`);
      }
      // Never resend blind: the payout id is the request_id, so look it up first.
      t = (await this.d.awx.transferByRequestId(p.id).catch(() => undefined)) ?? (await this.d.awx.createTransfer(body).catch(() => undefined));
      if (!t) {
        this.d.store.updateOp(p.id, "ambiguous", null, String(err));
        emit("escalate", `Payout ${p.id.slice(0, 8)} outcome unknown after one retry; held for a person, buyer not refunded yet`, { payout: p.id });
        return this.book.get(p.id)!;
      }
    }
    // Record the fee Airwallex actually charged, so reconciliation uses its number, not our estimate.
    this.d.store.updateOp(p.id, "submitted", t.id, chargedFeeDetail(t, p.currency));
    this.observeFee(p.method, p.currency, t);
    this.book.transition(p.id, ["funded"], "submitted", { transferId: t.id });
    emit("act", `Paying ${fmt(p.amountMinor, p.currency)} to ${p.payeeName} via ${p.method}`, { payout: p.id, status: t.status }, t.id);
    return this.book.get(p.id)!;
  }

  // ---------- 5. settle or refund ----------

  async onTransfer(t: Transfer, now = new Date()): Promise<Payout | undefined> {
    const p = this.book.byTransferId(t.id) ?? this.book.get(t.request_id);
    if (!p) return undefined;
    if (t.status === "PAID" && this.book.transition(p.id, ["submitted"], "paid")) {
      this.d.store.updateOp(p.id, "settled");
      this.book.markPayeePaid(p.payeeHash, now);
      emit("reconcile", `Delivered ${fmt(p.amountMinor, p.currency)} to ${p.payeeName}`, { payout: p.id }, t.id);
      this.d.onFinal?.(this.book.get(p.id)!);
    } else if ((t.status === "FAILED" || t.status === "CANCELLED") && (p.status === "submitted" || p.status === "paid")) {
      // A bank can return a payout after Airwallex reported it PAID, so a late failure refunds too.
      // Keep the fee in the op's detail: Airwallex returns the payout on a bounce but keeps its fee.
      const fee = this.d.store.latestOp(p.id, "pay")?.detail;
      const feeMinor = fee?.startsWith("{") ? (JSON.parse(fee) as { fee_minor?: number }).fee_minor ?? 0 : 0;
      this.d.store.updateOp(p.id, "failed", null, JSON.stringify({ fee_minor: feeMinor, failure: transferFailure(t) }));
      await this.fail(p, `bank returned it: ${transferFailure(t)}`, ["submitted", "paid"]);
    }
    return this.book.get(p.id);
  }

  /**
   * The owner judged an agent's delivered payout wrong (the agent disputed it): refund the agent
   * in full under the refund mandate, as Kit 11's support agent does. The fiat already left, so
   * Sayso carries that loss; the refund's payment id makes a retry pay at most once.
   */
  async dispute(id: string, operator: string, reason: string): Promise<Payout> {
    const p = this.book.get(id);
    if (!p) throw new PayoutError(404, "no such payout");
    if (p.status !== "paid") throw new PayoutError(409, `only a delivered payout can be disputed; this one is ${p.status}`);
    if (!p.buyer || p.buyer.startsWith("internal:")) throw new PayoutError(409, "only an agent's payout can be refunded; your own invoices were paid from your balance");
    emit("decide", `${operator} upheld a dispute on ${p.payeeName}'s payout: ${reason}`, { payout: id });
    this.d.trail?.add(id, "decide", `Disputed, and upheld by ${operator}: ${reason}`);
    return this.fail(p, `disputed: ${reason}`, ["paid"]);
  }

  /** Poll in-flight payouts (webhooks do this in production). */
  async follow(now = new Date()): Promise<void> {
    for (const p of this.book.list(500).filter((x) => x.status === "submitted")) {
      const t = await this.d.awx.transferByRequestId(p.id).catch(() => undefined);
      if (t) await this.onTransfer(t, now);
    }
  }

  private async fail(p: Payout, reason: string, from: Payout["status"][] = ["funded"]): Promise<Payout> {
    if (!this.book.transition(p.id, from, "failed", { failure: reason })) return this.book.get(p.id)!;
    emit("refuse", `Payout ${p.id.slice(0, 8)} failed: ${reason}`, { payout: p.id });
    const buyer = this.book.get(p.id)!.buyer;
    if (buyer?.startsWith("internal:")) {
      emit("escalate", `Your invoice payout ${p.id.slice(0, 8)} to ${p.payeeName} failed: ${reason}. The money is still in your Airwallex balance.`, { payout: p.id });
      return this.book.get(p.id)!;
    }
    if (!buyer) {
      this.book.transition(p.id, ["failed"], "refund_failed", { failure: `${reason}; no payer to refund` });
      emit("escalate", `Payout ${p.id.slice(0, 8)} failed with no known payer to refund`, { payout: p.id });
      return this.book.get(p.id)!;
    }
    try {
      const { tx } = await this.d.refunder.refund(buyer, p.totalMinor, p.id);
      this.book.transition(p.id, ["failed"], "refunded", { refundTx: tx });
      emit("act", `Refunded ${toMajor(p.totalMinor).toFixed(2)} USDZ to ${short(buyer)} in full`, { payout: p.id }, tx);
      this.d.onFinal?.(this.book.get(p.id)!);
    } catch (err) {
      this.book.transition(p.id, ["failed"], "refund_failed", { failure: `${reason}; refund failed: ${String(err).slice(0, 200)}` });
      emit("escalate", `Refund for ${p.id.slice(0, 8)} failed; a person must return ${toMajor(p.totalMinor).toFixed(2)} USDZ to ${short(buyer)}`, { payout: p.id });
    }
    return this.book.get(p.id)!;
  }
}

function nameParts(name: string) {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first_name: first, last_name: rest.join(" ") || first };
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** What the API returns for a payout. Never the bank details. */
/** An agent's quote decided "wait for funds" can't be paid: there is nothing to pay with yet. (The inbox's own invoices wait for the float instead.) */
export const waitsForFunds = (p: Payout) => p.decision?.verdict === "wait" && p.decision.decidedBy === "balance";
export const WAITS_FOR_FUNDS = "this quote waits for funds: ask for a new one after the agent's next top-up";

export function publicView(p: Payout) {
  return {
    // A quote nobody paid in time reads as expired, even before anything marks it so.
    id: p.id, status: p.status === "quoted" && new Date(p.expiresAt) < new Date() ? "expired" : p.status, reasons: p.reasons, amount: toMajor(p.amountMinor).toFixed(2), currency: p.currency, method: p.method,
    payee: p.payeeName, reference: p.reference,
    price_usdz: toMajor(p.totalMinor).toFixed(2), fee_usdz: toMajor(p.feeMinor).toFixed(2), rate_used: p.rateUsed,
    decision: p.decision ? decisionView(p.decision) : null,
    created_at: p.createdAt, source: p.buyer?.startsWith("internal:") ? "inbox" : p.buyer ? "agent" : null,
    expires_at: p.expiresAt, funding_tx: p.fundingTx, airwallex_transfer_id: p.transferId, refund_tx: p.refundTx, failure: p.failure,
  };
}

/** A decision as the API shows it: major units, and no sentinel for "no limit given". */
export function decisionView(d: Decision) {
  const usdzOrNull = (m: number) => (m >= Number.MAX_SAFE_INTEGER ? null : toMajor(m).toFixed(2));
  return {
    verdict: d.verdict, decided_by: d.decidedBy, reason: d.reason,
    inputs: {
      price_usdz: toMajor(d.inputs.costUsdzMinor).toFixed(2), cap_usdz: usdzOrNull(d.inputs.capUsdzMinor), rate_drift_pct: Number((d.inputs.rateDrift * 100).toFixed(2)),
      spendable_usdz: usdzOrNull(d.inputs.spendableUsdzMinor), risk: d.inputs.risk, due_in_days: Math.round(d.inputs.dueInDays), part_payment: d.inputs.partPaymentAllowed,
    },
    tranches: d.tranches?.map((t) => ({ amount: toMajor(t.amountMinor).toFixed(2), price_usdz: toMajor(t.costUsdzMinor).toFixed(2), when: t.when })),
    until: d.until && { rate_within_pct: d.until.rateWithinPct === undefined ? undefined : d.until.rateWithinPct * 100, funds_usdz: d.until.fundsUsdzMinor === undefined ? undefined : toMajor(d.until.fundsUsdzMinor).toFixed(2), by: d.until.by },
    proposed_cap_usdz: d.proposedCapUsdzMinor === undefined ? undefined : toMajor(d.proposedCapUsdzMinor).toFixed(2),
  };
}
