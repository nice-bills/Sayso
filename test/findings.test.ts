import { describe, expect, it } from "vitest";
import { applyFindings, type Findings } from "../src/agent/reader.js";

const base: Findings = { kind: "invoice", claimedPayee: "Landlord", requestsNewBankDetails: false, pressureTactics: false, forecastSignal: "none", citations: [], summary: "" };
const forecast = { expectedInflowMinor: 150000, confidence: 0.9 };

describe("applyFindings", () => {
  it("escalates any request for new bank details", () => {
    expect(applyFindings({ ...base, requestsNewBankDetails: true }, forecast).escalate).toBe(true);
    expect(applyFindings({ ...base, kind: "bank_details_change" }, forecast).escalate).toBe(true);
  });

  it("lowers confidence on contradicting evidence and never raises it", () => {
    expect(applyFindings({ ...base, forecastSignal: "contradicts" }, forecast).forecast.confidence).toBe(0.45);
    expect(applyFindings({ ...base, forecastSignal: "supports" }, { ...forecast, confidence: 0.3 }).forecast.confidence).toBe(0.3);
  });
});
