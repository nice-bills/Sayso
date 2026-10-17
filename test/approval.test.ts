import { describe, expect, it } from "vitest";
import { ApprovalGate, grant, hashEvidence, type ApprovalTerms } from "../src/treasury/approval.js";

const terms: ApprovalTerms = { action: "pay", obligationId: "rent", currency: "EUR", amountMinor: 120000, beneficiaryId: "ben_landlord", evidenceHash: hashEvidence("invoice-oct.pdf") };

describe("ApprovalGate", () => {
  it("accepts the exact terms once", () => {
    const gate = new ApprovalGate();
    const a = grant(terms, "will", 60_000);
    expect(gate.check(a, terms)).toEqual({ ok: true });
    expect(gate.check(a, terms)).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses a changed amount or a swapped beneficiary", () => {
    const gate = new ApprovalGate();
    const a = grant(terms, "will", 60_000);
    expect(gate.check(a, { ...terms, amountMinor: 120001 })).toEqual({ ok: false, reason: "terms_changed" });
    expect(gate.check(a, { ...terms, beneficiaryId: "ben_attacker" })).toEqual({ ok: false, reason: "terms_changed" });
  });

  it("refuses after expiry", () => {
    const gate = new ApprovalGate();
    const a = grant(terms, "will", 1000, new Date("2026-11-01T00:00:00Z"));
    expect(gate.check(a, terms, new Date("2026-11-01T00:00:02Z"))).toEqual({ ok: false, reason: "expired" });
  });
});
