// Runs the policy vs. the convert-on-due baseline over a REAL rate series (data/fx.csv) across
// many seeds, and prints the result next to every assumption it depends on.
// It refuses to run without real data: there are no made-up results.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseRatesCsv, runBacktest, type BacktestConfig } from "../src/backtest/backtest.js";
import { policyConfig } from "../src/scenario.js";
import { toMinor } from "../src/treasury/money.js";

if (!existsSync("data/fx.csv")) {
  console.error("data/fx.csv is missing. Run `npm run fetch-fx` first (needs api.frankfurter.dev reachable).");
  process.exit(1);
}
const series = parseRatesCsv(readFileSync("data/fx.csv", "utf8"));
const seeds = Number(process.env.SEEDS ?? 200);

const assumptions: Omit<BacktestConfig, "seed"> = {
  months: Math.floor(series.length / 22), // business days per month in an ECB series
  dailyEarningsMeanMinor: toMinor(15),
  dailyEarningsSigma: 0.6,
  outageProbability: 0.05,
  fxSpread: 0.005,
  bills: [
    { id: "office-rent", currency: "EUR", amountMinor: toMinor(60), day: 1, critical: true },
    { id: "contractor", currency: "EUR", amountMinor: toMinor(100), day: 15, critical: false },
    { id: "designer", currency: "GBP", amountMinor: toMinor(72), day: 20, critical: false },
  ],
  startingBalanceMinor: toMinor(400),
};

const totals = { policy: { missedBills: 0, reserveBreaches: 0, spreadPaidMinor: 0, conversions: 0 }, baseline: { missedBills: 0, reserveBreaches: 0, spreadPaidMinor: 0, conversions: 0 } };
for (let seed = 1; seed <= seeds; seed++) {
  const r = runBacktest(series, { ...assumptions, seed }, policyConfig);
  for (const k of ["policy", "baseline"] as const) for (const m of Object.keys(totals[k]) as Array<keyof typeof totals.policy>) totals[k][m] += r[k][m];
}
const mean = (k: "policy" | "baseline") => Object.fromEntries(Object.entries(totals[k]).map(([m, v]) => [m, +(v / seeds).toFixed(2)]));
const result = {
  data: { source: "ECB reference rates via Frankfurter", from: series[0]?.date.toISOString().slice(0, 10), to: series.at(-1)?.date.toISOString().slice(0, 10), days: series.length },
  seeds, assumptions, policyConfig, meanPerRun: { policy: mean("policy"), baseline: mean("baseline") },
};
mkdirSync("results", { recursive: true });
writeFileSync("results/backtest.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.meanPerRun, null, 2));
console.log("Assumptions (report these with any number above):", JSON.stringify(assumptions));
console.log("wrote results/backtest.json");
