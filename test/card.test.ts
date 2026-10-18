import { describe, expect, it } from "vitest";
import { AgentCard, DEFAULT_CARD_POLICY, reviewCardTransaction, type CardTransaction } from "../src/airwallex/card.js";
import { FakeAirwallex } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";

const tx = (over: Partial<CardTransaction> = {}): CardTransaction => ({
  id: "itx_1", card_id: "card_1", amountMinor: 4200, currency: "USD", merchantName: "ANTHROPIC PBC", mcc: "7372", status: "APPROVED", ...over,
});

describe("reviewCardTransaction", () => {
  it("accepts an expected compute bill", () => {
    expect(reviewCardTransaction(tx(), DEFAULT_CARD_POLICY, 0)).toEqual({ verdict: "ok" });
  });

  it("freezes on an unknown merchant, a wrong category or the monthly limit", () => {
    expect(reviewCardTransaction(tx({ merchantName: "LUXURY WATCHES" }), DEFAULT_CARD_POLICY, 0).verdict).toBe("freeze");
    expect(reviewCardTransaction(tx({ mcc: "5944" }), DEFAULT_CARD_POLICY, 0).verdict).toBe("freeze");
    expect(reviewCardTransaction(tx(), DEFAULT_CARD_POLICY, DEFAULT_CARD_POLICY.monthlyMinor - 100).verdict).toBe("freeze");
  });
});

describe("AgentCard", () => {
  it("records good spend once and freezes the card on a bad one", async () => {
    const frozen: string[] = [];
    const awx = {
      createCardholder: async () => ({ cardholder_id: "ch_1" }),
      createCard: async () => ({ card_id: "card_1" }),
      updateCard: async (id: string) => { frozen.push(id); return {}; },
      simulateCardAuth: async () => ({ card_transaction_id: "itx", card_id: "card_1", process_result: "APPROVED", transaction_amount: 1, transaction_currency: "USD" }),
    };
    const store = new Store(":memory:");
    const card = new AgentCard(awx, store, DEFAULT_CARD_POLICY, "card_1");
    const now = new Date("2026-11-03T10:00:00Z");
    await card.onTransaction(tx(), now);
    await card.onTransaction(tx(), now); // redelivered event
    expect(card.spentThisMonthMinor(now)).toBe(4200);
    expect((await card.onTransaction(tx({ id: "itx_2", amountMinor: 900, merchantName: "UNKNOWN LLC" }), now)).verdict).toBe("freeze");
    expect(frozen).toEqual(["card_1"]);
    // The money left even though the card froze, so the books count it.
    expect(card.spentThisMonthMinor(now)).toBe(5100);
  });

  it("pays a compute bill, lets Airwallex decline a blocked category, and stops after a freeze", async () => {
    const awx = new FakeAirwallex({ USD: toMinor(1000) });
    const card = new AgentCard(awx, new Store(":memory:"));
    await card.issue("agent@sayso.example", "Sayso Agent");
    expect((await card.simulateBill("ANTHROPIC PBC", "7372", toMinor(42))).verdict).toBe("ok");
    expect((await card.simulateBill("LUXURY WATCHES", "5944", toMinor(150))).verdict).toBe("declined");
    expect((await card.simulateBill("GPU RESELLER", "7372", toMinor(90))).verdict).toBe("freeze");
    expect((await card.simulateBill("ANTHROPIC PBC", "7372", toMinor(5))).verdict).toBe("declined");
    expect(awx.balances.USD).toBe(toMinor(1000 - 42 - 90));
  });
});
