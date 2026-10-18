// The agent's own Airwallex card: it pays its compute bills (model API, hosting) and nothing else.
// Airwallex enforces the hard limits at authorization (currencies, merchant categories, per-txn
// and monthly caps). Our code reviews every approved card transaction as a second line: anything
// outside the expected merchants or above the forecast freezes the card and escalates.
// Payloads follow the Airwallex Issuing API reference (cardholders/create, cards/create,
// simulation/issuing/create).

import type { Airwallex, SimulatedCardTransaction } from "./client.js";
import { emit } from "../events.js";
import type { Store } from "../store.js";
import { toMajor, toMinor } from "../treasury/money.js";

export interface CardPolicy {
  currency: string;
  perTransactionMinor: number;
  monthlyMinor: number;
  /** Merchant category codes the card may be used at, e.g. 5734 (software), 7372 (computer services). */
  allowedMcc: string[];
  /** Merchant names we expect bills from; anything else triggers a freeze on review. */
  expectedMerchants: RegExp[];
}

export const DEFAULT_CARD_POLICY: CardPolicy = {
  currency: "USD",
  perTransactionMinor: toMinor(200),
  monthlyMinor: toMinor(600),
  allowedMcc: ["5734", "7372", "4816"],
  expectedMerchants: [/anthropic/i, /vercel/i, /render/i, /fly\.io/i, /cloudflare/i],
};

const AGENT_ADDRESS = { city: "San Francisco", country: "US", line1: "1 Market Street", postcode: "94105", state: "CA" };

/** A DELEGATE cardholder: someone acting for the business, here the agent's operator. */
export function cardholderPayload(email: string) {
  return {
    type: "DELEGATE",
    email,
    individual: { name: { first_name: "Sayso", last_name: "Agent" }, date_of_birth: "1990-01-01", address: AGENT_ADDRESS, express_consent_obtained: "yes" },
    postal_address: AGENT_ADDRESS,
  };
}

/** A non-personalised virtual business card, so the business name is on it and it is not anyone's own card. */
export function cardPayload(requestId: string, cardholderId: string, p: CardPolicy, createdBy: string) {
  return {
    request_id: requestId,
    cardholder_id: cardholderId,
    created_by: createdBy,
    form_factor: "VIRTUAL",
    is_personalized: false,
    nick_name: "Sayso compute",
    program: { purpose: "COMMERCIAL" },
    authorization_controls: {
      allowed_currencies: [p.currency],
      allowed_merchant_categories: p.allowedMcc,
      allowed_transaction_count: "MULTIPLE",
      transaction_limits: {
        currency: p.currency,
        limits: [
          { amount: toMajor(p.perTransactionMinor), interval: "PER_TRANSACTION" },
          { amount: toMajor(p.monthlyMinor), interval: "MONTHLY" },
        ],
      },
    },
  };
}

export interface CardTransaction {
  id: string;
  card_id: string;
  amountMinor: number;
  currency: string;
  merchantName: string;
  mcc: string;
  status: string;
}

export type CardReview = { verdict: "ok" } | { verdict: "freeze"; reason: string };

/** Second line of defence after Airwallex's own controls. Pure: no I/O, no model. */
export function reviewCardTransaction(t: CardTransaction, p: CardPolicy, spentThisMonthMinor: number): CardReview {
  if (t.currency !== p.currency) return { verdict: "freeze", reason: `unexpected currency ${t.currency}` };
  if (!p.allowedMcc.includes(t.mcc)) return { verdict: "freeze", reason: `merchant category ${t.mcc} not allowed` };
  if (!p.expectedMerchants.some((re) => re.test(t.merchantName))) return { verdict: "freeze", reason: `unknown merchant ${t.merchantName}` };
  if (t.amountMinor > p.perTransactionMinor) return { verdict: "freeze", reason: "above per-transaction limit" };
  if (spentThisMonthMinor + t.amountMinor > p.monthlyMinor) return { verdict: "freeze", reason: "monthly limit would be exceeded" };
  return { verdict: "ok" };
}

export const fromSimulation = (s: SimulatedCardTransaction, merchantName: string, mcc: string): CardTransaction => ({
  id: s.card_transaction_id, card_id: s.card_id, amountMinor: toMinor(s.transaction_amount), currency: s.transaction_currency,
  merchantName: s.merchant?.name ?? merchantName, mcc: s.merchant?.category_code ?? mcc, status: s.process_result,
});

export type CardPort = Pick<Airwallex, "createCardholder" | "createCard" | "updateCard" | "simulateCardAuth">;

export class AgentCard {
  constructor(private readonly awx: CardPort, private readonly store: Store, readonly policy: CardPolicy = DEFAULT_CARD_POLICY, public cardId?: string) {}

  async issue(email: string, createdBy: string): Promise<string> {
    const { cardholder_id } = await this.awx.createCardholder(cardholderPayload(email));
    const { card_id } = await this.awx.createCard(cardPayload(crypto.randomUUID(), cardholder_id, this.policy, createdBy));
    this.cardId = card_id;
    emit("act", "Issued the agent's compute card", { per_txn: toMajor(this.policy.perTransactionMinor), monthly: toMajor(this.policy.monthlyMinor), mcc: this.policy.allowedMcc }, card_id);
    return card_id;
  }

  /** Sandbox only: a merchant charges the card, and the result goes through the same review as a real one. */
  async simulateBill(merchantName: string, mcc: string, amountMinor: number, now = new Date()): Promise<CardReview | { verdict: "declined"; reason: string }> {
    if (!this.cardId) throw new Error("issue the card first");
    const s = await this.awx.simulateCardAuth({
      card_id: this.cardId, transaction_amount: toMajor(amountMinor), transaction_currency: this.policy.currency,
      merchant_info: merchantName, merchant_category_code: mcc, single_phase: true,
    });
    if (s.process_result !== "APPROVED") {
      const reason = s.failure_reason ?? s.process_result;
      emit("refuse", `Airwallex declined ${merchantName} ${toMajor(amountMinor).toFixed(2)} ${this.policy.currency} on the agent card: ${reason}`, { mcc }, s.card_transaction_id);
      return { verdict: "declined", reason };
    }
    return this.onTransaction(fromSimulation(s, merchantName, mcc), now);
  }

  spentThisMonthMinor(now = new Date()): number {
    const month = now.toISOString().slice(0, 7);
    return this.store.ops().filter((o) => o.kind === "card_spend" && o.status === "settled" && (o.detail ?? "").startsWith(month)).reduce((s, o) => s + o.amountMinor, 0);
  }

  /**
   * Called for each approved card transaction. Records the spend once (the money has left either
   * way, so reconciliation counts it); a transaction that fails review also freezes the card.
   */
  async onTransaction(t: CardTransaction, now = new Date()): Promise<CardReview> {
    const review = reviewCardTransaction(t, this.policy, this.spentThisMonthMinor(now));
    if (!this.store.latestOp(t.id, "card_spend")) {
      this.store.insertOp({ requestId: t.id, obligationId: t.id, kind: "card_spend", attempt: 1, status: "settled", currency: t.currency, amountMinor: t.amountMinor, detail: `${now.toISOString()} ${t.merchantName}${review.verdict === "ok" ? "" : " (froze card)"}` });
    }
    if (review.verdict === "ok") {
      emit("act", `Card paid ${t.merchantName} ${toMajor(t.amountMinor).toFixed(2)} ${t.currency}`, { mcc: t.mcc }, t.id);
    } else {
      await this.awx.updateCard(t.card_id, { card_status: "INACTIVE" });
      emit("refuse", `Froze the agent card: ${review.reason}`, { merchant: t.merchantName, amount: toMajor(t.amountMinor) }, t.id);
    }
    return review;
  }
}
