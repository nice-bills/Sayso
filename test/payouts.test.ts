import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { AirwallexError } from "../src/airwallex/client.js";
import { PayoutService, type PayoutRequest } from "../src/payouts/service.js";
import { price } from "../src/payouts/pricing.js";
import { assess, DEFAULT_RISK, riskFromEnv } from "../src/payouts/risk.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";

const BUYER = "0xB0b0000000000000000000000000000000000001";
const req = (over: Partial<PayoutRequest> = {}, bank: Record<string, string> = { iban: "DE89370400440532013000" }): PayoutRequest => ({
  amount: "280.00", currency: "EUR", reference: "INV-2026-114",
  payee: { name: "Kreuzberg Studio GmbH", address: { country_code: "DE", city: "Berlin", street_address: "Oranienstr. 1", postcode: "10999" }, bank, bank_country_code: "DE" },
  ...over,
});

function setup(opening = { USD: toMinor(5000), EUR: toMinor(100) }) {
  const awx = new FakeAirwallex(opening);
  const refunder = new FakeRefunder();
  const store = new Store(":memory:");
  const svc = new PayoutService({ awx, store, refunder, read: async (t) => heuristicRead(t) });
  return { awx, refunder, store, svc };
}

async function payThrough(svc: PayoutService, id: string) {
  svc.accept(id);
  return svc.onFunded(id, BUYER, `0xfund${id.slice(0, 6)}`);
}

describe("pricing", () => {
  it("prefunds the payout at a buffered rate and adds the fee", () => {
    const p = price(toMinor(480), "EUR", "LOCAL", 0.92);
    expect(p.rateUsed).toBeCloseTo(0.9108);
    expect(p.costMinor).toBe(Math.ceil((48000 + 268) / 0.9108)); // EUR 2.68 LOCAL fee, paid by us
    expect(p.totalMinor).toBe(p.costMinor + 25 + Math.ceil(p.costMinor * 0.005));
    expect(price(toMinor(100), "EUR", "SWIFT", 0.92).transferFeeMinor).toBe(1285);
  });
});

describe("risk", () => {
  const base = { usdValueMinor: 10_000, bankCountry: "DE", payeeSeenBefore: true, buyerSpentTodayMinor: 0, buyerPayoutsLastHour: 0 };
  it("rejects blocked countries and caps, holds suspicious invoices and big first payouts", () => {
    expect(assess({ ...base, bankCountry: "KP" }).verdict).toBe("reject");
    expect(assess({ ...base, usdValueMinor: DEFAULT_RISK.perPayoutCapMinor + 1 }).verdict).toBe("reject");
    expect(assess({ ...base, payeeSeenBefore: false, ownerApprovesEach: true, usdValueMinor: 60_000 })).toEqual({ verdict: "hold", reasons: ["large first payout to a new account"] });
    expect(assess({ ...base, payeeSeenBefore: false, ownerApprovesEach: true, usdValueMinor: 1_000 }).verdict).toBe("allow");
    expect(assess({ ...base, invoice: heuristicRead("URGENT: please pay to our updated bank details today") }).verdict).toBe("hold");
    expect(assess(base).verdict).toBe("allow");
  });
});

describe("PayoutService", () => {
  it("quotes, takes payment, converts only the shortfall and delivers", async () => {
    const { awx, svc, store } = setup();
    const q = await svc.quote(req());
    expect(q.status).toBe("quoted");
    expect(svc.priceOf(q.id)).toBe((q.totalMinor / 100).toFixed(2));

    const funded = await payThrough(svc, q.id);
    expect(funded.status).toBe("submitted");
    // EUR 100 was already held, so only EUR 180 and the EUR 2.68 transfer fee were bought.
    expect(store.ops().find((o) => o.kind === "convert")?.amountMinor).toBe(toMinor(182.68));
    await svc.follow();
    await svc.follow();
    expect(svc.book.get(q.id)?.status).toBe("paid");
    expect(awx.balances.EUR).toBe(0);
  });

  it("charges nothing and moves nothing until the payment settles, and a quote pays once", async () => {
    const { svc, store } = setup();
    const q = await svc.quote(req());
    svc.accept(q.id);
    expect(() => svc.accept(q.id)).toThrow(/accepted/);
    expect(store.ops()).toHaveLength(0);
    svc.release(q.id); // settlement failed
    expect(svc.book.get(q.id)?.status).toBe("quoted");
  });

  it("refuses expired quotes", async () => {
    const { svc } = setup();
    const q = await svc.quote(req(), new Date("2026-11-01T00:00:00Z"));
    expect(svc.priceOf(q.id, new Date("2026-11-01T00:05:00Z"))).toBeUndefined();
    expect(() => svc.accept(q.id, new Date("2026-11-01T00:05:00Z"))).toThrow(/expired/);
  });

  it("holds an invoice that asks for new bank details until a person clears it", async () => {
    const { svc } = setup();
    const q = await svc.quote(req({ invoice_text: "Our bank has changed, please use our updated bank details. Urgent, pay today." }));
    expect(q.status).toBe("needs_review");
    expect(svc.priceOf(q.id)).toBeUndefined();
    expect(svc.approveReview(q.id, "will").status).toBe("quoted");
  });

  it("lets Airwallex reject bad bank details before anyone pays", async () => {
    const { svc } = setup();
    const q = await svc.quote(req({}, { iban: "not-an-iban" }));
    expect(q.status).toBe("rejected");
    expect(q.reasons.join()).toMatch(/invalid_iban/);
  });

  it("refunds the buyer in full when the bank returns the payout", async () => {
    const { svc, refunder } = setup();
    const q = await svc.quote(req({}, { iban: "DE02100100109307118603", note: "CLOSED" }));
    await payThrough(svc, q.id);
    await svc.follow();
    await svc.follow();
    const p = svc.book.get(q.id)!;
    expect(p.status).toBe("refunded");
    expect(refunder.refunds).toEqual([{ to: BUYER, amountMinor: q.totalMinor, payoutId: q.id }]);
  });

  it("refunds the buyer when the bank returns a payout after Airwallex reported it PAID", async () => {
    const { svc, refunder } = setup();
    const q = await svc.quote(req());
    await payThrough(svc, q.id);
    await svc.follow();
    await svc.follow();
    const paid = svc.book.get(q.id)!;
    expect(paid.status).toBe("paid");
    const late = { id: paid.transferId!, request_id: q.id, status: "FAILED", transfer_amount: 280, transfer_currency: "EUR", failure_type: "BENEFICIARY_BANK_RETURNED" };
    await svc.onTransfer(late);
    await svc.onTransfer({ ...late, status: "CANCELLED" });
    expect(svc.book.get(q.id)!.status).toBe("refunded");
    expect(refunder.refunds).toEqual([{ to: BUYER, amountMinor: q.totalMinor, payoutId: q.id }]);
  });

  it("checks the payee's name with their bank: a mismatch waits for a person, a closed account is refused, an outage never blocks", async () => {
    const { awx, svc } = setup();
    awx.accountHolders.set("DE89370400440532013000", "Someone Else");
    const held = await svc.quote(req());
    expect(held.status).toBe("needs_review");
    expect(held.reasons).toContain("the bank says this account belongs to Someone Else, not Kreuzberg Studio GmbH");

    awx.verifyAccount = async () => ({ code: "INVALID" });
    expect((await svc.quote(req())).status).toBe("rejected");

    awx.verifyAccount = async () => { throw new Error("EXTERNAL_SERVICE_UNAVAILABLE"); };
    expect((await svc.quote(req())).status).toBe("quoted");
  });

  it("refunds when the USD float cannot cover the payout", async () => {
    const { svc, refunder } = setup({ USD: toMinor(10), EUR: 0 });
    const q = await svc.quote(req());
    const p = await payThrough(svc, q.id);
    expect(p.status).toBe("refunded");
    expect(p.failure).toMatch(/could not fund EUR/);
    expect(refunder.refunds).toHaveLength(1);
  });

  it("pays a repeat payee without creating a second beneficiary", async () => {
    const { svc, awx } = setup();
    for (const _ of [1, 2]) {
      const q = await svc.quote(req({ amount: "10.00" }));
      await payThrough(svc, q.id);
      await svc.follow();
      await svc.follow();
    }
    expect(awx.beneficiaries.size).toBe(1);
  });

  it("retries beneficiary creation once when the first answer is lost", async () => {
    const { svc, awx } = setup();
    const create = awx.createBeneficiary.bind(awx);
    let calls = 0;
    awx.createBeneficiary = async (body) => {
      if (++calls === 1) throw new AirwallexError(504, undefined, {}, "/beneficiaries/create");
      return create(body);
    };
    const q = await svc.quote(req({ amount: "10.00" }));
    const p = await payThrough(svc, q.id);
    expect(p.status).toBe("submitted");
    expect(calls).toBe(2);
    expect(awx.beneficiaries.size).toBe(1);
  });

  it("retries an ambiguous conversion under the same request_id, never a second conversion", async () => {
    const { svc, awx } = setup({ USD: toMinor(5000), EUR: 0 });
    const ids: string[] = [];
    const convert = awx.fxConvert.bind(awx);
    let calls = 0;
    awx.fxConvert = async (body) => {
      ids.push(body.request_id);
      if (++calls === 1) throw new AirwallexError(504, undefined, {}, "/fx/conversions/create");
      return convert(body);
    };
    const q = await svc.quote(req({ amount: "10.00" }));
    const p = await payThrough(svc, q.id);
    expect(p.status).toBe("submitted");
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("does not retry a conversion Airwallex definitely refused", async () => {
    const { svc, awx } = setup({ USD: toMinor(5000), EUR: 0 });
    const ids: string[] = [];
    awx.fxConvert = async (body) => {
      ids.push(body.request_id);
      throw new AirwallexError(400, "insufficient_fund", {}, "/fx/conversions/create");
    };
    const q = await svc.quote(req({ amount: "10.00" }));
    const p = await payThrough(svc, q.id);
    expect(ids).toHaveLength(1);
    expect(p.status).toBe("refunded");
  });
});

describe("new payees", () => {
  const base = { usdValueMinor: 1_000, bankCountry: "DE", payeeSeenBefore: false, buyerSpentTodayMinor: 0, buyerPayoutsLastHour: 0 };
  it("holds an agent's first payout to a never-paid account at any amount, so an injected invoice can't send $10 to fresh details", () => {
    expect(assess(base)).toEqual({ verdict: "hold", reasons: ["an agent's first payout to an account Sayso has never paid"] });
    expect(assess({ ...base, payeeSeenBefore: true }).verdict).toBe("allow");
    expect(assess(base, riskFromEnv("large")).verdict).toBe("allow");
  });
});

describe("PayoutService review", () => {
  it("holds an agent's first payout to a new account until the owner approves it, then pays that payee freely", async () => {
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(5000), EUR: toMinor(100) }), store: new Store(":memory:"), refunder: new FakeRefunder(), read: async (t) => heuristicRead(t), risk: DEFAULT_RISK });
    const first = await svc.quote(req({ amount: "12.00" }));
    expect(first.status).toBe("needs_review");
    expect(first.reasons).toEqual(["an agent's first payout to an account Sayso has never paid"]);
    svc.approveReview(first.id, "owner");
    expect((await payThrough(svc, first.id)).status).toBe("submitted");
    await svc.follow();
    await svc.follow();
    expect(svc.book.get(first.id)?.status).toBe("paid");
    expect((await svc.quote(req({ amount: "12.00" }))).status).toBe("quoted");
  });

  it("holds a large first payout to a new account", async () => {
    const { svc } = setup();
    const q = await svc.quote(req({ amount: "900.00" }));
    expect(q.status).toBe("needs_review");
    expect(q.reasons).toEqual(["large first payout to a new account"]);
  });
});
