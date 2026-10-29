import { describe, expect, it } from "vitest";
import { RampLedger } from "../src/bridge/ledger.js";
import { sweepEpoch, type AirwallexCredit, type MetalSettlementVerifier } from "../src/bridge/ramp.js";

const verifier = (eventKey = "63825:0xabc:0"): MetalSettlementVerifier => ({ verify: async () => ({ eventKey }) });
const counting = () => {
  let calls = 0;
  const awx: AirwallexCredit = { credit: async () => ({ depositId: `dep_${++calls}` }) };
  return { awx, calls: () => calls };
};

describe("sweepEpoch", () => {
  it("credits a verified epoch once, and a repeat sweep of the same epoch is a no-op", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx, calls } = counting();
    const first = await sweepEpoch({ epoch: "e1", amountMinor: 4210, currency: "USD" }, ledger, verifier(), awx);
    const again = await sweepEpoch({ epoch: "e1", amountMinor: 4210, currency: "USD" }, ledger, verifier(), awx);
    expect(first.outcome).toBe("credited");
    expect(again.outcome).toBe("already_credited");
    expect(calls()).toBe(1);
    expect(ledger.creditedMinor("USD")).toBe(4210);
  });

  it("never credits a movement that failed verification", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx, calls } = counting();
    const bad: MetalSettlementVerifier = { verify: async () => { throw new Error("finality timeout at block 12"); } };
    const r = await sweepEpoch({ epoch: "e2", amountMinor: 100, currency: "USD" }, ledger, bad, awx);
    expect(r.outcome).toBe("rejected");
    expect(r.sweep.reason).toContain("finality timeout");
    expect(calls()).toBe(0);
  });

  it("refuses to back two epochs with the same on-chain event", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx, calls } = counting();
    await sweepEpoch({ epoch: "e3", amountMinor: 100, currency: "USD" }, ledger, verifier("63825:0xdup:0"), awx);
    const dup = await sweepEpoch({ epoch: "e4", amountMinor: 100, currency: "USD" }, ledger, verifier("63825:0xdup:0"), awx);
    expect(dup.outcome).toBe("rejected");
    expect(dup.sweep.reason).toMatch(/UNIQUE/);
    expect(calls()).toBe(1);
  });

  it("gives the Airwallex deposit the Metal transaction hash as its reference", async () => {
    const refs: Array<string | undefined> = [];
    const awx: AirwallexCredit = { credit: async (_op, _amt, _ccy, reference) => { refs.push(reference); return { depositId: "dep_1" }; } };
    await sweepEpoch({ epoch: "e-ref", amountMinor: 100, currency: "USD" }, new RampLedger(":memory:"), verifier("63825:0xfeed:3"), awx);
    expect(refs).toEqual(["0xfeed"]);
  });
});
