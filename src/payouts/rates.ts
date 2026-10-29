// This week's median rate per currency, so decide() can tell a bad rate from a normal one.
// Seeded from the ECB history in data/fx.csv, then fed by every rate Airwallex quotes.

import { existsSync, readFileSync } from "node:fs";

const DAY_MS = 86_400_000;

export class RateMedian {
  private readonly seen = new Map<string, Array<{ at: number; rate: number }>>();

  /** Fewer rates than `minSamples` in the window gives no median, so a fresh start never waits. */
  constructor(private readonly windowDays = 7, private readonly minSamples = 3) {}

  /** Units of `currency` per 1 USD, seen at `at`. */
  record(currency: string, rate: number, at = new Date()): void {
    const list = this.seen.get(currency) ?? [];
    list.push({ at: at.getTime(), rate });
    this.seen.set(currency, list);
  }

  median(currency: string, now = new Date()): number | undefined {
    const all = this.seen.get(currency) ?? [];
    const latest = Math.max(...all.map((r) => r.at));
    // The window ends at the newest rate we have, so an old seed still gives a median.
    const end = Math.min(now.getTime(), latest);
    const rates = all.filter((r) => r.at > end - this.windowDays * DAY_MS && r.at <= now.getTime()).map((r) => r.rate).sort((a, b) => a - b);
    if (rates.length < this.minSamples) return undefined;
    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 ? rates.at(mid) : ((rates.at(mid - 1) ?? 0) + (rates.at(mid) ?? 0)) / 2;
  }

  /** The last week of a CSV with a `date` column and one column per currency (units per USD). */
  static fromCsv(path = "data/fx.csv", windowDays = 7): RateMedian {
    const m = new RateMedian(windowDays);
    if (!existsSync(path)) return m;
    const [header, ...rows] = readFileSync(path, "utf8").trim().split("\n");
    const cols = (header ?? "").split(",");
    for (const row of rows.slice(-windowDays)) {
      const cells = row.split(",");
      const at = new Date(`${cells.at(0)}T16:00:00Z`);
      cols.forEach((c, i) => { if (i > 0 && Number(cells.at(i))) m.record(c, Number(cells.at(i)), at); });
    }
    return m;
  }
}
