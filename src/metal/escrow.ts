// Escrow on Metal, per payout. An agent's USDZ lands on Sayso's Metal account and stays there until
// its payout is delivered. Only two things can take it out, and Metal enforces both on chain:
//   - the sweep mandate, whose only payee is the off-ramp, and
//   - the refund mandate, capped per refund and in total.
// Sayso releases to the ramp only what delivered payouts earned. USDZ behind a payout still on its
// way (or failed and not yet refunded) is never swept, so a bounce can always be refunded in full.

import type { RampLedger } from "../bridge/ledger.js";
import type { PayoutBook } from "../payouts/book.js";
import type { PayoutStatus } from "../payouts/book.js";

const IN_FLIGHT: PayoutStatus[] = ["accepted", "funded", "submitted", "failed", "refund_failed"];

export interface EscrowView {
  /** USDZ held for payouts still on their way, or waiting on a refund. */
  heldMinor: number;
  heldPayouts: number;
  /** USDZ earned by payouts the bank has confirmed. */
  deliveredMinor: number;
  refundedMinor: number;
  /** Already released to the ramp. */
  sweptMinor: number;
  /** What the sweep may take now: delivered, not yet swept, above the reserve kept for late bounces. */
  releasableMinor: number;
}

export function escrow(book: PayoutBook, ledger: RampLedger, reserveMinor: number): EscrowView {
  // Agents' payments only: the inbox pays from the Airwallex balance and never touches Metal.
  const external = book.list(100_000).filter((p) => p.fundingTx && !p.buyer?.startsWith("internal:"));
  const sum = (ps: typeof external) => ps.reduce((s, p) => s + p.totalMinor, 0);
  const held = external.filter((p) => IN_FLIGHT.includes(p.status));
  const deliveredMinor = sum(external.filter((p) => p.status === "paid"));
  const sweptMinor = ledger.all().filter((x) => x.status !== "rejected").reduce((s, x) => s + x.amountMinor, 0);
  return {
    heldMinor: sum(held), heldPayouts: held.length, deliveredMinor, refundedMinor: sum(external.filter((p) => p.status === "refunded")), sweptMinor,
    releasableMinor: Math.max(0, deliveredMinor - sweptMinor - reserveMinor),
  };
}
