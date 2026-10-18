import { describe, expect, it } from "vitest";
import { heuristicRead } from "../src/agent/reader.js";
import { extractByPattern } from "../src/inbox/extract.js";
import { Inbox } from "../src/inbox/inbox.js";
import { PayoutService } from "../src/payouts/service.js";
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
});
