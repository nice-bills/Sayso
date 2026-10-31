import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { verifyOffer, type SignedOffer } from "../src/payouts/offer.js";

const quoteBody = {
  amount: "120.00", currency: "EUR", reference: "INV-7",
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban: "ES9121000418450200051332" }, bank_country_code: "ES" },
};

describe("Sayso's signed offer", () => {
  it("signs every payable quote with its published key, and any change to the terms breaks the signature", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { quote_signer, pay_to } = await (await fetch(`${base}/healthz`)).json();
      expect(quote_signer).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const q = await (await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(quoteBody) })).json();
      const o = q.offer as SignedOffer;
      expect(o.terms).toMatchObject({ quote: q.id, amountMinor: "12000", currency: "EUR", reference: "INV-7", payTo: pay_to });
      expect((Number(o.terms.priceUsdzMinor) / 100).toFixed(2)).toBe(q.price_usdz);
      expect(await verifyOffer(o, quote_signer)).toBe(true);

      for (const change of [{ priceUsdzMinor: "1" }, { amountMinor: "99999" }, { payTo: "0x0000000000000000000000000000000000000001" }, { quote: "another" }, { expiresAt: "9999999999" }]) {
        expect(await verifyOffer({ ...o, terms: { ...o.terms, ...change } as SignedOffer["terms"] }, quote_signer), JSON.stringify(change)).toBe(false);
      }
      // Someone else's key claiming to be Sayso.
      expect(await verifyOffer({ ...o, signer: "0x0000000000000000000000000000000000000002" }, "0x0000000000000000000000000000000000000002")).toBe(false);
      // The same offer comes back on the payout itself, unchanged.
      expect((await (await fetch(`${base}/v1/payouts/${q.id}`)).json()).offer.signature).toBe(o.signature);
    } finally {
      server.close();
    }
  });

  it("keeps the same quote key across restarts on the same database", async () => {
    const db = `/tmp/sayso-offer-${Date.now()}.db`;
    const a = await buildSayso({ offline: true, dbPath: db });
    const sa = a.app.listen(0);
    const ka = (await (await fetch(`http://127.0.0.1:${(sa.address() as AddressInfo).port}/healthz`)).json()).quote_signer;
    sa.close();
    const b = await buildSayso({ offline: true, dbPath: db });
    const sb = b.app.listen(0);
    const kb = (await (await fetch(`http://127.0.0.1:${(sb.address() as AddressInfo).port}/healthz`)).json()).quote_signer;
    sb.close();
    expect(kb).toBe(ka);
  });
});
