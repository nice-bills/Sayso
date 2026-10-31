import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { PayoutService } from "../src/payouts/service.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";

const body = (extra: Record<string, unknown> = {}) => ({
  amount: "300.00", currency: "EUR", reference: "split job", part_payment: true,
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban: "ES9121000418450200051332" }, bank_country_code: "ES" },
  ...extra,
});

async function start() {
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { cs, server, call };
}

describe("a split is paid in full, in two parts", () => {
  it("quotes the rest to the same payee once the first part is paid, once, and the agent pays it", async () => {
    const { cs, server, call } = await start();
    const payer = { "x-sim-payer": "0xA9e0000000000000000000000000000000000001" };
    try {
      const q = await call("POST", "/v1/quotes", body({ spendable_usdz: "150.00" }));
      expect(q.body.decision.verdict).toBe("split");
      expect(q.body.remainder.quote_id).toBeNull();
      const firstMinor = toMinor(Number(q.body.amount));
      // Not before the first part is paid for.
      expect((await call("POST", `/v1/payouts/${q.body.id}/remainder`)).status).toBe(409);

      expect((await call("POST", q.body.pay_url, undefined, payer)).status).toBe(202);
      for (let i = 0; i < 3; i++) await cs.tick();
      const rest = await call("POST", `/v1/payouts/${q.body.id}/remainder`);
      expect(rest.status).toBe(201);
      expect(toMinor(Number(rest.body.amount)) + firstMinor).toBe(30000);
      expect(rest.body).toMatchObject({ currency: "EUR", payee: "Etiqueta SL", reference: "split job" });
      expect(rest.body.offer.terms.quote).toBe(rest.body.id);
      // Asking again gives the same quote, not a second one.
      expect((await call("POST", `/v1/payouts/${q.body.id}/remainder`)).body.id).toBe(rest.body.id);
      expect((await call("GET", `/v1/payouts/${q.body.id}`)).body.remainder.quote_id).toBe(rest.body.id);

      expect((await call("POST", rest.body.pay_url, undefined, payer)).status).toBe(202);
      for (let i = 0; i < 3; i++) await cs.tick();
      const paid = [cs.svc.book.get(q.body.id)!, cs.svc.book.get(rest.body.id)!];
      expect(paid.map((p) => p.status)).toEqual(["paid", "paid"]);
      expect(paid.reduce((s, p) => s + p.amountMinor, 0)).toBe(30000);
      // Nothing is left of an unsplit payout.
      expect((await call("POST", `/v1/payouts/${rest.body.id}/remainder`)).status).toBe(409);
    } finally {
      server.close();
    }
  });

  it("won't sell a quote that waits for funds", async () => {
    const { server, call } = await start();
    try {
      const q = await call("POST", "/v1/quotes", body({ spendable_usdz: "10.00", part_payment: false }));
      expect(q.body.decision).toMatchObject({ verdict: "wait", decided_by: "balance" });
      expect(q.body.pay_url).toBeNull();
      const paid = await call("POST", `/v1/payouts/${q.body.id}/pay`, undefined, { "x-sim-payer": "0xA9e0000000000000000000000000000000000001" });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toMatch(/waits for funds/);
    } finally {
      server.close();
    }
  });
});

describe("what an agent can spend is what Metal says it holds", () => {
  it("caps a claimed budget at the address's real USDZ balance", async () => {
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(2000) }), store: new Store(":memory:"), refunder: new FakeRefunder(), balanceOf: async () => toMinor(40) });
    const p = await svc.quote(body({ buyer: "0x00000000000000000000000000000000000000aa", spendable_usdz: "5000.00", part_payment: false }));
    expect(p.decision).toMatchObject({ verdict: "wait", decidedBy: "balance" });
    expect(p.decision!.inputs.spendableUsdzMinor).toBe(toMinor(40));
  });
});
