// What the agent does with a payout: pay, wait, split or hold, decided in code from price,
// balance and risk, with the deadline as tie-breaker. Pure. The model never sets a number here;
// it can only add risk findings, which reach this function through assess().
//
// Rules, first match wins:
//   1. risk reject                -> reject (nothing has been paid, so nothing moves)
//   2. risk hold                  -> hold
//   3. price out of band          -> wait, or pay when due soon and only the rate is off,
//                                    or hold for a higher cap when due soon and the cap is too low
//   4. balance short              -> split when enough is covered and part payment is allowed, else wait for funds
//   5. otherwise                  -> pay

import { fmt, type Currency } from "../treasury/money.js";
import type { RiskVerdict } from "./risk.js";

export interface DecideConfig {
  /** Today's rate may be this much worse than its median before the agent waits (0.015 = 1.5%). */
  rateBandPct: number;
  /** Due within this many days: stop waiting for a better rate. */
  dueSoonDays: number;
  /** A split pays at least this share of the invoice now. */
  minTrancheShare: number;
  /** A wait for a better rate ends this many days before the due date. */
  waitUntilDaysBeforeDue: number;
}

export const DEFAULT_DECIDE: DecideConfig = { rateBandPct: 0.015, dueSoonDays: 2, minTrancheShare: 0.25, waitUntilDaysBeforeDue: 1 };

export interface DecideInput {
  /** The invoice amount, in its currency's minor units. */
  amountMinor: number;
  currency: Currency;
  /** What paying it in full costs the agent, in USDZ cents. */
  costUsdzMinor: number;
  /** The most the agent may pay for one payout (its max_usdz, or its mandate's per-payment cap). */
  capUsdzMinor: number;
  /** How much worse today's rate is than its 7-day median, as a fraction (0.021 = 2.1% dearer). Negative is better. */
  rateDrift: number;
  /** What the agent can spend now: the lower of its remaining budget and what it holds. */
  spendableUsdzMinor: number;
  risk: RiskVerdict;
  dueAt: Date;
  /** The payee accepts part payments (an instalment invoice, a contractor's running tab). */
  partPaymentAllowed: boolean;
}

export type Verdict = "pay" | "wait" | "split" | "hold" | "reject";

export interface Tranche {
  amountMinor: number;
  costUsdzMinor: number;
  when: "now" | "on_sweep";
}

export interface Decision {
  verdict: Verdict;
  decidedBy: "price" | "balance" | "risk" | "deadline";
  /** One sentence, shown on the decision card. */
  reason: string;
  inputs: { costUsdzMinor: number; capUsdzMinor: number; rateDrift: number; spendableUsdzMinor: number; risk: RiskVerdict["verdict"]; dueInDays: number };
  /** Split only: what is paid now and what follows the next earnings sweep. */
  tranches?: Tranche[];
  /** Wait only: what releases the payout. */
  until?: { rateWithinPct?: number; fundsUsdzMinor?: number; by?: string };
  /** Hold only, when the cap is what's short: the cap the owner would have to approve (mandate replace). */
  proposedCapUsdzMinor?: number;
}

const DAY_MS = 86_400_000;
const usdz = (minor: number) => `${(minor / 100).toFixed(2)} USDZ`;
const pct = (f: number) => `${(Math.abs(f) * 100).toFixed(1)}%`;
const days = (n: number) => (n <= 0 ? "today" : n < 1.5 ? "tomorrow" : `in ${Math.round(n)} days`);

export function decide(i: DecideInput, now: Date, cfg: DecideConfig = DEFAULT_DECIDE): Decision {
  const dueInDays = (i.dueAt.getTime() - now.getTime()) / DAY_MS;
  const inputs = { costUsdzMinor: i.costUsdzMinor, capUsdzMinor: i.capUsdzMinor, rateDrift: i.rateDrift, spendableUsdzMinor: i.spendableUsdzMinor, risk: i.risk.verdict, dueInDays };
  const amount = fmt(i.amountMinor, i.currency);

  if (i.risk.verdict === "reject") return { verdict: "reject", decidedBy: "risk", reason: `Refused: ${i.risk.reasons.join("; ")}.`, inputs };
  if (i.risk.verdict === "hold") return { verdict: "hold", decidedBy: "risk", reason: `Holding ${amount}: ${i.risk.reasons.join("; ")}.`, inputs };

  const overCap = i.costUsdzMinor > i.capUsdzMinor;
  const rateOff = i.rateDrift > cfg.rateBandPct;
  const dueSoon = dueInDays <= cfg.dueSoonDays;
  if (overCap || rateOff) {
    if (!dueSoon) {
      const by = new Date(i.dueAt.getTime() - cfg.waitUntilDaysBeforeDue * DAY_MS).toISOString().slice(0, 10);
      const why = overCap ? `it costs ${usdz(i.costUsdzMinor)}, above the ${usdz(i.capUsdzMinor)} cap` : `${i.currency} is ${pct(i.rateDrift)} dearer than this week's median`;
      return { verdict: "wait", decidedBy: "price", reason: `Waiting: ${why}, and it's due ${days(dueInDays)}.`, inputs, until: { rateWithinPct: cfg.rateBandPct, by } };
    }
    if (overCap) {
      return { verdict: "hold", decidedBy: "deadline", reason: `Holding for you: it costs ${usdz(i.costUsdzMinor)}, above the ${usdz(i.capUsdzMinor)} cap, and it's due ${days(dueInDays)}. Approve a higher cap to pay it.`, inputs, proposedCapUsdzMinor: Math.ceil(i.costUsdzMinor / 100) * 100 };
    }
    // Only the rate is off and the bill can't wait: fall through to the balance check, then pay.
  }

  if (i.costUsdzMinor > i.spendableUsdzMinor) {
    const share = i.spendableUsdzMinor / i.costUsdzMinor;
    if (i.partPaymentAllowed && share >= cfg.minTrancheShare) {
      const nowMinor = Math.floor(i.amountMinor * share);
      const nowCost = Math.min(i.spendableUsdzMinor, Math.ceil(i.costUsdzMinor * (nowMinor / i.amountMinor)));
      const tranches: Tranche[] = [
        { amountMinor: nowMinor, costUsdzMinor: nowCost, when: "now" },
        { amountMinor: i.amountMinor - nowMinor, costUsdzMinor: i.costUsdzMinor - nowCost, when: "on_sweep" },
      ];
      return { verdict: "split", decidedBy: "balance", reason: `Splitting: ${usdz(i.spendableUsdzMinor)} can be spent and this costs ${usdz(i.costUsdzMinor)}, so paying ${fmt(nowMinor, i.currency)} now and ${fmt(i.amountMinor - nowMinor, i.currency)} after the next earnings sweep.`, inputs, tranches };
    }
    return { verdict: "wait", decidedBy: "balance", reason: `Waiting for funds: ${usdz(i.spendableUsdzMinor)} can be spent and this costs ${usdz(i.costUsdzMinor)}; sweeping earnings first.`, inputs, until: { fundsUsdzMinor: i.costUsdzMinor } };
  }

  if (rateOff) return { verdict: "pay", decidedBy: "deadline", reason: `Paying ${amount} now: it's due ${days(dueInDays)}, so paying at today's rate even though ${i.currency} is ${pct(i.rateDrift)} dearer than this week's median.`, inputs };
  return { verdict: "pay", decidedBy: "price", reason: `Paying ${amount}: ${usdz(i.costUsdzMinor)} is within the ${usdz(i.capUsdzMinor)} cap, ${usdz(i.spendableUsdzMinor)} can be spent, and the payee checks out.`, inputs };
}
