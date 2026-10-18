import { describe, expect, it } from "vitest";
import { AirwallexError, type Transfer } from "../src/airwallex/client.js";
import { executePay, onTransferState, type AirwallexPort, type ExecutorDeps } from "../src/agent/executor.js";
import { Store } from "../src/store.js";
import { ApprovalGate, grant } from "../src/treasury/approval.js";
import type { Action } from "../src/treasury/policy.js";

type Pay = Extract<Action, { kind: "pay" }>;
const pay = (over: Partial<Pay> = {}): Pay => ({
  kind: "pay", obligationId: "rent-nov", beneficiaryId: "ben_landlord", currency: "EUR", amountMinor: 120000,
  feeMinor: 0, method: "LOCAL", fundedFrom: "held", needsApproval: false, ...over,
});

/** A fake Airwallex whose createTransfer behaviour is scripted per call. */
function fakeAwx(script: Array<"ok" | "timeout_but_created" | "timeout" | "reject">) {
  const created = new Map<string, Transfer>();
  let calls = 0;
  const awx: AirwallexPort = {
    fxConvert: async () => ({ id: "conv_1", status: "SETTLED", sell_amount: 1, buy_amount: 1 }),
    createTransfer: async (body) => {
      const step = script[calls++] ?? "ok";
      if (step === "reject") throw new AirwallexError(400, "invalid_argument", {}, "/transfers/create");
      if (step === "timeout") throw new AirwallexError(504, undefined, {}, "/transfers/create");
      // Airwallex dedupes on request_id: the same id never creates a second transfer.
      const t = created.get(body.request_id) ?? { id: `tfr_${created.size + 1}`, request_id: body.request_id, status: "PROCESSING", transfer_amount: Number(body.transfer_amount), transfer_currency: body.transfer_currency };
      created.set(body.request_id, t);
      if (step === "timeout_but_created") throw new AirwallexError(504, undefined, {}, "/transfers/create");
      return t;
    },
    transferByRequestId: async (id) => created.get(id),
  };
  return { awx, created, calls: () => calls };
}

function deps(awx: AirwallexPort, over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    awx, store: new Store(":memory:"), gate: new ApprovalGate(), approvals: new Map(),
    evidenceHash: () => "ev1", reference: (id) => `sayso ${id}`, baseCurrency: "USD", ...over,
  };
}

describe("executePay", () => {
  it("adopts a transfer that went through despite a timeout, instead of resending", async () => {
    const f = fakeAwx(["timeout_but_created"]);
    const d = deps(f.awx);
    await executePay(d, pay());
    expect(f.created.size).toBe(1);
    expect(f.calls()).toBe(1);
    expect(d.store.latestOp("rent-nov", "pay")).toMatchObject({ status: "submitted", airwallexId: "tfr_1", attempt: 1 });
  });

  it("retries an unconfirmed create once with the same request_id", async () => {
    const f = fakeAwx(["timeout", "ok"]);
    const d = deps(f.awx);
    await executePay(d, pay());
    expect(f.calls()).toBe(2);
    expect(f.created.size).toBe(1);
  });

  it("never pays the same obligation twice when the plan runs again", async () => {
    const f = fakeAwx(["ok", "ok"]);
    const d = deps(f.awx);
    await executePay(d, pay());
    await executePay(d, pay());
    expect(f.created.size).toBe(1);
  });

  it("waits for an approval bound to these exact terms", async () => {
    const f = fakeAwx(["ok"]);
    const d = deps(f.awx);
    const big = pay({ needsApproval: true });
    await executePay(d, big);
    expect(f.calls()).toBe(0);

    // Approved for a different amount: refused.
    d.approvals.set("rent-nov:pay", grant({ action: "pay", obligationId: "rent-nov", currency: "EUR", amountMinor: 100000, beneficiaryId: "ben_landlord", evidenceHash: "ev1" }, "will", 60_000));
    await executePay(d, big);
    expect(f.calls()).toBe(0);

    d.approvals.set("rent-nov:pay", grant({ action: "pay", obligationId: "rent-nov", currency: "EUR", amountMinor: 120000, beneficiaryId: "ben_landlord", evidenceHash: "ev1" }, "will", 60_000));
    await executePay(d, big);
    expect(f.calls()).toBe(1);
  });
});

describe("onTransferState", () => {
  const cancelled = (id: string): Transfer => ({ id, request_id: "x", status: "CANCELLED", transfer_amount: 1200, transfer_currency: "EUR", failure_type: "ACCOUNT_CLOSED" });

  it("allows exactly one replacement after a terminal CANCELLED, then escalates", async () => {
    const f = fakeAwx(["ok", "ok", "ok"]);
    const d = deps(f.awx);
    await executePay(d, pay());
    expect(onTransferState(d, cancelled("tfr_1"), true)).toBe("replace");

    await executePay(d, pay());
    expect(f.created.size).toBe(2);
    expect(d.store.latestOp("rent-nov", "pay")?.attempt).toBe(2);

    expect(onTransferState(d, cancelled("tfr_2"), true)).toBe("escalate");
    await executePay(d, pay());
    expect(f.created.size).toBe(2);
  });

  it("treats SENT as in flight and escalates when the beneficiary is no longer trusted", async () => {
    const f = fakeAwx(["ok"]);
    const d = deps(f.awx);
    await executePay(d, pay());
    expect(onTransferState(d, { ...cancelled("tfr_1"), status: "SENT" }, true)).toBe("pending");
    expect(onTransferState(d, cancelled("tfr_1"), false)).toBe("escalate");
  });
});
