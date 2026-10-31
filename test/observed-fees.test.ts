import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import type { FakeAirwallex } from "../src/sim/offline.js";

const body = {
  amount: "100.00", currency: "EUR", reference: "fee check",
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban: "ES9121000418450200051332" }, bank_country_code: "ES" },
};

describe("transfer fees come from what Airwallex charged", () => {
  it("prices the next quote with the fee Airwallex actually took, not the built-in guess", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: b ? JSON.stringify(b) : undefined });
      return (await r.json()) as Record<string, any>;
    };
    // Airwallex charges EUR 3.10 here, where Sayso's built-in table says EUR 2.68.
    const fake = cs.awx as unknown as FakeAirwallex;
    const create = fake.createTransfer;
    fake.createTransfer = async (b) => ({ ...(await create(b)), fee_amount: 3.1 });
    try {
      expect(cs.svc.pricing.localFeeMinor.EUR).toBe(268);
      const first = await call("POST", "/v1/quotes", body);
      await call("POST", first.pay_url, undefined, { "x-sim-payer": "0xA9e0000000000000000000000000000000000001" });
      for (let i = 0; i < 3; i++) await cs.tick();
      expect(cs.svc.pricing.localFeeMinor.EUR).toBe(310);
      const second = await call("POST", "/v1/quotes", body);
      expect(Number(second.price_usdz)).toBeGreaterThan(Number(first.price_usdz));
    } finally {
      server.close();
    }
  });
});
