// The off-ramp ledger: the PSP side of Metal's integration golden path, with Airwallex as the PSP.
// 1. record the operation before anything moves;
// 2. credit only a verified, finalized Metal event, keyed `${chainId}:${txHash}:${logIndex}`;
// 3. the UNIQUE constraint on that key makes a second credit impossible, even across restarts.

import { DatabaseSync } from "node:sqlite";

export type SweepStatus = "recorded" | "verified" | "credited" | "rejected";

export interface Sweep {
  operationId: string;
  epoch: string;
  amountMinor: number;
  currency: string;
  status: SweepStatus;
  eventKey: string | null;
  airwallexDepositId: string | null;
  reason: string | null;
}

export class RampLedger {
  private readonly db: DatabaseSync;

  constructor(path = "coinslot.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sweeps (
        operation_id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL UNIQUE,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        event_key TEXT UNIQUE,
        airwallex_deposit_id TEXT,
        reason TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
  }

  /** Step 1. One operation per settlement epoch; recording the same epoch twice returns the existing one. */
  record(operationId: string, epoch: string, amountMinor: number, currency: string): Sweep {
    const existing = this.byEpoch(epoch);
    if (existing) return existing;
    this.db.prepare("INSERT INTO sweeps (operation_id, epoch, amount_minor, currency, status) VALUES (?, ?, ?, ?, 'recorded')").run(operationId, epoch, amountMinor, currency);
    return this.get(operationId)!;
  }

  /** Step 2. Attach the finalized Metal event. Throws if that event already backs another sweep. */
  markVerified(operationId: string, eventKey: string): void {
    this.db.prepare("UPDATE sweeps SET status = 'verified', event_key = ?, updated_at = datetime('now') WHERE operation_id = ? AND status = 'recorded'").run(eventKey, operationId);
  }

  /** Step 3. Credit exactly once: only a verified sweep moves to credited. Returns false if it already was. */
  markCredited(operationId: string, depositId: string): boolean {
    const r = this.db.prepare("UPDATE sweeps SET status = 'credited', airwallex_deposit_id = ?, updated_at = datetime('now') WHERE operation_id = ? AND status = 'verified'").run(depositId, operationId);
    return Number(r.changes) === 1;
  }

  markRejected(operationId: string, reason: string): void {
    this.db.prepare("UPDATE sweeps SET status = 'rejected', reason = ?, updated_at = datetime('now') WHERE operation_id = ? AND status IN ('recorded','verified')").run(reason, operationId);
  }

  get(operationId: string): Sweep | undefined {
    return this.row(this.db.prepare("SELECT * FROM sweeps WHERE operation_id = ?").get(operationId));
  }

  byEpoch(epoch: string): Sweep | undefined {
    return this.row(this.db.prepare("SELECT * FROM sweeps WHERE epoch = ?").get(epoch));
  }

  all(): Sweep[] {
    return this.db.prepare("SELECT * FROM sweeps ORDER BY updated_at").all().map((r) => this.row(r)!);
  }

  /** Total credited to Airwallex, for the reconciliation identity. */
  creditedMinor(currency: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS s FROM sweeps WHERE status = 'credited' AND currency = ?").get(currency) as { s: number };
    return Number(r.s);
  }

  private row(r: unknown): Sweep | undefined {
    if (!r) return undefined;
    const x = r as Record<string, unknown>;
    return {
      operationId: String(x.operation_id),
      epoch: String(x.epoch),
      amountMinor: Number(x.amount_minor),
      currency: String(x.currency),
      status: x.status as SweepStatus,
      eventKey: (x.event_key as string | null) ?? null,
      airwallexDepositId: (x.airwallex_deposit_id as string | null) ?? null,
      reason: (x.reason as string | null) ?? null,
    };
  }
}
