import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { payoutApi } from "../src/payouts/http.js";
import { PayoutService } from "../src/payouts/service.js";
import { BatchBook } from "../src/payouts/batch.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";

const invoice = {
  amount: "120.00", currency: "EUR", reference: "INV-77",
  payee: { name: "Atelier Nord", address: { country_code: "DE", city: "Hamburg", street_address: "Hafenstr. 2", postcode: "20359" }, bank: { iban: "DE89370400440532013000" }, bank_country_code: "DE" },
};

describe("payout API (sim payments)", () => {
  it("quotes for free, asks for payment, then pays the invoice", async () => {
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(1000) }), store: new Store(":memory:"), refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
    const server = express().use(payoutApi(svc, { kind: "sim" }, new BatchBook(new Store(":memory:"), svc))).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    try {
      const q = await (await post("/v1/quotes", invoice)).json() as { id: string; status: string; pay_url: string; price_usdz: string };
      expect(q.status).toBe("quoted");
      expect((await post(q.pay_url)).status).toBe(402);

      const paid = await post(q.pay_url, undefined, { "x-sim-payer": "0xBuyer" });
      expect(paid.status).toBe(202);
      expect((await post(q.pay_url, undefined, { "x-sim-payer": "0xBuyer" })).status).toBe(409); // single use

      await new Promise((r) => setTimeout(r, 20));
      await svc.follow();
      await svc.follow();
      const status = await (await fetch(`${base}/v1/payouts/${q.id}`)).json() as { status: string; airwallex_transfer_id: string };
      expect(status.status).toBe("paid");
      expect(JSON.stringify(status)).not.toContain("DE89"); // bank details never leave
    } finally {
      server.close();
    }
  });

  it("answers bad requests and unknown quotes without asking for payment", async () => {
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: 0 }), store: new Store(":memory:"), refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
    const server = express().use(payoutApi(svc, { kind: "sim" }, new BatchBook(new Store(":memory:"), svc))).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
      expect((await fetch(`${base}/v1/payouts/00000000-0000-0000-0000-000000000000/pay`, { method: "POST" })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("pays a marketplace's sellers with one payment, and refunds only the line that bounces", async () => {
    const store = new Store(":memory:");
    const awx = new FakeAirwallex({ USD: toMinor(2000) });
    const refunder = new FakeRefunder();
    const svc = new PayoutService({ awx, store, refunder, read: async (t) => heuristicRead(t) });
    const server = express().use(payoutApi(svc, { kind: "sim" }, new BatchBook(store, svc))).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seller = (name: string, iban: string, amount: string) => ({ ...invoice, amount, reference: "Payout wk 44", payee: { ...invoice.payee, name, bank: { iban } } });
    try {
      const res = await fetch(`${base}/v1/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: "Sellers wk 44", items: [
        seller("Atelier Nord", "DE89370400440532013000", "120.00"),
        seller("Keramik Süd", "DE75512108001245126199", "80.00"),
        seller("Old Shop (CLOSED)", "DE02100100109307118603", "40.00"),
        seller("Typo Ltd", "NOT-AN-IBAN", "10.00"),
      ] }) });
      expect(res.status).toBe(201);
      const b = (await res.json()) as { id: string; price_usdz: string; payouts: Array<{ price_usdz: string }>; set_aside: Array<{ index: number; status: string }>; pay_url: string };
      expect(b.payouts).toHaveLength(3);
      expect(b.set_aside).toEqual([expect.objectContaining({ index: 3, status: "rejected", reasons: ["Airwallex rejected the bank details: invalid_iban"] })]);
      expect(Number(b.price_usdz)).toBeCloseTo(b.payouts.reduce((s, p) => s + Number(p.price_usdz), 0), 2);

      expect((await fetch(base + b.pay_url, { method: "POST" })).status).toBe(402);
      expect((await fetch(base + b.pay_url, { method: "POST", headers: { "x-sim-payer": "0xMarket" } })).status).toBe(202);
      expect((await fetch(base + b.pay_url, { method: "POST", headers: { "x-sim-payer": "0xMarket" } })).status).toBe(409); // paid once
      // Lines are sent one after another once the payment settles; then the bank reports back.
      for (let i = 0; i < 50 && svc.book.list().some((p) => ["accepted", "funded"].includes(p.status)); i++) await new Promise((r) => setTimeout(r, 20));
      await svc.follow();
      await svc.follow();
      const v = (await (await fetch(`${base}/v1/batches/${b.id}`)).json()) as { status: string; progress: Record<string, number> };
      expect(v.status).toBe("funded");
      expect(v.progress).toEqual({ paid: 2, refunded: 1 });
      expect(refunder.refunds).toHaveLength(1);
      expect(refunder.refunds[0]!.to).toBe("0xMarket");
    } finally {
      server.close();
    }
  });
});
