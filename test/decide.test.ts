import { describe, expect, it } from "vitest";
import { decide, type DecideInput, type Tranche } from "../src/payouts/decide.js";
import { toMinor } from "../src/treasury/money.js";

const NOW = new Date("2026-11-04T09:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

// The demo invoice: EUR 280 to Kreuzberg Studio, due in 9 days, costing 309 USDZ under a 350 cap.
const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  amountMinor: toMinor(280), currency: "EUR",
  costUsdzMinor: toMinor(309), capUsdzMinor: toMinor(350),
  rateDrift: 0.002, spendableUsdzMinor: toMinor(891),
  risk: { verdict: "allow" }, dueAt: inDays(9), partPaymentAllowed: true,
  ...over,
});

describe("decide", () => {
  it.each([
    ["all green", {}, "pay", "price"],
    ["new bank details", { risk: { verdict: "hold", reasons: ["invoice asks to pay new bank details"] } }, "hold", "risk"],
    ["blocked country", { risk: { verdict: "reject", reasons: ["bank country KP is blocked"] } }, "reject", "risk"],
    ["rate 2.1% worse, due in 9 days", { rateDrift: 0.021 }, "wait", "price"],
    ["rate 2.1% worse, due tomorrow", { rateDrift: 0.021, dueAt: inDays(1) }, "pay", "deadline"],
    ["above the cap, due in 9 days", { costUsdzMinor: toMinor(380) }, "wait", "price"],
    ["above the cap, due tomorrow", { costUsdzMinor: toMinor(380), dueAt: inDays(1) }, "hold", "deadline"],
    ["budget covers 61%", { spendableUsdzMinor: toMinor(190) }, "split", "balance"],
    ["budget covers 61%, no part payments", { spendableUsdzMinor: toMinor(190), partPaymentAllowed: false }, "wait", "balance"],
    ["budget covers 16%", { spendableUsdzMinor: toMinor(50) }, "wait", "balance"],
    ["risk outranks price and balance", { rateDrift: 0.05, spendableUsdzMinor: 0, risk: { verdict: "hold", reasons: ["x"] } }, "hold", "risk"],
    ["price outranks balance", { rateDrift: 0.05, spendableUsdzMinor: toMinor(50) }, "wait", "price"],
    ["due soon and short of funds still splits", { rateDrift: 0.05, dueAt: inDays(1), spendableUsdzMinor: toMinor(190) }, "split", "balance"],
  ] as const)("%s -> %s", (_name, over, verdict, decidedBy) => {
    const d = decide(base(over as Partial<DecideInput>), NOW);
    expect(d.verdict).toBe(verdict);
    expect(d.decidedBy).toBe(decidedBy);
    expect(d.reason.length).toBeGreaterThan(10);
  });

  it("flips from pay to hold when only the risk input changes", () => {
    expect(decide(base(), NOW).verdict).toBe("pay");
    const held = decide(base({ risk: { verdict: "hold", reasons: ["invoice asks to pay new bank details"] } }), NOW);
    expect(held.verdict).toBe("hold");
    expect(held.reason).toContain("new bank details");
  });

  it("holds the boundaries", () => {
    expect(decide(base({ rateDrift: 0.015 }), NOW).verdict).toBe("pay"); // exactly at the band
    expect(decide(base({ rateDrift: 0.0151 }), NOW).verdict).toBe("wait");
    expect(decide(base({ costUsdzMinor: toMinor(350) }), NOW).verdict).toBe("pay"); // exactly at the cap
    expect(decide(base({ rateDrift: 0.02, dueAt: inDays(2) }), NOW).verdict).toBe("pay"); // due in exactly 2 days
    expect(decide(base({ spendableUsdzMinor: toMinor(309) }), NOW).verdict).toBe("pay"); // exactly enough
    expect(decide(base({ spendableUsdzMinor: Math.ceil(toMinor(309) * 0.25) }), NOW).verdict).toBe("split");
    expect(decide(base({ spendableUsdzMinor: Math.floor(toMinor(309) * 0.25) - 1 }), NOW).verdict).toBe("wait");
  });

  it("splits into tranches that add up and stay within what can be spent", () => {
    const d = decide(base({ spendableUsdzMinor: toMinor(190) }), NOW);
    const [first, rest] = d.tranches as [Tranche, Tranche];
    expect(first.when).toBe("now");
    expect(rest.when).toBe("on_sweep");
    expect(first.amountMinor + rest.amountMinor).toBe(toMinor(280));
    expect(first.costUsdzMinor + rest.costUsdzMinor).toBe(toMinor(309));
    expect(first.costUsdzMinor).toBeLessThanOrEqual(toMinor(190));
  });

  it("says what releases a wait", () => {
    expect(decide(base({ rateDrift: 0.021 }), NOW).until).toEqual({ rateWithinPct: 0.015, by: "2026-11-12" });
    expect(decide(base({ spendableUsdzMinor: toMinor(50) }), NOW).until).toEqual({ fundsUsdzMinor: toMinor(309) });
  });

  it("proposes a higher cap when the cap is what's short and the bill can't wait", () => {
    const d = decide(base({ costUsdzMinor: toMinor(380.4), dueAt: inDays(1) }), NOW);
    expect(d.proposedCapUsdzMinor).toBe(toMinor(381));
  });
});
