// Downloads a real daily USD->EUR/GBP series for the backtest into data/fx.csv (date,EUR,GBP).
// Source: Frankfurter (ECB reference rates, free, no key). Needs api.frankfurter.dev on the allow-list.

import { mkdirSync, writeFileSync } from "node:fs";

const from = process.argv[2] ?? "2023-01-01";
const to = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const url = `https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=EUR,GBP`;

const res = await fetch(url);
if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
const body = (await res.json()) as { rates: Record<string, { EUR: number; GBP: number }> };
const rows = Object.entries(body.rates).sort(([a], [b]) => a.localeCompare(b)).map(([d, r]) => `${d},${r.EUR},${r.GBP}`);
mkdirSync("data", { recursive: true });
writeFileSync("data/fx.csv", ["date,EUR,GBP", ...rows].join("\n") + "\n");
console.log(`wrote data/fx.csv: ${rows.length} days, ${rows[0]?.split(",")[0]} to ${rows.at(-1)?.split(",")[0]} (ECB reference rates via Frankfurter)`);
