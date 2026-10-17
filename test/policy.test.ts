import { describe, expect, it } from "vitest";
import { diffPlans, plan, type Obligation, type PolicyConfig, type TreasuryState } from "../src/treasury/policy.js";
import { toMinor } from "../src/treasury/money.js";

const now = new Date("2026-11-01T00:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000);

const cfg: PolicyConfig = {
  baseCurrency: "USD",
  reserveFloorMinor: toMinor(500),
  horizonDays: 14,
  autonomousLimits: { high: toMinor(2000), medium: toMinor(800), low: toMinor(100) },
  swiftFeeMinor: { EUR: toMinor(12.85) },
  rateBuffer: 0.01,
};

const rent: Obligation = { id: "rent", payee: "Landlord Berlin", beneficiaryId: "ben_landlord", currency: "EUR", amountMinor: toMinor(1200), dueAt: inDays(5), method: "LOCAL", critical: true };
const contractor: Obligation = { id: "contractor", payee: "Contractor London", beneficiaryId: "ben_contractor", currency: "GBP", amountMinor: toMinor(300), dueAt: inDays(3), method: "LOCAL", critical: false };
const compute: Obligation = { id: "compute", payee: "Cloud compute", beneficiaryId: "ben_cloud", currency: "USD", amountMinor: toMinor(400), dueAt: inDays(2), method: "LOCAL", critical: true };

const state = (over: Partial<TreasuryState> = {}): TreasuryState => ({
  balancesMinor: { USD: toMinor(4000) },
  rates: { EUR: 0.92, GBP: 0.79 },
  obligations: [rent, contractor, compute],
  allowlistedBeneficiaries: new Set(["ben_landlord", "ben_contractor", "ben_cloud"]),
  forecast: { expectedInflowMinor: toMinor(1500), confidence: 0.9 },
  ...over,
});

describe("plan", () => {
  it("funds critical obligations first and converts only the shortfall", () => {
    const p = plan(state(), cfg, now);
    const kinds = p.actions.map((a) => `${a.kind}:${"obligationId" in a ? a.obligationId : a.currency}`);
    expect(kinds.slice(0, 3)).toEqual(["pay:compute", "convert:rent", "pay:rent"]);
    const conv = p.actions.find((a) => a.kind === "convert" && a.obligationId === "rent");
    expect(conv).toMatchObject({ buyCurrency: "EUR", buyMinor: toMinor(1200) });
    expect(p.baseRemainingMinor).toBeGreaterThanOrEqual(cfg.reserveFloorMinor);
  });

  it("pays from currency already held instead of converting (natural hedge)", () => {
    const p = plan(state({ balancesMinor: { USD: toMinor(4000), EUR: toMinor(1500) } }), cfg, now);
    expect(p.actions.some((a) => a.kind === "convert" && a.obligationId === "rent")).toBe(false);
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "pay", obligationId: "rent", fundedFrom: "held" }));
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "hold", currency: "EUR", amountMinor: toMinor(300) }));
  });

  it("converts only the part not already held", () => {
    const p = plan(state({ balancesMinor: { USD: toMinor(4000), EUR: toMinor(1000) } }), cfg, now);
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "convert", obligationId: "rent", buyMinor: toMinor(200) }));
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "pay", obligationId: "rent", fundedFrom: "mixed" }));
  });

  it("includes the SWIFT fee in what it converts", () => {
    const p = plan(state({ obligations: [{ ...rent, method: "SWIFT" }] }), cfg, now);
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "convert", buyMinor: toMinor(1212.85) }));
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "pay", feeMinor: toMinor(12.85) }));
  });

  it("never dips below the reserve floor: defers, or escalates a critical bill due within a day", () => {
    const tight = state({ balancesMinor: { USD: toMinor(900) } });
    const p = plan(tight, cfg, now);
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "pay", obligationId: "compute" }));
    expect(p.actions).toContainEqual(expect.objectContaining({ kind: "defer", obligationId: "rent" }));
    expect(p.baseRemainingMinor).toBeGreaterThanOrEqual(cfg.reserveFloorMinor);

    const urgent = plan(state({ balancesMinor: { USD: toMinor(900) }, obligations: [compute, { ...rent, dueAt: inDays(0.5) }] }), cfg, now);
    expect(urgent.actions).toContainEqual({ kind: "escalate", obligationId: "rent", reason: "critical_unfundable_above_reserve" });
  });

  it("escalates a payment to a beneficiary that is not allowlisted, however small", () => {
    const p = plan(state({ obligations: [{ ...contractor, beneficiaryId: "ben_new_iban_from_email" }] }), cfg, now);
    expect(p.actions).toEqual([{ kind: "escalate", obligationId: "contractor", reason: "beneficiary_not_allowlisted" }]);
  });

  it("tightens the autonomous limit when confidence drops, requiring approval for the same conversion", () => {
    const confident = plan(state(), cfg, now);
    const doubtful = plan(state({ forecast: { expectedInflowMinor: toMinor(1500), confidence: 0.3 } }), cfg, now);
    const conv = (p: typeof confident) => p.actions.find((a) => a.kind === "convert" && a.obligationId === "rent");
    expect(conv(confident)).toMatchObject({ needsApproval: false });
    expect(conv(doubtful)).toMatchObject({ needsApproval: true });
  });

  it("ignores obligations beyond the horizon and holds currency they will need", () => {
    const later: Obligation = { ...rent, id: "rent_next", dueAt: inDays(35) };
    const p = plan(state({ balancesMinor: { USD: toMinor(4000), EUR: toMinor(2000) }, obligations: [rent, later] }), cfg, now);
    expect(p.actions.some((a) => "obligationId" in a && a.obligationId === "rent_next")).toBe(false);
    expect(p.actions).toContainEqual({ kind: "hold", currency: "EUR", amountMinor: toMinor(800), reason: "natural_hedge_for_later_obligation" });
  });

  it("reopens only the decisions a deposit affects", () => {
    const before = plan(state({ balancesMinor: { USD: toMinor(900) } }), cfg, now);
    const after = plan(state({ balancesMinor: { USD: toMinor(3000) } }), cfg, now);
    const { changed } = diffPlans(before, after);
    expect(changed.every((a) => !("obligationId" in a) || a.obligationId !== "compute")).toBe(true);
    expect(changed.some((a) => a.kind === "pay" && a.obligationId === "rent")).toBe(true);
  });
});
