import { describe, expect, it } from "vitest";
import { fxRatePerSell, globalAccountCurrencies } from "../src/airwallex/client.js";

describe("Airwallex client conventions", () => {
  it("turns a pair-convention rate into buy units per sell unit", () => {
    // Live sandbox answer to sell USD, buy EUR: currency_pair EURUSD, rate 1.138648 (USD per EUR).
    expect(fxRatePerSell(1.138648, "EURUSD", "USD", "EUR")).toBeCloseTo(0.8782, 4);
    expect(fxRatePerSell(0.88, "USDEUR", "USD", "EUR")).toBe(0.88);
    expect(() => fxRatePerSell(1.35, "GBPUSD", "USD", "EUR")).toThrow();
  });

  it("reads a global account's currencies from required_features", () => {
    expect(globalAccountCurrencies({ id: "ga", required_features: [{ currency: "USD", transfer_method: "LOCAL" }] })).toEqual(["USD"]);
    expect(globalAccountCurrencies({ id: "ga" })).toEqual([]);
  });
});
