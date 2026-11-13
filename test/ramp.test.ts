import { describe, expect, it } from "vitest";
import { RampLedger } from "../src/bridge/ledger.js";
import { sweepEpoch, SweepRejected, type AirwallexCredit, type MetalSettlementVerifier } from "../src/bridge/ramp.js";

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

  it("never credits a movement that is not final yet, and keeps it for a retry", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx, calls } = counting();
    const slow: MetalSettlementVerifier = { verify: async () => { throw new Error("finality timeout at block 12"); } };
    const r = await sweepEpoch({ epoch: "e2", amountMinor: 100, currency: "USD" }, ledger, slow, awx);
    expect(r.outcome).toBe("pending");
    expect(r.outcome === "pending" && r.reason).toContain("finality timeout");
    expect(calls()).toBe(0);
    expect(ledger.unfinished()?.epoch).toBe("e2");
    expect(ledger.unfinished()?.amountMinor).toBe(100);
    expect(typeof ledger.unfinished()?.operationId).toBe("string");
  });

  it("rejects a movement proven wrong", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx } = counting();
    const bad: MetalSettlementVerifier = { verify: async () => { throw new SweepRejected("mandate refused the sweep: ExceedsCap"); } };
    const r = await sweepEpoch({ epoch: "e6", amountMinor: 100, currency: "USD" }, ledger, bad, awx);
    expect(r.outcome).toBe("rejected");
    expect(ledger.unfinished()).toBeUndefined();
  });

  it("retries the same epoch after a passing error and credits it once", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx, calls } = counting();
    const seen: string[] = [];
    let n = 0;
    const flaky: MetalSettlementVerifier = { verify: async (epoch) => { seen.push(epoch); if (++n === 1) throw new Error("rpc down"); return { eventKey: "63825:0xok:0" }; } };
    const first = await sweepEpoch({ epoch: "e5", amountMinor: 100, currency: "USD" }, ledger, flaky, awx);
    const second = await sweepEpoch({ epoch: "e5", amountMinor: 100, currency: "USD" }, ledger, flaky, awx);
    expect(first.outcome).toBe("pending");
    expect(second.outcome).toBe("credited");
    expect(calls()).toBe(1);
    expect(seen).toEqual(["e5", "e5"]);
  });

  it("a retry driven by unfinished() hands the stored amount to verify", async () => {
    const ledger = new RampLedger(":memory:");
    const { awx } = counting();
    const args: Array<[string, number]> = [];
    let n = 0;
    const flaky: MetalSettlementVerifier = { verify: async (epoch, amt) => { args.push([epoch, amt]); if (++n === 1) throw new Error("rpc down"); return { eventKey: "63825:0xok2:0" }; } };
    await sweepEpoch({ epoch: "e8", amountMinor: 777, currency: "USD" }, ledger, flaky, awx);
    const open = ledger.unfinished()!;
    expect(open.amountMinor).toBe(777);
    await sweepEpoch({ epoch: open.epoch, amountMinor: open.amountMinor, currency: "USD" }, ledger, flaky, awx);
    expect(args).toEqual([["e8", 777], ["e8", 777]]);
  });

  it("a verified sweep whose credit failed is credited on the next try", async () => {
    const ledger = new RampLedger(":memory:");
    let n = 0;
    const awx: AirwallexCredit = { credit: async () => { if (++n === 1) throw new Error("awx down"); return { depositId: "dep_1" }; } };
    await expect(sweepEpoch({ epoch: "e7", amountMinor: 100, currency: "USD" }, ledger, verifier(), awx)).rejects.toThrow("awx down");
    expect(ledger.unfinished()?.status).toBe("verified");
    const r = await sweepEpoch({ epoch: "e7", amountMinor: 100, currency: "USD" }, ledger, verifier(), awx);
    expect(r.outcome).toBe("credited");
    expect(ledger.unfinished()).toBeUndefined();
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
