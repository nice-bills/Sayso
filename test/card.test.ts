import { describe, expect, it } from "vitest";
import { AgentCard, DEFAULT_CARD_POLICY, reviewCardTransaction, type CardTransaction } from "../src/airwallex/card.js";
import { Store } from "../src/store.js";

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

describe("AgentCard.onTransaction", () => {
  it("records good spend once and freezes the card on a bad one", async () => {
    const frozen: string[] = [];
    const awx = {
      createCardholder: async () => ({ cardholder_id: "ch_1" }),
      createCard: async () => ({ card_id: "card_1" }),
      updateCard: async (id: string) => { frozen.push(id); return {}; },
      simulateCardAuth: async () => ({ transaction_id: "itx" }),
    };
    const store = new Store(":memory:");
    const card = new AgentCard(awx, store, DEFAULT_CARD_POLICY, "card_1");
    const now = new Date("2026-11-03T10:00:00Z");
    await card.onTransaction(tx(), now);
    await card.onTransaction(tx(), now); // redelivered event
    expect(card.spentThisMonthMinor(now)).toBe(4200);
    expect((await card.onTransaction(tx({ id: "itx_2", merchantName: "UNKNOWN LLC" }), now)).verdict).toBe("freeze");
    expect(frozen).toEqual(["card_1"]);
  });
});
