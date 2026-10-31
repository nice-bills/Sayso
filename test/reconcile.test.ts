import { describe, expect, it } from "vitest";
import { RampLedger } from "../src/bridge/ledger.js";
import { flowsFromBooks, reconcile, type ReconcileInput } from "../src/reconcile.js";
import { Store } from "../src/store.js";

const base = (): ReconcileInput => ({
  rampCurrency: "USD",
  metalSweptMinor: 5000,
  rampCreditedMinor: 5000,
  airwallexDepositsMinor: 5000,
  currencies: {
    USD: { openingMinor: 10000, closingMinor: 10000 + 5000 - 2200 - 900, depositsMinor: 5000, boughtMinor: 0, soldMinor: 2200, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 900 },
    EUR: { openingMinor: 0, closingMinor: 0, depositsMinor: 0, boughtMinor: 2000, soldMinor: 0, payoutsMinor: 2000, feesMinor: 0, cardSpendMinor: 0 },
  },
});

describe("reconcile", () => {
  it("passes when every cent is explained", () => {
    expect(reconcile(base()).ok).toBe(true);
  });

  it("catches a sweep that was credited twice and a balance moved for no recorded reason", () => {
    const i = base();
    i.rampCreditedMinor = 10000;
    i.currencies.EUR!.closingMinor = -1285; // an unrecorded SWIFT fee
    const r = reconcile(i);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "ramp credited == Metal swept (USD)",
      "Airwallex deposit ids == ramp credited (USD)",
      "EUR balance explained",
    ]);
    expect(r.checks.find((c) => c.name === "EUR balance explained")?.diffMinor).toBe(-1285);
  });

  it("builds flows from settled operations, not ones Airwallex never accepted", () => {
    const store = new Store(":memory:");
    const ledger = new RampLedger(":memory:");
    ledger.record("op1", "e1", 5000, "USD");
    ledger.markVerified("op1", "63825:0x1:0");
    ledger.markCredited("op1", "dep1");
    store.insertOp({ requestId: "r1", obligationId: "o1", kind: "convert", attempt: 1, status: "submitted", currency: "EUR", amountMinor: 2000 });
    store.updateOp("r1", "settled", "conv1", JSON.stringify({ sell_currency: "USD", sell_minor: 2200 }));
    store.insertOp({ requestId: "r2", obligationId: "o1", kind: "pay", attempt: 1, status: "settled", currency: "EUR", amountMinor: 2000, detail: JSON.stringify({ fee_minor: 1285 }) });
    store.insertOp({ requestId: "r3", obligationId: "o2", kind: "pay", attempt: 1, status: "submitted", currency: "EUR", amountMinor: 999 });
    expect(flowsFromBooks(store, ledger, "USD")).toEqual({
      USD: { depositsMinor: 5000, boughtMinor: 0, soldMinor: 2200, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 },
      EUR: { depositsMinor: 0, boughtMinor: 2000, soldMinor: 0, payoutsMinor: 2000, feesMinor: 1285, cardSpendMinor: 0 },
    });
  });

  it("counts a transfer when Airwallex creates it, and keeps the fee of one that bounced", () => {
    const store = new Store(":memory:");
    const ledger = new RampLedger(":memory:");
    // In flight: Airwallex debited EUR 60.00 plus its EUR 2.68 fee when it created the transfer.
    store.insertOp({ requestId: "r1", obligationId: "o1", kind: "pay", attempt: 1, status: "submitted", currency: "EUR", amountMinor: 6000 });
    store.updateOp("r1", "submitted", "tfr1", JSON.stringify({ fee_minor: 268 }));
    // Bounced: the EUR 40.00 came back, the fee did not.
    store.insertOp({ requestId: "r2", obligationId: "o2", kind: "pay", attempt: 1, status: "submitted", currency: "EUR", amountMinor: 4000 });
    store.updateOp("r2", "failed", "tfr2", JSON.stringify({ fee_minor: 268, failure: "Account closed" }));
    expect(flowsFromBooks(store, ledger, "USD").EUR).toEqual({ depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 6000, feesMinor: 536, cardSpendMinor: 0 });
  });
});

describe("what counts as a check", () => {
  it("doesn't count a currency that held nothing and moved nothing", () => {
    const zero = { openingMinor: 0, closingMinor: 0, depositsMinor: 0, boughtMinor: 0, soldMinor: 0, payoutsMinor: 0, feesMinor: 0, cardSpendMinor: 0 };
    const r = reconcile({ rampCurrency: "USD", metalSweptMinor: 0, rampCreditedMinor: 0, airwallexDepositsMinor: 0, currencies: { USD: { ...zero, openingMinor: 500, closingMinor: 500 }, JPY: zero, NOK: zero } });
    expect(r.checks.map((c) => c.name)).toEqual(["ramp credited == Metal swept (USD)", "Airwallex deposit ids == ramp credited (USD)", "USD balance explained"]);
  });
});
