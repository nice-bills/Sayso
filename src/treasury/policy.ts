// The treasury policy. Pure functions: every amount, limit and reserve is decided here, in code.
// The model never sets a number; it can only lower forecast confidence or flag evidence,
// which this module turns into tighter limits or an escalation.

import { type Currency, sellNeededMinor } from "./money.js";

export type TransferMethod = "LOCAL" | "SWIFT";

export interface Obligation {
  id: string;
  payee: string;
  beneficiaryId: string;
  currency: Currency;
  amountMinor: number;
  dueAt: Date;
  method: TransferMethod;
  /** Non-payment stops the business (rent, compute). Funded first. */
  critical: boolean;
}

export interface Forecast {
  /** Expected agent earnings over the horizon, in base-currency minor units. */
  expectedInflowMinor: number;
  /** 0..1. Lowered when evidence (an email, a traffic drop) contradicts the forecast. */
  confidence: number;
}

export interface PolicyConfig {
  baseCurrency: Currency;
  /** Never spend below this, in base-currency minor units. */
  reserveFloorMinor: number;
  /** Only obligations due within this many days are planned. */
  horizonDays: number;
  /** Autonomous spend limit per action, by forecast confidence band (base minor units). */
  autonomousLimits: { high: number; medium: number; low: number };
  /** Flat SWIFT fee per payout, charged in the payout currency (minor units). LOCAL is free. */
  swiftFeeMinor: Partial<Record<Currency, number>>;
  /** Headroom on indicative rates before a quote is locked (e.g. 0.01 = 1%). */
  rateBuffer: number;
}

export interface TreasuryState {
  balancesMinor: Partial<Record<Currency, number>>;
  /** Indicative rates: units of the quote currency per 1 unit of base currency. */
  rates: Partial<Record<Currency, number>>;
  obligations: Obligation[];
  allowlistedBeneficiaries: ReadonlySet<string>;
  forecast: Forecast;
}

export type Action =
  | { kind: "convert"; obligationId: string; buyCurrency: Currency; buyMinor: number; sellCurrency: Currency; estSellMinor: number; needsApproval: boolean }
  | { kind: "pay"; obligationId: string; beneficiaryId: string; currency: Currency; amountMinor: number; feeMinor: number; method: TransferMethod; fundedFrom: "held" | "converted" | "mixed"; needsApproval: boolean }
  | { kind: "defer"; obligationId: string; reason: string }
  | { kind: "escalate"; obligationId: string; reason: string }
  | { kind: "hold"; currency: Currency; amountMinor: number; reason: string };

export interface Plan {
  actions: Action[];
  /** Base-currency balance left after the plan; never below the reserve floor. */
  baseRemainingMinor: number;
  autonomousLimitMinor: number;
}

export function autonomousLimit(cfg: PolicyConfig, confidence: number): number {
  if (confidence >= 0.8) return cfg.autonomousLimits.high;
  if (confidence >= 0.5) return cfg.autonomousLimits.medium;
  return cfg.autonomousLimits.low;
}

const DAY_MS = 86_400_000;

/**
 * Plan the horizon. Order: critical first, then by due date. For each obligation:
 * escalate an unknown beneficiary; pay from currency already held (natural hedge);
 * convert only the shortfall from base currency, never dipping below the reserve floor;
 * defer what cannot be funded; flag anything above the autonomous limit for approval.
 */
export function plan(state: TreasuryState, cfg: PolicyConfig, now: Date): Plan {
  const held: Partial<Record<Currency, number>> = { ...state.balancesMinor };
  const base = cfg.baseCurrency;
  const limit = autonomousLimit(cfg, state.forecast.confidence);
  const actions: Action[] = [];
  const horizonEnd = now.getTime() + cfg.horizonDays * DAY_MS;

  const due = state.obligations
    .filter((o) => o.dueAt.getTime() <= horizonEnd)
    .sort((a, b) => Number(b.critical) - Number(a.critical) || a.dueAt.getTime() - b.dueAt.getTime());

  for (const o of due) {
    if (!state.allowlistedBeneficiaries.has(o.beneficiaryId)) {
      actions.push({ kind: "escalate", obligationId: o.id, reason: "beneficiary_not_allowlisted" });
      continue;
    }
    const feeMinor = o.method === "SWIFT" ? (cfg.swiftFeeMinor[o.currency] ?? 0) : 0;
    const needMinor = o.amountMinor + feeMinor;
    const haveMinor = held[o.currency] ?? 0;

    if (haveMinor >= needMinor && o.currency !== base) {
      held[o.currency] = haveMinor - needMinor;
      const valueInBase = toBase(needMinor, o.currency, state, base);
      actions.push(payAction(o, feeMinor, "held", valueInBase > limit));
      continue;
    }

    if (o.currency === base) {
      const available = (held[base] ?? 0) - cfg.reserveFloorMinor;
      if (available >= needMinor) {
        held[base] = (held[base] ?? 0) - needMinor;
        actions.push(payAction(o, feeMinor, "held", needMinor > limit));
      } else {
        actions.push(shortfall(o, now));
      }
      continue;
    }

    // Foreign currency: use what we hold, convert the rest from base.
    const rate = state.rates[o.currency];
    if (rate === undefined) {
      actions.push({ kind: "escalate", obligationId: o.id, reason: `no_rate_${o.currency}` });
      continue;
    }
    const buyMinor = needMinor - haveMinor;
    const estSellMinor = sellNeededMinor(buyMinor, rate * (1 - cfg.rateBuffer));
    const availableBase = (held[base] ?? 0) - cfg.reserveFloorMinor;
    if (estSellMinor > availableBase) {
      actions.push(shortfall(o, now));
      continue;
    }
    held[base] = (held[base] ?? 0) - estSellMinor;
    held[o.currency] = 0;
    const needsApproval = estSellMinor > limit;
    actions.push({ kind: "convert", obligationId: o.id, buyCurrency: o.currency, buyMinor, sellCurrency: base, estSellMinor, needsApproval });
    actions.push(payAction(o, feeMinor, haveMinor > 0 ? "mixed" : "converted", needsApproval));
  }

  // Foreign currency left over stays put when a later obligation (beyond the horizon) needs it;
  // converting it back and forth only pays the spread twice.
  for (const [ccy, amt] of Object.entries(held)) {
    if (ccy === base || !amt) continue;
    const laterNeed = state.obligations.some((o) => o.currency === ccy && o.dueAt.getTime() > horizonEnd);
    actions.push({ kind: "hold", currency: ccy, amountMinor: amt, reason: laterNeed ? "natural_hedge_for_later_obligation" : "no_conversion_needed" });
  }

  return { actions, baseRemainingMinor: held[base] ?? 0, autonomousLimitMinor: limit };
}

function payAction(o: Obligation, feeMinor: number, fundedFrom: "held" | "converted" | "mixed", needsApproval: boolean): Action {
  return { kind: "pay", obligationId: o.id, beneficiaryId: o.beneficiaryId, currency: o.currency, amountMinor: o.amountMinor, feeMinor, method: o.method, fundedFrom, needsApproval };
}

function shortfall(o: Obligation, now: Date): Action {
  const dueInDays = (o.dueAt.getTime() - now.getTime()) / DAY_MS;
  // A critical bill we cannot fund within a day goes to a person; anything else waits for inflows.
  return o.critical && dueInDays <= 1
    ? { kind: "escalate", obligationId: o.id, reason: "critical_unfundable_above_reserve" }
    : { kind: "defer", obligationId: o.id, reason: "insufficient_funds_above_reserve" };
}

function toBase(minor: number, ccy: Currency, state: TreasuryState, base: Currency): number {
  if (ccy === base) return minor;
  const rate = state.rates[ccy];
  return rate ? Math.ceil(minor / rate) : Number.POSITIVE_INFINITY;
}

/**
 * Re-plan after new information and report only the decisions that changed,
 * so a deposit or a lowered confidence reopens just what it affects.
 */
export function diffPlans(before: Plan, after: Plan): { changed: Action[]; unchanged: number } {
  const key = (a: Action) => JSON.stringify(a);
  const prev = new Set(before.actions.map(key));
  const changed = after.actions.filter((a) => !prev.has(key(a)));
  return { changed, unchanged: after.actions.length - changed.length };
}
