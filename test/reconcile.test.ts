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
      "Airwallex deposits == ramp credited (USD)",
      "EUR balance explained",
    ]);
    expect(r.checks.find((c) => c.name === "EUR balance explained")?.diffMinor).toBe(-1285);
  });

  it("builds flows from settled operations only", () => {
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
});
