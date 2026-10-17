// Mechanics only: a flat rate series checks that the harness pays bills and counts correctly.
// Real results need a historical FX series and stated traffic assumptions.
import { describe, expect, it } from "vitest";
import { runBacktest, type RatePoint } from "../src/backtest/backtest.js";
import type { PolicyConfig } from "../src/treasury/policy.js";

const cfg: PolicyConfig = {
  baseCurrency: "USD", reserveFloorMinor: 50000, horizonDays: 14,
  autonomousLimits: { high: 1_000_000, medium: 1_000_000, low: 1_000_000 }, swiftFeeMinor: {}, rateBuffer: 0.01,
};
const flat = (days: number): RatePoint[] => Array.from({ length: days }, (_, d) => ({ date: new Date(Date.UTC(2026, 0, 1) + d * 86_400_000), rates: { EUR: 0.9, GBP: 0.8 } }));
const bills = [{ id: "rent", currency: "EUR", amountMinor: 120000, day: 5, critical: true }];

describe("runBacktest", () => {
  it("pays every bill when earnings comfortably cover them", () => {
    const r = runBacktest(flat(180), { months: 6, dailyEarningsMeanMinor: 20000, dailyEarningsSigma: 0.1, outageProbability: 0, fxSpread: 0.005, bills, startingBalanceMinor: 200000, seed: 1 }, cfg);
    expect(r.policy.missedBills).toBe(0);
    expect(r.baseline.missedBills).toBe(0);
    expect(r.policy.conversions).toBeGreaterThan(0);
  });

  it("is reproducible from its seed", () => {
    const bt = { months: 3, dailyEarningsMeanMinor: 5000, dailyEarningsSigma: 0.8, outageProbability: 0.1, fxSpread: 0.005, bills, startingBalanceMinor: 60000, seed: 7 };
    expect(runBacktest(flat(90), bt, cfg)).toEqual(runBacktest(flat(90), bt, cfg));
  });
});
