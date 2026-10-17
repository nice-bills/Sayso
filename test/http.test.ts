import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { payoutApi } from "../src/payouts/http.js";
import { PayoutService } from "../src/payouts/service.js";
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
    const server = express().use(payoutApi(svc, { kind: "sim" })).listen(0);
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
    const server = express().use(payoutApi(svc, { kind: "sim" })).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/v1/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
      expect((await fetch(`${base}/v1/payouts/00000000-0000-0000-0000-000000000000/pay`, { method: "POST" })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
