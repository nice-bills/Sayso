// Whether Sayso will pay a request, decided in code before any money moves. Pure.
// "hold" means a person (the operator) must look first; "reject" means never.
// The invoice reader's findings can only tighten this: a request whose invoice asks to pay
// new bank details, or pushes urgency, is held, whatever the buying agent says.

import type { Findings } from "../agent/reader.js";

export interface RiskConfig {
  perPayoutCapMinor: number;
  perBuyerDailyCapMinor: number;
  /**
   * When the owner already approves each payment (their own inbox), a first payout to an account Sayso
   * has never paid is held only above this. An agent's first payout to a new account is always held:
   * an injected invoice must not be able to send any amount to fresh bank details with no human.
   */
  newPayeeReviewAboveMinor: number;
  maxPayoutsPerBuyerPerHour: number;
  blockedCountries: string[];
  /**
   * "agents" (the default): an agent's first payout to an account Sayso has never paid waits for the owner,
   * whatever the amount. "large": only above newPayeeReviewAboveMinor, the older, laxer rule.
   */
  newPayeeHold: "agents" | "large";
}

export const DEFAULT_RISK: RiskConfig = {
  perPayoutCapMinor: 200_000,
  perBuyerDailyCapMinor: 500_000,
  newPayeeReviewAboveMinor: 50_000,
  maxPayoutsPerBuyerPerHour: 10,
  // Illustrative only; production uses a maintained sanctions screen.
  blockedCountries: ["KP", "IR", "SY", "CU"],
  newPayeeHold: "agents",
};

/** DEFAULT_RISK, with SAYSO_NEW_PAYEE_HOLD=large to loosen the new-payee rule (the unit tests' fixture). */
export function riskFromEnv(raw = process.env.SAYSO_NEW_PAYEE_HOLD): RiskConfig {
  return { ...DEFAULT_RISK, newPayeeHold: raw === "large" ? "large" : "agents" };
}

export interface RiskInput {
  usdValueMinor: number;
  bankCountry: string;
  payeeSeenBefore: boolean;
  /** The owner approves this payment themselves (an invoice in their inbox), not an agent on its own. */
  ownerApprovesEach?: boolean;
  buyerSpentTodayMinor: number;
  buyerPayoutsLastHour: number;
  invoice?: Findings;
}

export type RiskVerdict = { verdict: "allow" } | { verdict: "hold"; reasons: string[] } | { verdict: "reject"; reasons: string[] };

export function assess(i: RiskInput, cfg: RiskConfig = DEFAULT_RISK): RiskVerdict {
  const reject: string[] = [];
  const hold: string[] = [];
  if (cfg.blockedCountries.includes(i.bankCountry.toUpperCase())) reject.push(`bank country ${i.bankCountry} is blocked`);
  if (i.usdValueMinor > cfg.perPayoutCapMinor) reject.push("above the per-payout cap");
  if (i.buyerSpentTodayMinor + i.usdValueMinor > cfg.perBuyerDailyCapMinor) reject.push("above this buyer's daily cap");
  if (reject.length) return { verdict: "reject", reasons: reject };

  if (i.buyerPayoutsLastHour >= cfg.maxPayoutsPerBuyerPerHour) hold.push("unusual payout velocity for this buyer");
  if (!i.payeeSeenBefore && !i.ownerApprovesEach && cfg.newPayeeHold === "agents") hold.push("an agent's first payout to an account Sayso has never paid");
  else if (!i.payeeSeenBefore && i.usdValueMinor > cfg.newPayeeReviewAboveMinor) hold.push("large first payout to a new account");
  if (i.invoice?.requestsNewBankDetails || i.invoice?.kind === "bank_details_change") hold.push("invoice asks to pay new bank details");
  if (i.invoice?.pressureTactics) hold.push("invoice uses pressure tactics");
  return hold.length ? { verdict: "hold", reasons: hold } : { verdict: "allow" };
}
