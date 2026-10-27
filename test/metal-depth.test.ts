import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSayso, SIM_PAY_TO } from "../src/app.js";
import { escrow } from "../src/metal/escrow.js";
import { anchorData, hashReceipt, receiptOf, verifyAnchor, type Receipt } from "../src/metal/receipts.js";
import { RampLedger } from "../src/bridge/ledger.js";
import { toMinor } from "../src/treasury/money.js";

const quoteBody = (iban = "ES9121000418450200051332", amount = "300.00") => ({
  amount, currency: "EUR", reference: "agent job",
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban }, bank_country_code: "ES" },
});

async function start(policy?: string) {
  if (policy) process.env.SAYSO_AGENT_MANDATES = policy;
  else delete process.env.SAYSO_AGENT_MANDATES;
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const get = async (path: string) => (await fetch(base + path, { headers: { authorization: `Bearer ${cs.ownerToken}` } })).json() as Promise<Record<string, any>>;
  return { cs, server, post, get };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

afterEach(() => { delete process.env.SAYSO_AGENT_MANDATES; });

describe("an agent's budget, bound by its owner on Metal", () => {
  it("with mandates required, refuses a payment from a bare key and takes one under the owner's mandate", async () => {
    const { cs, server, post, get } = await start("required");
    try {
      cs.simMandates!.bind("0xmandate1", { principal: "0xOwnerAccount", capCents: toMinor(400), budgetCents: toMinor(700) });
      const q = await post("/v1/quotes", quoteBody());
      const bare = await post(q.body.pay_url, undefined, { "x-sim-payer": "0xAgent" });
      expect(bare.status).toBe(402);
      expect(bare.body.error).toMatch(/mandate_required/);
      expect(cs.svc.book.get(q.body.id)!.status).toBe("quoted"); // nothing moved

      const paid = await post(q.body.pay_url, undefined, { "x-sim-mandate": "0xmandate1", "x-sim-signed-order": "sim" });
      expect(paid.status).toBe(202);
      await settle();
      expect(cs.svc.book.get(q.body.id)!.buyer).toBe("0xOwnerAccount"); // the owner's account paid, not the agent

      const why = await get(`/v1/payouts/${q.body.id}/why`);
      const m = why.steps.find((s: { kind: string }) => s.kind === "mandate");
      expect(m.title).toMatch(/Sayso only/);
      expect(m.title).toMatch(/signed this exact order/);
      expect(m.detail.limits.payees).toEqual([SIM_PAY_TO]);
      expect(Number(m.detail.left_usdz)).toBeLessThan(700);
    } finally {
      server.close();
    }
  });

  it("refuses what Metal would refuse: above the cap, or past the budget", async () => {
    const { cs, server, post } = await start("required");
    try {
      cs.simMandates!.bind("0xsmall", { principal: "0xOwner", capCents: toMinor(100), budgetCents: toMinor(1000) });
      const big = await post("/v1/quotes", quoteBody());
      const r = await post(big.body.pay_url, undefined, { "x-sim-mandate": "0xsmall" });
      expect(r.status).toBe(402);
      expect(r.body.error).toMatch(/mandate_cap_exceeded/);

      cs.simMandates!.bind("0xtight", { principal: "0xOwner", capCents: toMinor(400), budgetCents: toMinor(400) });
      const one = await post("/v1/quotes", quoteBody());
      expect((await post(one.body.pay_url, undefined, { "x-sim-mandate": "0xtight" })).status).toBe(202);
      const two = await post("/v1/quotes", quoteBody("ES7921000813610123456789"));
      const refused = await post(two.body.pay_url, undefined, { "x-sim-mandate": "0xtight" });
      expect(refused.body.error).toMatch(/mandate_budget_exceeded/);
    } finally {
      server.close();
    }
  });

  it("by default still takes payments from an agent's own key", async () => {
    const { server, post } = await start();
    try {
      const q = await post("/v1/quotes", quoteBody());
      expect((await post(q.body.pay_url, undefined, { "x-sim-payer": "0xAgent" })).status).toBe(202);
    } finally {
      server.close();
    }
  });
});

describe("escrow: only delivered payouts leave", () => {
  it("holds an agent's USDZ while its payout is on the way, and releases it once delivered", async () => {
    const { cs, server, post } = await start();
    process.env.SAYSO_REFUND_RESERVE_USDZ = "0";
    try {
      const q = await post("/v1/quotes", quoteBody());
      await post(q.body.pay_url, undefined, { "x-sim-payer": "0xAgent" });
      await settle();
      const ledger = new RampLedger(":memory:");
      const inFlight = escrow(cs.svc.book, ledger, 0);
      expect(inFlight.heldPayouts).toBe(1);
      expect(inFlight.releasableMinor).toBe(0);

      await cs.svc.follow();
      await cs.svc.follow();
      const done = escrow(cs.svc.book, ledger, 0);
      expect(done.heldMinor).toBe(0);
      expect(done.releasableMinor).toBe(cs.svc.book.get(q.body.id)!.totalMinor);
    } finally {
      delete process.env.SAYSO_REFUND_RESERVE_USDZ;
      server.close();
    }
  });
});

describe("receipts anchored on Metal", () => {
  it("issues a receipt for a delivered payout, and another when a bounce refunds it", async () => {
    const { cs, server, post } = await start();
    try {
      const good = await post("/v1/quotes", quoteBody());
      await post(good.body.pay_url, undefined, { "x-sim-payer": "0xAgent" });
      const bad = await post("/v1/quotes", quoteBody("ES1000750080110600658108"));
      (cs.awx as unknown as { failMarker: string }).failMarker = "ES1000750080110600658108";
      await post(bad.body.pay_url, undefined, { "x-sim-payer": "0xAgent" });
      await settle();
      for (let i = 0; i < 3; i++) await cs.tick();
      await settle();

      const r = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/payouts/${good.body.id}/receipt`)).json() as { anchors: Array<{ receipt: Receipt; hash: string; tx: string }> };
      expect(r.anchors).toHaveLength(1);
      expect(r.anchors[0]!.receipt.status).toBe("paid");
      expect(hashReceipt(r.anchors[0]!.receipt)).toBe(r.anchors[0]!.hash); // anyone can recompute it
      expect(r.anchors[0]!.tx).toMatch(/^sim:0x/);
      expect(JSON.stringify(r)).not.toContain("ES9121"); // never the bank details

      expect(cs.svc.book.get(bad.body.id)!.status).toBe("refunded");
      expect(cs.receipts.get(bad.body.id).map((a) => a.status)).toEqual(["refunded"]);
    } finally {
      server.close();
    }
  });

  it("verifies an anchor from the chain: right sender, success, and this hash", async () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    const me = "0x1111111111111111111111111111111111111111" as const;
    const chain = (input: string, from: string = me, status = "success") => ({
      getTransaction: async () => ({ input, from }), getTransactionReceipt: async () => ({ status }),
    }) as never;
    expect(await verifyAnchor(chain(anchorData(hash)), "0x01", hash, me)).toEqual({ ok: true });
    expect((await verifyAnchor(chain(anchorData(`0x${"cd".repeat(32)}`)), "0x01", hash, me)).ok).toBe(false);
    expect((await verifyAnchor(chain(anchorData(hash), "0x2222222222222222222222222222222222222222"), "0x01", hash, me)).problem).toMatch(/not Sayso/);
    expect((await verifyAnchor(chain(anchorData(hash), me, "reverted"), "0x01", hash, me)).ok).toBe(false);
  });

  it("will not issue a receipt for a payout that is not final", () => {
    expect(() => receiptOf({ id: "x", status: "submitted" } as never)).toThrow(/not final/);
  });
});

describe("why a payment happened", () => {
  it("keeps every step of a quote: what Claude read, the risk rules, what the bank said", async () => {
    const { server, post, get } = await start();
    try {
      const q = await post("/v1/quotes", { ...quoteBody(), invoice_text: "Invoice 1042 from Etiqueta SL. Total due EUR 300.00." });
      const why = await get(`/v1/payouts/${q.body.id}/why`);
      const kinds = why.steps.map((s: { kind: string }) => s.kind);
      expect(kinds).toEqual(expect.arrayContaining(["read", "risk", "payee", "decide"]));
    } finally {
      server.close();
    }
  });
});
