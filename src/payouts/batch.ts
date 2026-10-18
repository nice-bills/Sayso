// Batch payouts: one agent call pays many people at once, e.g. a marketplace settling its sellers or
// an agent platform paying its contractors. Each line is quoted and checked like a single payout;
// the lines Coin Slot will pay are bundled under one price, paid with one x402 payment, and then
// run as ordinary payouts. A line that bounces is refunded on its own; the rest still go out.

import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import { emit } from "../events.js";
import { toMajor } from "../treasury/money.js";
import { PayoutError, publicView, type PayoutService } from "./service.js";
import type { Payout } from "./book.js";

export const MAX_BATCH = 100;

export type BatchStatus = "quoted" | "rejected" | "accepted" | "funded" | "expired";

export interface Batch {
  id: string;
  reference: string;
  status: BatchStatus;
  /** Lines that will be paid under this batch's price. */
  payoutIds: string[];
  /** Lines held for review or rejected: listed with reasons, never charged for. */
  excluded: Array<{ index: number; payoutId: string | null; status: string; reasons: string[] }>;
  createdAt: string;
  expiresAt: string;
  buyer: string | null;
  fundingTx: string | null;
}

export class BatchBook {
  constructor(private readonly store: Store, private readonly svc: PayoutService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, reference TEXT NOT NULL, status TEXT NOT NULL, payout_ids TEXT NOT NULL, excluded TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, buyer TEXT, funding_tx TEXT
    )`);
  }

  /** Quotes every line. Lines that can't be paid as asked are set aside with their reasons. */
  async create(items: unknown[], reference: string, now = new Date()): Promise<Batch> {
    if (!Array.isArray(items) || items.length === 0) throw new PayoutError(400, "items: at least one payout");
    if (items.length > MAX_BATCH) throw new PayoutError(400, `items: at most ${MAX_BATCH} per batch`);
    const payouts: Payout[] = [];
    const excluded: Batch["excluded"] = [];
    for (const [index, item] of items.entries()) {
      try {
        const p = await this.svc.quote(item, now);
        if (p.status === "quoted") payouts.push(p);
        else excluded.push({ index, payoutId: p.id, status: p.status, reasons: p.reasons });
      } catch (err) {
        if (!(err instanceof PayoutError)) throw err;
        excluded.push({ index, payoutId: null, status: "invalid", reasons: [err.message] });
      }
    }
    const id = randomUUID();
    const expiresAt = payouts.length ? payouts.map((p) => p.expiresAt).sort()[0]! : now.toISOString();
    this.store.db.prepare("INSERT INTO batches (id, reference, status, payout_ids, excluded, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, reference.slice(0, 35), payouts.length ? "quoted" : "rejected", JSON.stringify(payouts.map((p) => p.id)), JSON.stringify(excluded), now.toISOString(), expiresAt);
    const b = this.get(id)!;
    emit("decide", `Batch ${id.slice(0, 8)}: ${payouts.length} of ${items.length} payouts quoted for ${this.priceOf(id, now) ?? "0.00"} USDZ${excluded.length ? `; ${excluded.length} set aside` : ""}`);
    return b;
  }

  /** The batch's price while every line in it can still be paid; otherwise undefined. */
  priceOf(id: string, now = new Date()): string | undefined {
    const b = this.get(id);
    if (!b || b.status !== "quoted") return undefined;
    let total = 0;
    for (const pid of b.payoutIds) {
      const price = this.svc.priceOf(pid, now);
      if (price === undefined) return undefined;
      total += Math.round(Number(price) * 100);
    }
    return toMajor(total).toFixed(2);
  }

  /** Payment verified: lock the batch and every line, or none of them. */
  accept(id: string, now = new Date()): Batch {
    const b = this.get(id);
    if (!b) throw new PayoutError(404, "no such batch");
    if (this.priceOf(id, now) === undefined && b.status === "quoted") {
      this.setStatus(id, ["quoted"], "expired");
      throw new PayoutError(410, "batch quote expired; ask for a new one");
    }
    if (!this.setStatus(id, ["quoted"], "accepted")) throw new PayoutError(409, `batch is ${b.status}`);
    const locked: string[] = [];
    try {
      for (const pid of b.payoutIds) { this.svc.accept(pid, now); locked.push(pid); }
    } catch (err) {
      for (const pid of locked) this.svc.release(pid);
      this.setStatus(id, ["accepted"], "quoted");
      throw err;
    }
    return this.get(id)!;
  }

  /** Settlement failed or was cancelled: everything can be paid again until it expires. */
  release(id: string): void {
    const b = this.get(id);
    if (!b || !this.setStatus(id, ["accepted"], "quoted")) return;
    for (const pid of b.payoutIds) this.svc.release(pid);
  }

  /** Paid on chain: every line runs as its own payout, funded by the one payment. */
  async onFunded(id: string, payer: string, fundingTx: string, now = new Date()): Promise<Batch> {
    const b = this.get(id);
    if (!b) return b!;
    const r = this.store.db.prepare("UPDATE batches SET status = 'funded', buyer = ?, funding_tx = ? WHERE id = ? AND status = 'accepted'").run(payer, fundingTx, id);
    if (Number(r.changes) !== 1) return b;
    emit("observe", `Batch ${id.slice(0, 8)} paid on chain; sending ${b.payoutIds.length} payouts`, {}, fundingTx);
    // One on-chain payment funds every line; each line records it as "<tx>#<n>" because a payment
    // can fund only one payout (funding_tx is unique, so a replayed payment can't pay twice).
    for (const [n, pid] of b.payoutIds.entries()) {
      await this.svc.onFunded(pid, payer, `${fundingTx}#${n + 1}`, now).catch((e) => emit("escalate", `Batch line ${pid.slice(0, 8)} crashed after funding: ${String(e).slice(0, 200)}`));
    }
    return this.get(id)!;
  }

  get(id: string): Batch | undefined {
    const r = this.store.db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!r) return undefined;
    return {
      id: r.id!, reference: r.reference!, status: r.status as BatchStatus, payoutIds: JSON.parse(r.payout_ids!), excluded: JSON.parse(r.excluded!),
      createdAt: r.created_at!, expiresAt: r.expires_at!, buyer: r.buyer ?? null, fundingTx: r.funding_tx ?? null,
    };
  }

  /** What an agent sees: the price, each line's progress, and what was set aside and why. */
  view(id: string) {
    const b = this.get(id);
    if (!b) return undefined;
    const lines = b.payoutIds.map((pid) => publicView(this.svc.book.get(pid)!));
    const counts = lines.reduce<Record<string, number>>((c, l) => ({ ...c, [l.status]: (c[l.status] ?? 0) + 1 }), {});
    return {
      id: b.id, reference: b.reference, status: b.status, price_usdz: this.priceOf(b.id) ?? lines.reduce((s, l) => s + Number(l.price_usdz), 0).toFixed(2),
      expires_at: b.expiresAt, funding_tx: b.fundingTx, progress: counts, payouts: lines, set_aside: b.excluded,
      pay_url: b.status === "quoted" ? `/v1/batches/${b.id}/pay` : null,
    };
  }

  private setStatus(id: string, from: BatchStatus[], to: BatchStatus): boolean {
    const r = this.store.db.prepare(`UPDATE batches SET status = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`).run(to, id, ...from);
    return Number(r.changes) === 1;
  }
}
