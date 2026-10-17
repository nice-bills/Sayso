// One SQLite file holds everything the agent must never forget across restarts:
// operations it started on Airwallex (keyed by request_id), webhook events it has processed,
// and the off-ramp sweeps (see bridge/ledger.ts, which shares this database).

import { DatabaseSync } from "node:sqlite";

export type OpKind = "convert" | "pay" | "card_spend";
export type OpStatus = "pending_approval" | "submitted" | "settled" | "failed" | "ambiguous" | "escalated";

export interface Operation {
  requestId: string;
  obligationId: string;
  kind: OpKind;
  attempt: number;
  status: OpStatus;
  currency: string;
  amountMinor: number;
  airwallexId: string | null;
  detail: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = process.env.COINSLOT_DB ?? "coinslot.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        request_id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        airwallex_id TEXT,
        detail TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (obligation_id, kind, attempt)
      );
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mandate_pulls (
        epoch TEXT PRIMARY KEY,
        tx_hash TEXT,
        outcome TEXT NOT NULL,
        detail TEXT
      );`);
  }

  /** The UNIQUE (obligation, kind, attempt) constraint is the duplicate lock: one live attempt at a time. */
  insertOp(op: Omit<Operation, "airwallexId" | "detail"> & { detail?: string }): void {
    this.db.prepare("INSERT INTO operations (request_id, obligation_id, kind, attempt, status, currency, amount_minor, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(op.requestId, op.obligationId, op.kind, op.attempt, op.status, op.currency, op.amountMinor, op.detail ?? null);
  }

  updateOp(requestId: string, status: OpStatus, airwallexId?: string | null, detail?: string | null): void {
    this.db.prepare("UPDATE operations SET status = ?, airwallex_id = COALESCE(?, airwallex_id), detail = COALESCE(?, detail), updated_at = datetime('now') WHERE request_id = ?")
      .run(status, airwallexId ?? null, detail ?? null, requestId);
  }

  latestOp(obligationId: string, kind: OpKind): Operation | undefined {
    return this.row(this.db.prepare("SELECT * FROM operations WHERE obligation_id = ? AND kind = ? ORDER BY attempt DESC LIMIT 1").get(obligationId, kind));
  }

  opByAirwallexId(id: string): Operation | undefined {
    return this.row(this.db.prepare("SELECT * FROM operations WHERE airwallex_id = ?").get(id));
  }

  ops(): Operation[] {
    return this.db.prepare("SELECT * FROM operations ORDER BY updated_at").all().map((r) => this.row(r)!);
  }

  /** Returns false when the event was already processed (Airwallex delivers at least once). */
  recordEvent(eventId: string, name: string, createdAt: string, body: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO webhook_events (event_id, name, created_at, body) VALUES (?, ?, ?, ?)").run(eventId, name, createdAt, body);
    return Number(r.changes) === 1;
  }

  /** A mandate pull, recorded as soon as its transaction is known, so a lost receipt is re-checked, never re-pulled. */
  recordPull(epoch: string, txHash: string | null, outcome: string, detail?: string): void {
    this.db.prepare("INSERT INTO mandate_pulls (epoch, tx_hash, outcome, detail) VALUES (?, ?, ?, ?) ON CONFLICT(epoch) DO UPDATE SET tx_hash = COALESCE(excluded.tx_hash, tx_hash), outcome = excluded.outcome, detail = excluded.detail")
      .run(epoch, txHash, outcome, detail ?? null);
  }

  pullFor(epoch: string): { txHash: string | null; outcome: string } | undefined {
    const r = this.db.prepare("SELECT tx_hash, outcome FROM mandate_pulls WHERE epoch = ?").get(epoch) as { tx_hash: string | null; outcome: string } | undefined;
    return r ? { txHash: r.tx_hash, outcome: r.outcome } : undefined;
  }

  private row(r: unknown): Operation | undefined {
    if (!r) return undefined;
    const x = r as Record<string, unknown>;
    return {
      requestId: String(x.request_id), obligationId: String(x.obligation_id), kind: x.kind as OpKind, attempt: Number(x.attempt),
      status: x.status as OpStatus, currency: String(x.currency), amountMinor: Number(x.amount_minor),
      airwallexId: (x.airwallex_id as string | null) ?? null, detail: (x.detail as string | null) ?? null,
    };
  }
}
