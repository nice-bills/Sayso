import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { checkFields, extractByPattern } from "../src/inbox/extract.js";
import { Inbox } from "../src/inbox/inbox.js";
import { PayoutService, publicView } from "../src/payouts/service.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";
import { designerInvoice, fakeLandlord, studioInvoice, vagueEmail } from "../samples/invoices.js";

function setup() {
  const store = new Store(":memory:");
  const awx = new FakeAirwallex({ USD: toMinor(2000) });
  const svc = new PayoutService({ awx, store, refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
  return { inbox: new Inbox(store, svc), svc, awx };
}

describe("extractByPattern", () => {
  it("reads European and British invoices", () => {
    expect(extractByPattern(studioInvoice)).toMatchObject({ payeeName: "Kreuzberg Studio GmbH", amount: "280.00", currency: "EUR", reference: "INV-2026-114", iban: "DE89370400440532013000", bankCountry: "DE" });
    expect(extractByPattern(designerInvoice)).toMatchObject({ payeeName: "Holloway Print Ltd", amount: "72.00", currency: "GBP", sortCode: "040568", accountNumber: "10006132", bankCountry: "GB" });
  });
});

describe("extractByPattern amounts", () => {
  it("reads one or two decimals as cents and three digits as thousands", () => {
    expect(extractByPattern({ ...studioInvoice, body: "Total due: EUR 12,5\nIBAN: DE89 3704 0044 0532 0130 00" }).amount).toBe("12.50");
    expect(extractByPattern({ ...studioInvoice, body: "Total due: EUR 1,234\nIBAN: DE89 3704 0044 0532 0130 00" }).amount).toBe("1234.00");
  });
});

describe("checkFields", () => {
  const f = { ...extractByPattern(studioInvoice), iban: "DE89370400440532013000", amount: "480.00", currency: "EUR" };
  it("drops a bank detail that is not in the email, keeps one that is", () => {
    expect(checkFields(f, "pay to DE89 3704 0044 0532 0130 00 please").iban).toBe("DE89370400440532013000");
    expect(checkFields(f, "no bank details here").iban).toBeNull();
  });
  it("nulls a malformed amount or currency, keeps well formed ones", () => {
    expect(checkFields({ ...f, amount: "480", currency: "euros" }, "").amount).toBeNull();
    expect(checkFields({ ...f, amount: "480", currency: "euros" }, "").currency).toBeNull();
    expect(checkFields(f, "").amount).toBe("480.00");
    expect(checkFields(f, "").currency).toBe("EUR");
  });
});

describe("Inbox", () => {
  it("turns an invoice into one approval, then pays it", async () => {
    const { inbox, svc, awx } = setup();
    const item = await inbox.receive(studioInvoice);
    expect(item.status).toBe("awaiting_approval");
    await inbox.approve(item.id, "will");
    await svc.follow();
    await svc.follow();
    expect(svc.book.get(item.payoutId!)?.status).toBe("paid");
    expect(awx.balances.EUR).toBe(0);
  });

  it("does not queue the same invoice twice", async () => {
    const { inbox } = setup();
    await inbox.receive(studioInvoice);
    expect((await inbox.receive(studioInvoice)).status).toBe("awaiting_approval"); // same email: same item
    expect((await inbox.receive({ ...studioInvoice, messageId: "<resent@x>" })).status).toBe("duplicate");
  });

  it("holds a bank-details change until the person confirms with the payee", async () => {
    const { inbox, svc } = setup();
    const item = await inbox.receive(fakeLandlord);
    expect(item.status).toBe("needs_verification");
    await expect(inbox.approve(item.id, "will")).rejects.toThrow(/confirm the bank details/);
    expect(svc.book.get(item.payoutId!)?.status).toBe("needs_review");
    await inbox.approve(item.id, "will", { verifiedWithPayee: true });
    expect(svc.book.get(item.payoutId!)?.status).toBe("submitted");
  });

  it("asks for what it could not find", async () => {
    const { inbox } = setup();
    const item = await inbox.receive(vagueEmail);
    expect(item.status).toBe("needs_details");
    expect(item.missing).toEqual(["payee name", "amount", "currency", "bank country", "bank account"]);
  });

  it("lets a person fill in missing details, then runs the same checks", async () => {
    const { inbox, svc } = setup();
    const item = await inbox.receive(vagueEmail);
    await expect(inbox.approve(item.id, "will")).rejects.toThrow();
    const done = await inbox.complete(item.id, { payeeName: "Kreuzberg Studio GmbH", amount: "120.00", currency: "EUR", bankCountry: "DE", iban: "DE89370400440532013000", addressCountry: "DE", city: "Berlin", bogus: "x" } as never);
    expect(done.status).toBe("awaiting_approval");
    expect(done.missing).toEqual([]);
    expect(svc.book.get(done.payoutId!)?.amountMinor).toBe(12000);
    await expect(inbox.complete(item.id, {})).rejects.toThrow(/awaiting_approval/);
  });

  it("pays once however many times it is tapped", async () => {
    const { inbox } = setup();
    const item = await inbox.receive(studioInvoice);
    const taps = await Promise.allSettled([inbox.approve(item.id, "will"), inbox.approve(item.id, "will")]);
    expect(taps.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(() => inbox.ignore(item.id)).toThrow(/paying/);
  });

  it("names the decision's USDZ cost apart from the payout's fee-inclusive price", async () => {
    const { svc } = setup();
    // An inbox quote decides on Sayso's own float: the fee-exclusive cost, not the fee-inclusive price.
    const p = await svc.quote({
      amount: "140.00", currency: "EUR", reference: "INV-140", due_date: "2026-11-20",
      payee: { name: "Kreuzberg Studio GmbH", address: { country_code: "DE", city: "Berlin", street_address: "Oranienstr. 1", postcode: "10999" }, bank: { iban: "DE89370400440532013000" }, bank_country_code: "DE" },
    }, new Date("2026-11-13T09:00:00Z"), { fromFloat: true });
    const view = publicView(p);
    // The reason quotes the cost, so the decision's field must say cost, never the payout's price_usdz.
    expect(view.decision?.inputs).toHaveProperty("cost_usdz");
    expect(view.decision?.inputs).not.toHaveProperty("price_usdz");
    expect(Number(view.price_usdz)).toBeGreaterThan(Number(view.decision?.inputs.cost_usdz));
    expect(view.decision?.reason).toContain(`${view.decision?.inputs.cost_usdz} USDZ`);
  });
});
