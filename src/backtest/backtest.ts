// Backtest: Coin Slot's policy against the naive baseline over many simulated months.
// Baseline = what a single-currency settlement does: hold USD only, and when a foreign bill is
// due, convert exactly that bill at that day's rate (no natural hedge, no timing).
// Inputs that are assumptions, not data, are named in `BacktestConfig` and must be reported
// alongside any result. Rates come from a real historical series (date,EUR,GBP per 1 USD).

import { plan, type Obligation, type PolicyConfig, type TreasuryState } from "../treasury/policy.js";

export interface RatePoint { date: Date; rates: Record<string, number> }

export interface BacktestConfig {
  months: number;
  /** Mean daily earnings in USD minor units, and the daily volatility (lognormal sigma). Assumption. */
  dailyEarningsMeanMinor: number;
  dailyEarningsSigma: number;
  /** Probability that a day's traffic collapses to 10% (bursty agent demand). Assumption. */
  outageProbability: number;
  /** FX spread charged per conversion, as a fraction. Assumption until measured on the sandbox. */
  fxSpread: number;
  /** Monthly obligations: currency, amount, day of month, critical. */
  bills: Array<{ id: string; currency: string; amountMinor: number; day: number; critical: boolean }>;
  /** Earnings that arrived before the first month. */
  startingBalanceMinor: number;
  seed: number;
}

export interface StrategyResult { missedBills: number; reserveBreaches: number; spreadPaidMinor: number; conversions: number }

/** Deterministic PRNG so a run can be reproduced from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export function runBacktest(series: RatePoint[], bt: BacktestConfig, cfg: PolicyConfig): { policy: StrategyResult; baseline: StrategyResult; days: number } {
  const days = Math.min(series.length, bt.months * 30);
  const rand = mulberry32(bt.seed);
  const earnings: number[] = [];
  for (let d = 0; d < days; d++) {
    const base = bt.dailyEarningsMeanMinor * Math.exp(bt.dailyEarningsSigma * gaussian(rand) - bt.dailyEarningsSigma ** 2 / 2);
    earnings.push(Math.round(rand() < bt.outageProbability ? base * 0.1 : base));
  }

  const policy: StrategyResult = { missedBills: 0, reserveBreaches: 0, spreadPaidMinor: 0, conversions: 0 };
  const baseline: StrategyResult = { missedBills: 0, reserveBreaches: 0, spreadPaidMinor: 0, conversions: 0 };
  const pBal: Record<string, number> = { USD: bt.startingBalanceMinor };
  const bBal: Record<string, number> = { USD: bt.startingBalanceMinor };
  const paid = new Set<string>();

  for (let d = 0; d < days; d++) {
    const point = series[d]!;
    const dom = (d % 30) + 1;
    const month = Math.floor(d / 30);
    pBal.USD = (pBal.USD ?? 0) + earnings[d]!;
    bBal.USD = (bBal.USD ?? 0) + earnings[d]!;

    // Policy: re-plan daily over the horizon and execute what is due today.
    const obligations: Obligation[] = [];
    for (let m = month; m <= month + 1; m++) {
      for (const b of bt.bills) {
        const id = `${b.id}-${m}`;
        if (paid.has(id)) continue;
        const dueDay = m * 30 + b.day - 1;
        if (dueDay < d) continue;
        obligations.push({ id, payee: b.id, beneficiaryId: b.id, currency: b.currency, amountMinor: b.amountMinor, dueAt: new Date(point.date.getTime() + (dueDay - d) * 86_400_000), method: "LOCAL", critical: b.critical });
      }
    }
    const state: TreasuryState = {
      balancesMinor: { ...pBal },
      rates: point.rates,
      obligations,
      allowlistedBeneficiaries: new Set(bt.bills.map((b) => b.id)),
      forecast: { expectedInflowMinor: bt.dailyEarningsMeanMinor * cfg.horizonDays, confidence: 0.9 },
    };
    const p = plan(state, cfg, point.date);
    for (const a of p.actions) {
      const o = obligations.find((x) => "obligationId" in a && x.id === a.obligationId);
      if (!o) continue;
      const dueToday = Math.floor((o.dueAt.getTime() - point.date.getTime()) / 86_400_000) === 0;
      if (a.kind === "convert" && dueToday) {
        const rate = point.rates[a.buyCurrency]!;
        const sell = Math.ceil(a.buyMinor / (rate * (1 - bt.fxSpread)));
        policy.spreadPaidMinor += sell - Math.ceil(a.buyMinor / rate);
        policy.conversions++;
        pBal.USD = (pBal.USD ?? 0) - sell;
        pBal[a.buyCurrency] = (pBal[a.buyCurrency] ?? 0) + a.buyMinor;
      }
      if (a.kind === "pay" && dueToday) {
        pBal[a.currency] = (pBal[a.currency] ?? 0) - a.amountMinor;
        paid.add(a.obligationId);
      }
    }
    for (const o of obligations) {
      const dueToday = Math.floor((o.dueAt.getTime() - point.date.getTime()) / 86_400_000) === 0;
      if (dueToday && !paid.has(o.id)) { policy.missedBills++; paid.add(o.id); }
    }
    if ((pBal.USD ?? 0) < cfg.reserveFloorMinor) policy.reserveBreaches++;

    // Baseline: on the due day, convert the bill at today's rate if USD covers it.
    for (const b of bt.bills) {
      if (b.day !== dom) continue;
      const rate = b.currency === "USD" ? 1 : point.rates[b.currency]!;
      const sell = b.currency === "USD" ? b.amountMinor : Math.ceil(b.amountMinor / (rate * (1 - bt.fxSpread)));
      if ((bBal.USD ?? 0) >= sell) {
        bBal.USD = (bBal.USD ?? 0) - sell;
        if (b.currency !== "USD") { baseline.conversions++; baseline.spreadPaidMinor += sell - Math.ceil(b.amountMinor / rate); }
      } else baseline.missedBills++;
    }
    if ((bBal.USD ?? 0) < cfg.reserveFloorMinor) baseline.reserveBreaches++;
  }
  return { policy, baseline, days };
}

/** Parse `date,EUR,GBP` rows (units of each currency per 1 USD). */
export function parseRatesCsv(csv: string): RatePoint[] {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const cols = header!.split(",").map((s) => s.trim());
  return rows.map((r) => {
    const cells = r.split(",");
    const rates: Record<string, number> = {};
    cols.slice(1).forEach((c, i) => { rates[c] = Number(cells[i + 1]); });
    return { date: new Date(cells[0]!), rates };
  });
}
