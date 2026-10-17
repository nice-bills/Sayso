// The invoice inbox: forward an invoice, get one question back ("pay €480 to Kreuzberg Studio?"),
// tap yes, and Coin Slot pays it from the business's Airwallex balance.
//
// Nothing pays without the tap. An invoice that asks for new bank details or pushes urgency is
// held, and clearing it takes an explicit "I confirmed these details with the payee" on top.

import type { Store } from "../store.js";
import { emit } from "../events.js";
import { PayoutError, publicView, type PayoutService } from "../payouts/service.js";
import { fmt, toMinor } from "../treasury/money.js";
import { extractInvoice, missingFields, toPayoutRequest, type InboundEmail, type InvoiceFields } from "./extract.js";

export type InboxStatus = "needs_details" | "awaiting_approval" | "needs_verification" | "rejected" | "paying" | "ignored" | "duplicate";

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  fields: InvoiceFields & { extractor?: string };
  missing: string[];
  payoutId: string | null;
  status: InboxStatus;
}

/** Long enough for a person to get round to it. */
const APPROVAL_TTL_MS = 7 * 24 * 3_600_000;

export class Inbox {
  constructor(private readonly store: Store, private readonly svc: PayoutService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, subject TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL,
      fields TEXT NOT NULL, missing TEXT NOT NULL, payout_id TEXT, status TEXT NOT NULL, fingerprint TEXT
    )`);
  }

  async receive(e: InboundEmail): Promise<InboxItem> {
    const existing = this.get(e.messageId);
    if (existing) return existing; // the same email delivered twice
    const fields = await extractInvoice(e);
    const missing = missingFields(fields);
    // The same invoice forwarded twice (or resent by the supplier) must not be paid twice.
    const fingerprint = missing.length ? null : [fields.payeeName, fields.amount, fields.currency, fields.reference, fields.iban ?? fields.accountNumber].join("|").toLowerCase();
    const dup = fingerprint ? (this.store.db.prepare("SELECT id FROM inbox WHERE fingerprint = ? AND status NOT IN ('ignored','rejected')").get(fingerprint) as { id: string } | undefined) : undefined;

    let status: InboxStatus = missing.length ? "needs_details" : dup ? "duplicate" : "awaiting_approval";
    let payoutId: string | null = null;
    if (status === "awaiting_approval") {
      try {
        const p = await this.svc.quote(toPayoutRequest(fields, e), e.receivedAt, { ttlMs: APPROVAL_TTL_MS });
        payoutId = p.id;
        status = p.status === "needs_review" ? "needs_verification" : p.status === "rejected" ? "rejected" : "awaiting_approval";
      } catch (err) {
        if (!(err instanceof PayoutError)) throw err;
        status = "needs_details";
        missing.push(err.message);
      }
    }
    this.store.db.prepare("INSERT INTO inbox (id, sender, subject, received_at, body, fields, missing, payout_id, status, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(e.messageId, e.from, e.subject, e.receivedAt.toISOString(), e.body, JSON.stringify(fields), JSON.stringify(missing), payoutId, status, status === "duplicate" ? null : fingerprint);

    const what = fields.amount && fields.currency ? `${fmt(toMinor(Number(fields.amount)), fields.currency)} to ${fields.payeeName ?? "?"}` : `"${e.subject}"`;
    const line: Record<InboxStatus, string> = {
      awaiting_approval: `Invoice in: pay ${what}? One tap to approve.`,
      needs_verification: `Invoice in: ${what}, but it looks risky. Confirm the bank details with the payee before approving.`,
      needs_details: `Invoice in from ${e.from}, but I couldn't find: ${missing.join(", ")}`,
      rejected: `Invoice in: ${what}. Coin Slot won't pay this one.`,
      duplicate: `Invoice in: ${what} looks like one you already have; not queued again.`,
      paying: "", ignored: "",
    };
    emit(status === "awaiting_approval" ? "decide" : status === "needs_details" ? "observe" : "escalate", line[status], { inbox: e.messageId, extractor: fields.extractor });
    return this.get(e.messageId)!;
  }

  /** The one tap. `verifiedWithPayee` is required to clear a held invoice. */
  async approve(id: string, approver: string, opts: { verifiedWithPayee?: boolean } = {}, now = new Date()): Promise<InboxItem> {
    const item = this.get(id);
    if (!item?.payoutId) throw new PayoutError(404, "nothing to approve");
    if (item.status === "needs_verification") {
      if (!opts.verifiedWithPayee) throw new PayoutError(409, "confirm the bank details with the payee (not by replying to the email) before approving");
      this.svc.approveReview(item.payoutId, approver, now, APPROVAL_TTL_MS);
      emit("decide", `${approver} confirmed the bank details with the payee directly`);
    } else if (item.status !== "awaiting_approval") {
      throw new PayoutError(409, `invoice is ${item.status}`);
    }
    this.setStatus(id, "paying");
    await this.svc.payInternally(item.payoutId, approver, now);
    return this.get(id)!;
  }

  ignore(id: string): InboxItem {
    this.setStatus(id, "ignored");
    return this.get(id)!;
  }

  get(id: string): InboxItem | undefined {
    return this.decode(this.store.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id));
  }

  list(): Array<InboxItem & { payout: ReturnType<typeof publicView> | null }> {
    return this.store.db.prepare("SELECT * FROM inbox ORDER BY received_at DESC LIMIT 200").all().map((r) => {
      const item = this.decode(r)!;
      const p = item.payoutId ? this.svc.book.get(item.payoutId) : undefined;
      return { ...item, payout: p ? publicView(p) : null };
    });
  }

  private setStatus(id: string, status: InboxStatus) {
    this.store.db.prepare("UPDATE inbox SET status = ? WHERE id = ?").run(status, id);
  }

  private decode(r: unknown): InboxItem | undefined {
    if (!r) return undefined;
    const x = r as Record<string, string | null>;
    return {
      id: x.id!, from: x.sender!, subject: x.subject!, receivedAt: x.received_at!, fields: JSON.parse(x.fields!), missing: JSON.parse(x.missing!),
      payoutId: x.payout_id ?? null, status: x.status as InboxStatus,
    };
  }
}
