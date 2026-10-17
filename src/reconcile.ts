// Reconciliation: arithmetic, never the model. Two identities must hold to the cent.
// 1. Off-ramp: every cent swept on Metal was credited by the ramp, and every credit arrived on Airwallex.
//      metal swept == ramp credited == Airwallex deposits
// 2. Per currency, the Airwallex balance moved only for reasons we recorded:
//      opening + deposits + bought - sold - payouts - fees - card spend == closing
// A break is reported with its size and never auto-corrected.

import type { RampLedger } from "./bridge/ledger.js";
import { emit } from "./events.js";
import type { Store } from "./store.js";

export interface CurrencyFlows {
  openingMinor: number;
  closingMinor: number;
  depositsMinor: number;
  boughtMinor: number;
  soldMinor: number;
  payoutsMinor: number;
  feesMinor: number;
  cardSpendMinor: number;
}

export interface ReconcileInput {
  rampCurrency: string;
  metalSweptMinor: number;
  rampCreditedMinor: number;
  airwallexDepositsMinor: number;
  currencies: Record<string, CurrencyFlows>;
}

export interface Check {
  name: string;
  ok: boolean;
  expectedMinor: number;
  actualMinor: number;
  diffMinor: number;
}

const check = (name: string, expectedMinor: number, actualMinor: number): Check => ({ name, ok: expectedMinor === actualMinor, expectedMinor, actualMinor, diffMinor: actualMinor - expectedMinor });

export function reconcile(i: ReconcileInput): { ok: boolean; checks: Check[] } {
  const checks = [
    check(`ramp credited == Metal swept (${i.rampCurrency})`, i.metalSweptMinor, i.rampCreditedMinor),
    check(`Airwallex deposits == ramp credited (${i.rampCurrency})`, i.rampCreditedMinor, i.airwallexDepositsMinor),
    ...Object.entries(i.currencies).map(([ccy, f]) =>
      check(`${ccy} balance explained`, f.openingMinor + f.depositsMinor + f.boughtMinor - f.soldMinor - f.payoutsMinor - f.feesMinor - f.cardSpendMinor, f.closingMinor)),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

export type BookFlows = Omit<CurrencyFlows, "openingMinor" | "closingMinor">;

/**
 * Builds the recorded flows from our own books (settled ops and credited sweeps).
 * Opening/closing balances and observed deposits come from Airwallex.
 */
export function flowsFromBooks(store: Store, ledger: RampLedger, rampCurrency: string): Record<string, BookFlows> {
  const out: Record<string, BookFlows> = {};
  const f = (ccy: string) => (out[ccy] ??= { depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 });
  f(rampCurrency).depositsMinor += ledger.creditedMinor(rampCurrency);
  for (const op of store.ops()) {
    if (op.status !== "settled") continue;
    if (op.kind === "pay") {
      f(op.currency).payoutsMinor += op.amountMinor;
      f(op.currency).feesMinor += op.detail?.startsWith("{") ? ((JSON.parse(op.detail) as { fee_minor?: number }).fee_minor ?? 0) : 0;
    }
    if (op.kind === "card_spend") f(op.currency).cardSpendMinor += op.amountMinor;
    if (op.kind === "convert") {
      f(op.currency).boughtMinor += op.amountMinor;
      const sell = op.detail ? (JSON.parse(op.detail) as { sell_currency?: string; sell_minor?: number }) : {};
      if (sell.sell_currency && sell.sell_minor !== undefined) f(sell.sell_currency).soldMinor += sell.sell_minor;
    }
  }
  return out;
}

export function reportReconcile(r: { ok: boolean; checks: Check[] }): void {
  for (const c of r.checks) {
    if (!c.ok) emit("escalate", `Reconciliation break: ${c.name} off by ${(c.diffMinor / 100).toFixed(2)}`, { expected: c.expectedMinor, actual: c.actualMinor });
  }
  emit("reconcile", r.ok ? `Books reconcile to the cent (${r.checks.length} checks)` : `Reconciliation FAILED (${r.checks.filter((c) => !c.ok).length} breaks)`, { checks: r.checks });
}
