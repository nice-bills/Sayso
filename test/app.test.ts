import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildCoinSlot } from "../src/app.js";
import { designerInvoice, studioInvoice } from "../samples/invoices.js";

describe("Coin Slot service (offline)", () => {
  it("pays inbox invoices and an agent's payout, sweeps earnings, and reconciles to the cent", async () => {
    const cs = await buildCoinSlot({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<Record<string, unknown>>);
    try {
      for (const e of [studioInvoice, designerInvoice]) {
        const item = await post("/v1/inbox", { message_id: e.messageId, from: e.from, subject: e.subject, body: e.body });
        expect(item.status).toBe("awaiting_approval");
        await post(`/v1/inbox/${encodeURIComponent(String(item.id))}/approve`, { approver: "will" });
      }
      const q = await post("/v1/quotes", { amount: "300.00", currency: "EUR", reference: "agent job", payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban: "ES9121000418450200051332" }, bank_country_code: "ES" } });
      await post(String(q.pay_url), undefined, { "x-sim-payer": "0xAgent" });
      for (let i = 0; i < 3; i++) await cs.tick();
      const statuses = cs.svc.book.list().map((p) => p.status);
      expect(statuses).toEqual(["paid", "paid", "paid"]);
      const r = await cs.reconcileNow();
      expect(r.ok).toBe(true);
    } finally {
      server.close();
    }
  });
});
