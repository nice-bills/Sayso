import { describe, expect, it } from "vitest";
import { applyFindings, heuristicRead, mergeFindings, type Findings } from "../src/agent/reader.js";

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

describe("mergeFindings", () => {
  it("keeps a keyword bank-details flag Claude missed", () => {
    const keywords = heuristicRead("Please note our bank has changed, pay urgent invoice to the new account");
    expect(keywords.requestsNewBankDetails).toBe(true);
    const merged = mergeFindings(base, keywords);
    expect(merged).toMatchObject({ requestsNewBankDetails: true, kind: "bank_details_change" });
    expect(merged.citations).toEqual(expect.arrayContaining(keywords.citations));
    expect(merged.citations.length).toBeGreaterThan(0);
  });

  it("keeps flags Claude raised over a clean keyword read", () => {
    const merged = mergeFindings({ ...base, pressureTactics: true, forecastSignal: "supports" }, heuristicRead("Thanks, see you Tuesday."));
    expect(merged).toMatchObject({ pressureTactics: true, forecastSignal: "supports" });
  });
});
