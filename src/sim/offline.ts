// Offline stand-ins for Airwallex and Metal, so the whole loop and dashboard run with no keys
// and no network. They follow the same rules as the real services where those rules matter
// to our code (request_id dedupe, a required transfer reason, FAILED as the failure state, mandate payee checks), and
// every proof they return starts with "sim:" so nothing here can be mistaken for a live result.

import { randomUUID } from "node:crypto";
import { AirwallexError, type AccountVerification, type Transfer } from "../airwallex/client.js";
import type { LoopAirwallex } from "../agent/loop.js";
import type { MetalSettlementVerifier } from "../bridge/ramp.js";
import { emit } from "../events.js";
import type { EarningsSource } from "../metal/earnings.js";
import type { PullResult } from "../metal/mandate.js";
import type { RampLedger } from "../bridge/ledger.js";
import { toMajor, toMinor } from "../treasury/money.js";

const SPREAD = 0.003;
const SWIFT_FEE: Record<string, number> = { EUR: 1285 };

export class FakeAirwallex implements LoopAirwallex {
  readonly balances: Record<string, number>;
  private readonly transfers = new Map<string, Transfer & { method: string; lookups: number; beneficiary_id: string; refunded?: boolean }>();
  readonly frozenCards = new Set<string>();

  constructor(openingMinor: Record<string, number>, readonly midRates: Record<string, number> = { EUR: 0.92, GBP: 0.79 }) {
    this.balances = { ...openingMinor };
  }

  private add(ccy: string, minor: number) {
    this.balances[ccy] = (this.balances[ccy] ?? 0) + minor;
  }

  currentBalances = async () => Object.entries(this.balances).map(([currency, m]) => ({ currency, available_amount: toMajor(m), total_amount: toMajor(m) }));

  fxRate = async (sell: string, buy: string) => {
    if (sell !== "USD") throw new Error("sim quotes USD only");
    return { rate: this.midRates[buy]! };
  };

  fxConvert = async (b: { request_id: string; sell_currency: string; buy_currency: string; buy_amount: string }) => {
    const buyMinor = toMinor(Number(b.buy_amount));
    const sellMinor = Math.ceil(buyMinor / (this.midRates[b.buy_currency]! * (1 - SPREAD)));
    if ((this.balances[b.sell_currency] ?? 0) < sellMinor) throw new AirwallexError(400, "insufficient_fund", {}, "/fx/conversions/create");
    this.add(b.sell_currency, -sellMinor);
    this.add(b.buy_currency, buyMinor);
    return { id: `sim:conv_${b.request_id.slice(0, 8)}`, status: "SETTLED", sell_amount: toMajor(sellMinor), buy_amount: toMajor(buyMinor) };
  };

  createTransfer = async (b: { request_id: string; beneficiary_id: string; transfer_amount: string; transfer_currency: string; transfer_method: "LOCAL" | "SWIFT"; reason?: string }) => {
    if (!b.reason) throw new AirwallexError(400, "validation_failed", { message: "reason is required" }, "/transfers/create");
    const existing = this.transfers.get(b.request_id);
    if (existing) return existing; // same request_id, same transfer
    const amountMinor = toMinor(Number(b.transfer_amount));
    const fee = b.transfer_method === "SWIFT" ? (SWIFT_FEE[b.transfer_currency] ?? 0) : 0;
    this.add(b.transfer_currency, -(amountMinor + fee));
    const t = { id: `sim:tfr_${this.transfers.size + 1}`, request_id: b.request_id, status: "PROCESSING", transfer_amount: toMajor(amountMinor), transfer_currency: b.transfer_currency, method: b.transfer_method, lookups: 0, beneficiary_id: b.beneficiary_id };
    this.transfers.set(b.request_id, t);
    return t;
  };

  /** Each lookup moves a transfer one step along PROCESSING -> SENT -> PAID. */
  transferByRequestId = async (requestId: string) => {
    const t = this.transfers.get(requestId);
    if (!t) return undefined;
    t.lookups += 1;
    const ben = JSON.stringify(this.beneficiaries.get(t.beneficiary_id) ?? "");
    const fails = ben.includes(this.failMarker);
    t.status = t.lookups === 1 ? "SENT" : fails ? "FAILED" : "PAID";
    if (fails && t.lookups > 1 && !t.refunded) {
      t.refunded = true;
      this.add(t.transfer_currency, toMinor(t.transfer_amount)); // the bank returns the money
      t.failure_type = "ACCOUNT_CLOSED";
    }
    return t;
  };

  readonly beneficiaries = new Map<string, unknown>();
  /** Fails a payout to an account whose details contain this marker, like a closed account would. */
  failMarker = "CLOSED";

  validateBeneficiary = async (beneficiary: unknown) => {
    const bank = (beneficiary as { bank_details?: Record<string, string> }).bank_details ?? {};
    const iban = bank.iban?.replace(/\s+/g, "");
    if (iban !== undefined && !/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw new AirwallexError(400, "invalid_iban", { field: "iban" }, "/beneficiaries/validate");
    if (iban === undefined && !bank.account_number) throw new AirwallexError(400, "missing_account", {}, "/beneficiaries/validate");
    return {};
  };

  /** Who each account really belongs to, as the payee's bank would say in a VoP/CoP check. */
  readonly accountHolders = new Map<string, string>([["DE44500105175407324931", "Mark Lehmann"]]);

  verifyAccount = async (b: { bank_details: Record<string, string> }): Promise<AccountVerification> => {
    const iban = b.bank_details.iban?.replace(/\s+/g, "");
    const holder = iban ? this.accountHolders.get(iban) : undefined;
    if (!holder) return { code: "VERIFIED", details: { account_name_match_result: "FULL_MATCH", resolved_account_name: b.bank_details.account_name } };
    const same = holder.toLowerCase() === (b.bank_details.account_name ?? "").toLowerCase();
    return { code: "VERIFIED", details: { account_name_match_result: same ? "FULL_MATCH" : "NOT_MATCHED", resolved_account_name: holder } };
  };

  createBeneficiary = async (body: unknown) => {
    const id = `sim:ben_${this.beneficiaries.size + 1}`;
    this.beneficiaries.set(id, body);
    return { beneficiary_id: id };
  };

  simulateDeposit = async (_globalAccountId: string, amount: number) => {
    this.add("USD", toMinor(amount));
    return { id: `sim:dep_${randomUUID().slice(0, 8)}`, status: "SETTLED" };
  };

  createCardholder = async () => ({ cardholder_id: "sim:ch_1" });
  createCard = async () => ({ card_id: "sim:card_1" });
  updateCard = async (cardId: string, body: { card_status: string }) => {
    if (body.card_status !== "ACTIVE") this.frozenCards.add(cardId);
    return {};
  };
  simulateCardAuth = async (body: unknown) => {
    const b = body as { card_id: string; transaction_amount: number; transaction_currency: string };
    if (this.frozenCards.has(b.card_id)) throw new Error("card is frozen");
    this.add(b.transaction_currency, -toMinor(b.transaction_amount));
    return { transaction_id: `sim:itx_${randomUUID().slice(0, 8)}` };
  };
}

/** Per-call earnings, simulated (used by the treasury tests). */
export class FakeSwarm implements EarningsSource {
  paidCalls = 0;
  private unsweptMinor = 0;

  constructor(private readonly ledger: RampLedger, private readonly priceMinor = 1) {}

  async run(agents: number, callsPerAgent: number, onProgress?: () => void): Promise<void> {
    for (let n = 0; n < callsPerAgent; n++) {
      this.paidCalls += agents;
      this.unsweptMinor += agents * this.priceMinor;
      if ((n + 1) % Math.max(1, Math.floor(callsPerAgent / 10)) === 0) {
        emit("observe", `${this.paidCalls} paid calls from ${agents} buyer agents (x402, sim)`, { paidCalls: this.paidCalls, earnedMinor: this.paidCalls * this.priceMinor });
        onProgress?.();
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  async pending() {
    if (this.unsweptMinor <= 0) return undefined;
    const amountMinor = this.unsweptMinor;
    this.unsweptMinor = 0;
    return { epoch: `epoch-${this.ledger.all().length + 1}`, amountMinor };
  }
}

/** The mandate's on-chain checks, simulated: it pays the ramp and refuses anyone else. */
export class FakeMandate implements MetalSettlementVerifier {
  constructor(readonly rampAddress: string, private readonly capMinor: number) {}

  async verify(epoch: string, amountMinor: number) {
    if (amountMinor > this.capMinor) throw new Error("mandate refused the sweep: ExceedsCap");
    const tx = `sim:0x${randomUUID().replaceAll("-", "")}`;
    emit("act", `Swept ${(amountMinor / 100).toFixed(2)} USDZ to the ramp under the mandate (sim)`, { epoch }, tx);
    emit("reconcile", `Sweep for ${epoch} is final (sim)`, {}, tx);
    return { eventKey: `63825:${tx}:0` };
  }

  async attemptAndRecordRefusal(to: string, amountCents: number): Promise<PullResult> {
    const tx = `sim:0x${randomUUID().replaceAll("-", "")}` as `0x${string}`;
    if (to.toLowerCase() === this.rampAddress.toLowerCase()) return { outcome: "paid", tx };
    const reason = amountCents > this.capMinor ? "ExceedsCap" : "PayeeNotAllowed";
    emit("refuse", `Metal refused a payout to ${to}: ${reason} (sim)`, { recorded: true }, tx);
    return { outcome: "refused", tx, reason };
  }
}

/** Refunds, simulated: what a Metal refund mandate (per-refund cap, total budget) would allow. */
export class FakeRefunder {
  readonly refunds: Array<{ to: string; amountMinor: number; payoutId: string }> = [];
  constructor(private readonly capMinor = 250_000, private budgetMinor = 1_000_000) {}

  async refund(to: string, amountMinor: number, payoutId: string) {
    if (amountMinor > this.capMinor) throw new Error("refund mandate refused: ExceedsCap");
    if (amountMinor > this.budgetMinor) throw new Error("refund mandate refused: ExceedsBudget");
    this.budgetMinor -= amountMinor;
    this.refunds.push({ to, amountMinor, payoutId });
    return { tx: `sim:0x${randomUUID().replaceAll("-", "")}` };
  }
}
