import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recentEvents } from "../src/events.js";
import { Receipts, type Anchorer } from "../src/metal/receipts.js";
import type { Payout } from "../src/payouts/book.js";
import { Store } from "../src/store.js";

const paid = () => ({ id: randomUUID(), status: "paid", amountMinor: 30000, currency: "EUR", totalMinor: 32000, payeeHash: "h", reference: "r", fundingTx: "0xf", transferId: "t", refundTx: null }) as unknown as Payout;
const t0 = new Date("2026-01-01T00:00:00Z");
const after = (s: number) => new Date(t0.getTime() + s * 1000);

type Run = (n: number, onSent?: (tx: string) => void) => Promise<{ tx: string }>;
/** Scripted anchorer: `run` is called for every anchor. */
function fake(run: Run, confirm?: (tx: string) => Promise<boolean>) {
  const a = { calls: 0, anchor: (_h: string, onSent?: (tx: string) => void) => run(++a.calls, onSent), confirm } as Anchorer & { calls: number };
  return a;
}
const boom: Run = async () => { throw new Error("out of gas"); };
const rowTx = (r: Receipts, p: Payout) => r.get(p.id)[0]!.tx;

describe("receipt anchoring", () => {
  it("backs off after a failure and doesn't retry early", async () => {
    const a = fake(boom);
    const r = new Receipts(new Store(":memory:"), a);
    await r.issue(paid(), t0);
    expect(a.calls).toBe(1);
    await r.retry(after(30));
    expect(a.calls).toBe(1);
    await r.retry(after(61));
    expect(a.calls).toBe(2);
  });

  it("never sends a second anchor once one was broadcast", async () => {
    const a = fake(async (_n, onSent) => { onSent?.("0xabc"); throw new Error("wait timed out"); }, async () => true);
    const r = new Receipts(new Store(":memory:"), a);
    const p = paid();
    await r.issue(p, t0);
    await r.retry(after(61));
    expect(a.calls).toBe(1);
    expect(rowTx(r, p)).toBe("0xabc");
  });

  it("resends when the broadcast one reverted", async () => {
    const a = fake(async (n, onSent) => {
      if (n === 1) { onSent?.("0xabc"); throw new Error("wait timed out"); }
      return { tx: "0xdef" };
    }, async () => false);
    const r = new Receipts(new Store(":memory:"), a);
    const p = paid();
    await r.issue(p, t0);
    await r.retry(after(61));
    expect(a.calls).toBe(2);
    expect(rowTx(r, p)).toBe("0xdef");
  });

  it("escalates once on the fifth failure", async () => {
    const r = new Receipts(new Store(":memory:"), fake(boom));
    const p = paid();
    await r.issue(p, t0);
    for (let i = 1; i <= 6; i++) await r.retry(after(i * 3700));
    const hits = recentEvents().filter((e) => e.phase === "escalate" && e.detail?.payout === p.id && e.title.includes("5 tries"));
    expect(hits).toHaveLength(1);
  });

  it("one anchor at a time per receipt", async () => {
    const a = fake(async () => { await new Promise((res) => setTimeout(res, 5)); return { tx: "0x1" }; });
    const r = new Receipts(new Store(":memory:"), a);
    // issue inserts the row before it awaits, so retry sees it while issue is in flight.
    await Promise.all([r.issue(paid()), r.retry()]);
    expect(a.calls).toBe(1);
  });
});
