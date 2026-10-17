// Coin Slot's product: any agent holding USDZ asks Coin Slot to pay a real-world invoice, and
// Coin Slot pays it in local currency through Airwallex.
//
// The order of operations is the safety argument:
//   1. quote   — price it, read the invoice, run risk, have Airwallex validate the payee. Free.
//   2. accept  — the buyer's x402 payment is verified; the quote is locked (single use).
//   3. funded  — the payment SETTLED on Metal. Only now does any fiat move.
//   4. execute — top up the currency float (convert only the shortfall), pay via Airwallex,
//                idempotent on the payout id as request_id.
//   5. settle  — PAID closes it; CANCELLED refunds the buyer in full under a Metal refund mandate.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AirwallexError, type Airwallex, type Transfer } from "../airwallex/client.js";
import { readAuto, type Findings } from "../agent/reader.js";
import { emit } from "../events.js";
import type { Store } from "../store.js";
import { fmt, toMajor, toMinor } from "../treasury/money.js";
import { PayoutBook, payeeHash, type Payout } from "./book.js";
import { DEFAULT_PRICING, price, type PricingConfig } from "./pricing.js";
import { assess, DEFAULT_RISK, type RiskConfig } from "./risk.js";

export type PayoutAirwallex = Pick<Airwallex, "fxRate" | "fxConvert" | "createTransfer" | "transferByRequestId" | "validateBeneficiary" | "createBeneficiary" | "currentBalances">;

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
    address: z.object({ country_code: z.string().length(2), city: z.string(), street_address: z.string(), postcode: z.string() }),
    /** Airwallex bank_details fields for the destination, e.g. { iban } or { account_number, account_routing_type1, account_routing_value1 }. */
    bank: z.record(z.string(), z.string()).refine((b) => Object.keys(b).length > 0, "bank details required"),
    bank_country_code: z.string().length(2),
  }),
  reference: z.string().min(1).max(35),
  /** The invoice or email that asked for this payment. Read before paying; it can only make Coin Slot more careful. */
  invoice_text: z.string().max(20_000).optional(),
  /** The buyer's Metal address, if it wants limits checked at quote time. The settled payer is what counts. */
  buyer: z.string().optional(),
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
}

const HOUR = 3_600_000;
const isAmbiguous = (err: unknown) => !(err instanceof AirwallexError) || err.status >= 500 || err.status === 408 || err.status === 429;

export class PayoutService {
  readonly book: PayoutBook;
  private readonly pricing: PricingConfig;
  private readonly risk: RiskConfig;
  private readonly ttl: number;
  private readonly read: (text: string) => Promise<Findings>;

  constructor(private readonly d: PayoutDeps) {
    this.book = new PayoutBook(d.store);
    this.pricing = d.pricing ?? DEFAULT_PRICING;
    this.risk = d.risk ?? DEFAULT_RISK;
    this.ttl = d.quoteTtlMs ?? 120_000;
    this.read = d.read ?? readAuto;
  }

  // ---------- 1. quote ----------

  async quote(input: unknown, now = new Date()): Promise<Payout> {
    const parsed = PayoutRequest.safeParse(input);
    if (!parsed.success) throw new PayoutError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const r = parsed.data;
    const amountMinor = toMinor(Number(r.amount));
    const rate = r.currency === "USD" ? 1 : (await this.d.awx.fxRate("USD", r.currency)).rate;
    const pr = price(amountMinor, r.currency, r.method, rate, this.pricing);
    const bank = { account_currency: r.currency, bank_country_code: r.payee.bank_country_code, account_name: r.payee.name, ...r.payee.bank };
    const hash = payeeHash(bank);
    const findings = r.invoice_text ? await this.read(r.invoice_text) : undefined;

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
    let status: Payout["status"] = verdict.verdict === "reject" ? "rejected" : verdict.verdict === "hold" ? "needs_review" : "quoted";

    // Airwallex checks the bank details before anyone pays for anything.
    if (status !== "rejected") {
      try {
        await this.d.awx.validateBeneficiary(beneficiary, [r.method]);
      } catch (err) {
        if (err instanceof AirwallexError && err.status < 500) {
          status = "rejected";
          reasons.push(`Airwallex rejected the bank details: ${err.code ?? err.status}`);
        } else throw err;
      }
    }

    const p: Payout = {
      id: randomUUID(), buyer: r.buyer ?? null, currency: r.currency, amountMinor, method: r.method,
      bankCountry: r.payee.bank_country_code, payeeName: r.payee.name, payeeHash: hash, beneficiary, reference: r.reference,
      costMinor: pr.costMinor, feeMinor: pr.feeMinor, totalMinor: pr.totalMinor, rateUsed: pr.rateUsed,
      status, reasons, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (status === "needs_review" ? 24 * HOUR : this.ttl)).toISOString(),
      fundingTx: null, transferId: null, refundTx: null, failure: null,
    };
    this.book.insert(p);
    const label = `${fmt(amountMinor, r.currency)} to ${r.payee.name}`;
    if (status === "quoted") emit("decide", `Quoted ${label}: ${toMajor(pr.totalMinor).toFixed(2)} USDZ (fee ${toMajor(pr.feeMinor).toFixed(2)})`, { payout: p.id });
    else if (status === "needs_review") emit("escalate", `Held ${label} for review: ${reasons.join("; ")}`, { payout: p.id, citations: findings?.citations });
    else emit("refuse", `Refused ${label}: ${reasons.join("; ")}`, { payout: p.id });
    return p;
  }

  /** The operator looked at a held payout and is happy to quote it. */
  approveReview(id: string, operator: string, now = new Date()): Payout {
    if (!this.book.transition(id, ["needs_review"], "quoted", { expiresAt: new Date(now.getTime() + this.ttl).toISOString() })) throw new PayoutError(409, "not awaiting review");
    emit("decide", `${operator} cleared payout ${id.slice(0, 8)} after review`);
    return this.book.get(id)!;
  }

  rejectReview(id: string, operator: string): Payout {
    if (!this.book.transition(id, ["needs_review"], "rejected")) throw new PayoutError(409, "not awaiting review");
    emit("refuse", `${operator} rejected payout ${id.slice(0, 8)} after review`);
    return this.book.get(id)!;
  }

  /** The x402 price of a quote, in USDZ major units. Undefined for anything not payable. */
  priceOf(id: string, now = new Date()): string | undefined {
    const p = this.book.get(id);
    if (!p || p.status !== "quoted" || new Date(p.expiresAt) < now) return undefined;
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
    if (this.book.transition(id, ["accepted"], "quoted")) emit("observe", `Payment for ${id.slice(0, 8)} did not settle; quote released`);
  }

  // ---------- 3–4. funded, then execute ----------

  async onFunded(id: string, payer: string, fundingTx: string, now = new Date()): Promise<Payout> {
    if (!this.book.transition(id, ["accepted"], "funded", { buyer: payer, fundingTx })) return this.book.get(id)!;
    const p = this.book.get(id)!;
    emit("observe", `Received ${toMajor(p.totalMinor).toFixed(2)} USDZ from ${short(payer)} for payout ${id.slice(0, 8)}`, {}, fundingTx);

    // Limits are re-checked against the payer who actually settled, not the one the request claimed.
    const limits = assess({
      usdValueMinor: p.costMinor, bankCountry: p.bankCountry, payeeSeenBefore: true,
      buyerSpentTodayMinor: this.book.buyerSpentSince(payer, new Date(now.getTime() - 24 * HOUR)) - p.costMinor,
      buyerPayoutsLastHour: 0,
    }, this.risk);
    if (limits.verdict === "reject") return this.fail(p, limits.reasons.join("; "));

    try {
      await this.ensureFloat(p);
    } catch (err) {
      return this.fail(p, `could not fund ${p.currency}: ${String(err instanceof Error ? err.message : err)}`);
    }

    let beneficiaryId = this.book.payee(p.payeeHash)?.beneficiaryId;
    if (!beneficiaryId) {
      try {
        beneficiaryId = (await this.d.awx.createBeneficiary({ beneficiary: p.beneficiary, transfer_methods: [p.method], nickname: p.payeeName.slice(0, 50) })).beneficiary_id;
        this.book.savePayee(p.payeeHash, beneficiaryId);
      } catch (err) {
        return this.fail(p, `Airwallex would not create the beneficiary: ${String(err).slice(0, 200)}`);
      }
    }
    return this.submit(p, beneficiaryId);
  }

  private async ensureFloat(p: Payout): Promise<void> {
    const need = p.amountMinor + (p.method === "SWIFT" ? (this.pricing.swiftFeeMinor[p.currency] ?? 0) : 0);
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

  private async submit(p: Payout, beneficiaryId: string): Promise<Payout> {
    const body = {
      request_id: p.id, beneficiary_id: beneficiaryId, transfer_amount: toMajor(p.amountMinor).toFixed(2), transfer_currency: p.currency,
      transfer_method: p.method, reference: p.reference, source_currency: p.currency,
    };
    const fee = p.method === "SWIFT" ? (this.pricing.swiftFeeMinor[p.currency] ?? 0) : 0;
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
        emit("escalate", `Payout ${p.id.slice(0, 8)} outcome unknown after one retry; held for a person, buyer not refunded yet`);
        return this.book.get(p.id)!;
      }
    }
    this.d.store.updateOp(p.id, "submitted", t.id);
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
    } else if (t.status === "CANCELLED" && p.status === "submitted") {
      this.d.store.updateOp(p.id, "failed", null, `${t.failure_type ?? ""} ${t.failure_reason ?? ""}`.trim());
      await this.fail(p, `bank returned it: ${t.failure_type ?? "unknown"}`, ["submitted"]);
    }
    return this.book.get(p.id);
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
    emit("refuse", `Payout ${p.id.slice(0, 8)} failed: ${reason}`);
    const buyer = this.book.get(p.id)!.buyer;
    if (!buyer) {
      this.book.transition(p.id, ["failed"], "refund_failed", { failure: `${reason}; no payer to refund` });
      emit("escalate", `Payout ${p.id.slice(0, 8)} failed with no known payer to refund`);
      return this.book.get(p.id)!;
    }
    try {
      const { tx } = await this.d.refunder.refund(buyer, p.totalMinor, p.id);
      this.book.transition(p.id, ["failed"], "refunded", { refundTx: tx });
      emit("act", `Refunded ${toMajor(p.totalMinor).toFixed(2)} USDZ to ${short(buyer)} in full`, { payout: p.id }, tx);
    } catch (err) {
      this.book.transition(p.id, ["failed"], "refund_failed", { failure: `${reason}; refund failed: ${String(err).slice(0, 200)}` });
      emit("escalate", `Refund for ${p.id.slice(0, 8)} failed; a person must return ${toMajor(p.totalMinor).toFixed(2)} USDZ to ${short(buyer)}`);
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
export function publicView(p: Payout) {
  return {
    id: p.id, status: p.status, reasons: p.reasons, amount: toMajor(p.amountMinor).toFixed(2), currency: p.currency, method: p.method,
    payee: p.payeeName, reference: p.reference,
    price_usdz: toMajor(p.totalMinor).toFixed(2), fee_usdz: toMajor(p.feeMinor).toFixed(2), rate_used: p.rateUsed,
    expires_at: p.expiresAt, funding_tx: p.fundingTx, airwallex_transfer_id: p.transferId, refund_tx: p.refundTx, failure: p.failure,
  };
}
