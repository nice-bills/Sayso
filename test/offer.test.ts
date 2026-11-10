import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import type { Payout } from "../src/payouts/book.js";
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

  it("cites the offer it signed at quote time in the proof, unchanged, and never makes a new one", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    try {
      const q = await call("POST", "/v1/quotes", quoteBody);
      const quoted = q.body.offer as SignedOffer;
      expect(await call("POST", q.body.pay_url, undefined, { "x-sim-payer": "0xAgent" })).toMatchObject({ status: 202 });
      for (let i = 0; i < 3; i++) await cs.tick();
      const a = await call("GET", `/v1/payouts/${q.body.id}/proof`);
      expect(a.body.offer).toEqual(quoted);
      expect(JSON.stringify(a.body.offer)).toBe(JSON.stringify(quoted));
      const b = await call("GET", `/v1/payouts/${q.body.id}/proof`);
      expect(b.body.offer.signature).toBe(quoted.signature);
      expect(b.body.hash).toBe(a.body.hash);
    } finally {
      server.close();
    }
  });

  it("leaves a payout with no offer recorded at quote time without one in its proof", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const p: Payout = {
      id: "11111111-1111-4111-8111-111111111111",
      buyer: null, currency: "EUR", amountMinor: 12000, method: "LOCAL", bankCountry: "ES",
      payeeName: "Legacy SL", payeeHash: "legacy", beneficiary: {}, reference: "INV-OLD",
      costMinor: 12000, feeMinor: 0, totalMinor: 12000, rateUsed: 1, status: "paid", reasons: [],
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      fundingTx: "sim:0xfunded", transferId: null, refundTx: null, failure: null, decision: null,
    };
    cs.svc.book.insert(p);
    try {
      const proof = (await (await fetch(`${base}/v1/payouts/${p.id}/proof`)).json()) as Record<string, any>;
      expect(proof.offer).toBeUndefined();
      expect(proof.evidence[0].detail).not.toMatch(/quote key/);
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
