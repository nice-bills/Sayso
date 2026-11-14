import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { AirwallexError } from "../src/airwallex/client.js";
import { PayoutService, type PayoutRequest } from "../src/payouts/service.js";
import { BatchBook } from "../src/payouts/batch.js";
import { recentEvents } from "../src/events.js";
import { Trail } from "../src/trail.js";
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
  const trail = new Trail(store);
  const svc = new PayoutService({ awx, store, refunder, trail, read: async (t) => heuristicRead(t) });
  return { awx, refunder, store, svc, trail };
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

  it("two payouts in one currency don't both spend the same float", async () => {
    const { awx, svc, store } = setup({ USD: toMinor(5000), EUR: toMinor(282.68) });
    const a = await svc.quote(req());
    const b = await svc.quote(req());
    svc.accept(a.id); svc.accept(b.id);
    const [fa, fb] = await Promise.all([svc.onFunded(a.id, BUYER, "0xfunda"), svc.onFunded(b.id, BUYER, "0xfundb")]);
    expect([fa.status, fb.status]).toEqual(["submitted", "submitted"]);
    expect(store.ops().filter((o) => o.kind === "convert")).toHaveLength(1);
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

describe("a payout stranded in accepted", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const escalations = (id: string) => recentEvents().filter((e) => e.phase === "escalate" && e.detail?.payout === id);
  const withBatches = () => {
    const store = new Store(":memory:");
    let book: BatchBook | undefined;
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(5000), EUR: toMinor(100) }), store, refunder: new FakeRefunder(), read: async (t) => heuristicRead(t), batches: () => book });
    book = new BatchBook(store, svc);
    return { store, svc, book };
  };

  it("says so once when it has been settling for 11 minutes, and changes nothing", async () => {
    const { svc, refunder, trail } = setup();
    const q = await svc.quote(req(), at(12));
    svc.accept(q.id, at(11));
    for (let i = 0; i < 3; i++) await svc.follow(now);
    expect(escalations(q.id)).toHaveLength(1);
    expect(escalations(q.id)[0]!.title).toContain("11 minutes");
    expect(svc.book.get(q.id)!.status).toBe("accepted");
    expect(svc.book.get(q.id)!.fundingTx).toBeNull();
    expect(refunder.refunds).toHaveLength(0);
    expect(trail.for(q.id).filter((s) => s.kind === "escalate")).toHaveLength(1);
    expect(trail.for(q.id).at(-1)!.title).toContain("11 minutes");
  });

  it("leaves a payout accepted a minute ago alone", async () => {
    const { svc, refunder } = setup();
    const q = await svc.quote(req(), at(2));
    svc.accept(q.id, at(1));
    await svc.follow(now);
    await svc.follow(now);
    expect(escalations(q.id)).toHaveLength(0);
    expect(svc.book.get(q.id)!.status).toBe("accepted");
    expect(refunder.refunds).toHaveLength(0);
  });

  it("says so once for a batch stranded the same way", async () => {
    const { svc, book } = withBatches();
    const b = await book.create([req()], "Batch payout", at(12));
    book.accept(b.id, at(11));
    for (let i = 0; i < 3; i++) await svc.follow(now);
    const said = recentEvents().filter((e) => e.phase === "escalate" && e.detail?.batch === b.id);
    expect(said).toHaveLength(1);
    expect(said[0]!.title).toContain("11 minutes");
    expect(book.get(b.id)!.status).toBe("accepted");
    expect(svc.book.get(b.payoutIds[0]!)!.status).toBe("accepted");
  });

  it("starts the rest of a batch whose one payment was recorded before a restart", async () => {
    const { store, svc, book } = withBatches();
    const b = await book.create([req()], "Batch payout", at(12));
    book.accept(b.id, at(11));
    // The crash: the batch recorded its one payment, then the process died before the line loop ran.
    store.db.prepare("UPDATE batches SET status = 'funded', buyer = ?, funding_tx = ? WHERE id = ?").run(BUYER, "0xfundbatch", b.id);
    await svc.follow(now);
    const line = svc.book.get(b.payoutIds[0]!)!;
    expect(line.status).toBe("submitted");
    expect(line.fundingTx).toBe("0xfundbatch#1");
    expect(line.buyer).toBe(BUYER);
    // A second tick finds nothing left to start, so no line is started twice.
    const transferId = line.transferId;
    await svc.follow(now);
    expect(svc.book.get(b.payoutIds[0]!)!.transferId).toBe(transferId);
    expect(escalations(line.id)).toHaveLength(0);
  });
});

describe("recovering stranded payouts", () => {
  const fund = async (svc: PayoutService, buyer: string | null = BUYER) => {
    const q = await svc.quote(req());
    svc.accept(q.id);
    svc.book.transition(q.id, ["accepted"], "funded", { buyer: buyer ?? undefined, fundingTx: "0xf1" });
    return q.id;
  };
  const followUntil = async (svc: PayoutService, id: string, status: string, now = () => new Date()) => {
    for (let i = 0; i < 5 && svc.book.get(id)!.status !== status; i++) await svc.follow(now());
  };

  it("a payout funded but never sent is sent on the next follow", async () => {
    const { svc } = setup();
    const id = await fund(svc);
    await followUntil(svc, id, "paid");
    expect(svc.book.get(id)!.status).toBe("paid");
  });

  it("a transfer Airwallex has but Sayso never recorded is adopted", async () => {
    const { svc, awx } = setup();
    const real = awx.createTransfer;
    let n = 0;
    awx.createTransfer = async (b) => { const t = await real(b); if (n++ < 2) throw new Error("socket hang up"); return t; };
    const look = awx.transferByRequestId;
    let m = 0;
    awx.transferByRequestId = async (id) => { if (m++ < 1) throw new Error("socket hang up"); return look(id); };
    const q = await svc.quote(req());
    expect((await payThrough(svc, q.id)).status).toBe("funded");
    awx.createTransfer = real;
    awx.transferByRequestId = look;
    await followUntil(svc, q.id, "paid");
    expect(svc.book.get(q.id)!.status).toBe("paid");
    // one transfer at the fake: the resend reused the request id
    expect(awx.balances.EUR).toBe(0);
    expect(svc.book.get(q.id)!.transferId).toBe("sim:tfr_1");
  });

  it("a refund that failed is retried and succeeds", async () => {
    const { awx, store, trail } = setup();
    const refunder = { calls: 0, async refund() { if (this.calls++ === 0) throw new Error("rpc timeout"); return { tx: "0xrefund" }; } };
    const svc = new PayoutService({ awx, store, refunder, trail, read: async (t) => heuristicRead(t) });
    const q = await svc.quote(req({}, { iban: "DE02100100109307118603", note: "CLOSED" }));
    await payThrough(svc, q.id);
    await svc.follow();
    await svc.follow();
    expect(svc.book.get(q.id)!.status).toBe("refund_failed");
    await svc.follow(new Date(Date.now() + 11 * 60_000));
    const p = svc.book.get(q.id)!;
    expect(p.status).toBe("refunded");
    expect(p.refundTx).toBe("0xrefund");
  });

  it("a failed payout whose refund never ran is refunded", async () => {
    const { svc, refunder } = setup();
    const id = await fund(svc);
    svc.book.transition(id, ["funded"], "failed", { failure: "bank returned it" });
    await svc.follow();
    expect(svc.book.get(id)!.status).toBe("refunded");
    expect(refunder.refunds).toHaveLength(1);
  });

  it("an owner's own failed invoice is not refunded", async () => {
    const { svc, refunder } = setup();
    const id = await fund(svc, "internal:owner");
    svc.book.transition(id, ["funded"], "failed", { failure: "bank returned it" });
    await svc.follow();
    expect(svc.book.get(id)!.status).toBe("failed");
    expect(refunder.refunds).toHaveLength(0);
  });

  it("a payout with no payer stays refund_failed", async () => {
    const { svc, refunder } = setup();
    const id = await fund(svc, null);
    svc.book.transition(id, ["funded"], "failed", { failure: "x" });
    svc.book.transition(id, ["failed"], "refund_failed", { failure: "x; no payer to refund" });
    await svc.follow(new Date(Date.now() + 11 * 60_000));
    expect(svc.book.get(id)!.status).toBe("refund_failed");
    expect(refunder.refunds).toHaveLength(0);
  });

  it("follow polls submitted payouts beyond the newest 500 rows", async () => {
    const { svc } = setup();
    const q = await svc.quote(req());
    expect((await payThrough(svc, q.id)).status).toBe("submitted");
    const base = svc.book.get(q.id)!;
    for (let i = 0; i < 501; i++) svc.book.insert({ ...base, id: randomUUID(), status: "quoted", createdAt: new Date(Date.now() + 1000 + i).toISOString(), fundingTx: null, transferId: null, buyer: null });
    await followUntil(svc, q.id, "paid");
    expect(svc.book.get(q.id)!.status).toBe("paid");
  });

  it("a follow during a slow refund does not pull a second refund", async () => {
    const { awx, store, trail } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refunder = { calls: 0, async refund() { this.calls++; await gate; return { tx: "0xslow" }; } };
    const svc = new PayoutService({ awx, store, refunder, trail, read: async (t) => heuristicRead(t) });
    const id = await fund(svc);
    const failing = (svc as unknown as { fail(p: unknown, r: string): Promise<unknown> }).fail(svc.book.get(id)!, "bank returned it");
    await svc.follow();
    release();
    await failing;
    expect(refunder.calls).toBe(1);
    expect(svc.book.get(id)!.status).toBe("refunded");
  });

  it("a follow while onFunded is still deciding does not send the payout twice", async () => {
    const { awx, svc, store } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = awx.currentBalances;
    awx.currentBalances = async () => { await gate; return real(); };
    let sends = 0;
    const create = awx.createTransfer;
    awx.createTransfer = async (b) => { sends++; return create(b); };
    const q = await svc.quote(req());
    svc.accept(q.id);
    // An owner's invoice that waits for the float is the path that awaits currentBalances before execute().
    const decision = { verdict: "wait", decidedBy: "balance", reason: "float", until: { fundsUsdzMinor: 1 } };
    store.db.prepare("UPDATE payouts SET decision = ? WHERE id = ?").run(JSON.stringify(decision), q.id);
    const funding = svc.onFunded(q.id, "internal:owner", "0xfund1");
    await new Promise((r) => setTimeout(r, 0));
    await svc.follow();
    release();
    await funding;
    expect(sends).toBe(1);
  });
});
