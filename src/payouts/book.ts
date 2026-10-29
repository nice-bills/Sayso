// The payout book: every quote and payout Sayso has made, in the same SQLite file as the
// rest of the agent's memory. State changes are compare-and-set, so a quote is paid at most once
// even if two requests race for it.
//
//   quoted ──accept──> accepted ──settled on Metal──> funded ──Airwallex──> submitted ──> paid
//      │                  │                             │                        └──> failed ──> refunded
//      ├─> needs_review ──(operator)──> quoted          └──> failed (rejected by Airwallex) ──> refunded
//      ├─> rejected
//      └─> expired                                    funded ──decision was wait──> waiting ──rate back in band, or the wait ends──> funded

import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import type { Decision } from "./decide.js";

export type PayoutStatus = "quoted" | "needs_review" | "rejected" | "accepted" | "funded" | "waiting" | "submitted" | "paid" | "failed" | "refunded" | "refund_failed" | "expired";

export interface Payout {
  id: string;
  buyer: string | null;
  currency: string;
  amountMinor: number;
  method: "LOCAL" | "SWIFT";
  bankCountry: string;
  payeeName: string;
  payeeHash: string;
  beneficiary: Record<string, unknown>;
  reference: string;
  costMinor: number;
  feeMinor: number;
  totalMinor: number;
  rateUsed: number;
  status: PayoutStatus;
  reasons: string[];
  createdAt: string;
  expiresAt: string;
  fundingTx: string | null;
  transferId: string | null;
  refundTx: string | null;
  failure: string | null;
  /** What decide() chose at quote time, and why. Null for payouts made before it existed. */
  decision: Decision | null;
}

/** Identity of the receiving account, so "have we paid this account before?" survives renames. */
export function payeeHash(bankDetails: Record<string, unknown>): string {
  const keys = ["iban", "account_number", "account_routing_value1", "swift_code", "bank_country_code", "account_currency"];
  const canonical = keys.map((k) => String(bankDetails[k] ?? "").replace(/\s+/g, "").toUpperCase()).join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

const COLUMNS: Record<keyof Payout, string> = {
  id: "id", buyer: "buyer", currency: "currency", amountMinor: "amount_minor", method: "method", bankCountry: "bank_country",
  payeeName: "payee_name", payeeHash: "payee_hash", beneficiary: "beneficiary", reference: "reference", costMinor: "cost_minor",
  feeMinor: "fee_minor", totalMinor: "total_minor", rateUsed: "rate_used", status: "status", reasons: "reasons",
  createdAt: "created_at", expiresAt: "expires_at", fundingTx: "funding_tx", transferId: "transfer_id", refundTx: "refund_tx", failure: "failure",
  decision: "decision",
};
const JSON_COLUMNS = new Set<keyof Payout>(["beneficiary", "reasons", "decision"]);

export class PayoutBook {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS payouts (
        id TEXT PRIMARY KEY, buyer TEXT, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, method TEXT NOT NULL,
        bank_country TEXT NOT NULL, payee_name TEXT NOT NULL, payee_hash TEXT NOT NULL, beneficiary TEXT NOT NULL, reference TEXT NOT NULL,
        cost_minor INTEGER NOT NULL, fee_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL, rate_used REAL NOT NULL,
        status TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        funding_tx TEXT UNIQUE, transfer_id TEXT UNIQUE, refund_tx TEXT, failure TEXT
      );
      CREATE TABLE IF NOT EXISTS payees (
        payee_hash TEXT PRIMARY KEY, beneficiary_id TEXT NOT NULL, first_paid_at TEXT
      );`);
    // Books made before decide() existed get the column added.
    const cols = store.db.prepare("PRAGMA table_info(payouts)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "decision")) store.db.exec("ALTER TABLE payouts ADD COLUMN decision TEXT");
  }

  insert(p: Payout): void {
    const cols = Object.values(COLUMNS);
    this.store.db.prepare(`INSERT INTO payouts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.keys(COLUMNS).map((k) => this.encode(k as keyof Payout, p[k as keyof Payout])));
  }

  get(id: string): Payout | undefined {
    return this.decode(this.store.db.prepare("SELECT * FROM payouts WHERE id = ?").get(id));
  }

  byTransferId(transferId: string): Payout | undefined {
    return this.decode(this.store.db.prepare("SELECT * FROM payouts WHERE transfer_id = ?").get(transferId));
  }

  waiting(): Payout[] {
    return this.store.db.prepare("SELECT * FROM payouts WHERE status = 'waiting' ORDER BY created_at").all().map((r) => this.decode(r)!);
  }

  list(limit = 100): Payout[] {
    return this.store.db.prepare("SELECT * FROM payouts ORDER BY created_at DESC LIMIT ?").all(limit).map((r) => this.decode(r)!);
  }

  /** Compare-and-set: moves the payout only if it is in one of `from`. Returns whether it moved. */
  transition(id: string, from: PayoutStatus[], to: PayoutStatus, fields: Partial<Pick<Payout, "buyer" | "fundingTx" | "transferId" | "refundTx" | "failure" | "reasons" | "expiresAt" | "decision">> = {}): boolean {
    const sets = ["status = ?", ...Object.keys(fields).map((k) => `${COLUMNS[k as keyof Payout]} = ?`)];
    const r = this.store.db.prepare(`UPDATE payouts SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`)
      .run(to, ...Object.entries(fields).map(([k, v]) => this.encode(k as keyof Payout, v)), id, ...from);
    return Number(r.changes) === 1;
  }

  /** USD value a buyer has had paid out (or in flight) since `since`. */
  buyerSpentSince(buyer: string, since: Date): number {
    const r = this.store.db.prepare("SELECT COALESCE(SUM(cost_minor),0) AS s FROM payouts WHERE buyer = ? AND created_at >= ? AND status IN ('accepted','funded','waiting','submitted','paid')").get(buyer, since.toISOString()) as { s: number };
    return Number(r.s);
  }

  buyerCountSince(buyer: string, since: Date): number {
    const r = this.store.db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE buyer = ? AND created_at >= ? AND status NOT IN ('rejected','expired')").get(buyer, since.toISOString()) as { n: number };
    return Number(r.n);
  }

  payee(hash: string): { beneficiaryId: string; firstPaidAt: string | null } | undefined {
    const r = this.store.db.prepare("SELECT beneficiary_id, first_paid_at FROM payees WHERE payee_hash = ?").get(hash) as { beneficiary_id: string; first_paid_at: string | null } | undefined;
    return r ? { beneficiaryId: r.beneficiary_id, firstPaidAt: r.first_paid_at } : undefined;
  }

  savePayee(hash: string, beneficiaryId: string): void {
    this.store.db.prepare("INSERT OR IGNORE INTO payees (payee_hash, beneficiary_id) VALUES (?, ?)").run(hash, beneficiaryId);
  }

  markPayeePaid(hash: string, at: Date): void {
    this.store.db.prepare("UPDATE payees SET first_paid_at = COALESCE(first_paid_at, ?) WHERE payee_hash = ?").run(at.toISOString(), hash);
  }

  private encode(k: keyof Payout, v: unknown): string | number | null {
    if (k === "decision") return v ? JSON.stringify(v) : null;
    if (JSON_COLUMNS.has(k)) return JSON.stringify(v ?? (k === "reasons" ? [] : {}));
    return (v ?? null) as string | number | null;
  }

  private decode(r: unknown): Payout | undefined {
    if (!r) return undefined;
    const x = r as Record<string, unknown>;
    const out = {} as Record<string, unknown>;
    for (const [k, col] of Object.entries(COLUMNS)) out[k] = JSON_COLUMNS.has(k as keyof Payout) && x[col] != null ? JSON.parse(String(x[col])) : x[col] ?? null;
    return out as unknown as Payout;
  }
}
