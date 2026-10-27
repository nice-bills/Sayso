// The one-cent code check, for an invoice that asks to pay new bank details.
//
//   1. Sayso pays 0.01 through Airwallex to the NEW account, with a 6-digit code in the reference.
//      Only whoever owns that account sees the code, on their statement.
//   2. Sayso emails the payee at the address it already has on file from an invoice it paid before,
//      never the address the new invoice came from, asking for that code.
//   3. The right code from that link lifts the hold; the owner then pays with one tap. Three wrong
//      codes, or "these aren't our details", and the invoice stays blocked.
//
// A fraudster with a lookalike address never sees the email on file, so the check fails. It does not
// protect against a payee whose own mailbox is compromised: for that, the owner still calls them.

import { createHash, randomInt, randomUUID } from "node:crypto";
import type { PayoutAirwallex } from "../payouts/service.js";
import { PayoutError, type PayoutService } from "../payouts/service.js";
import type { Store } from "../store.js";
import { emit } from "../events.js";
import type { Inbox, InboxItem } from "./inbox.js";

export type PennyStatus = "sent" | "confirmed" | "denied" | "failed";

export interface PennyCheck {
  id: string;
  inboxId: string;
  payoutId: string;
  contact: string;
  status: PennyStatus;
  attempts: number;
  transferId: string | null;
  createdAt: string;
  /** Offline only: what the payee's bank statement would show, so a demo can play the payee. */
  simStatementReference?: string;
}

const MAX_ATTEMPTS = 3;
const TTL_MS = 3 * 24 * 3_600_000;
const hashCode = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");
const addressOf = (from: string) => from.match(/<([^>]+)>/)?.[1]?.trim() ?? (from.includes("@") ? from.trim() : null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type SendEmail = (to: string, subject: string, text: string) => Promise<void>;

export class PennyChecks {
  constructor(private readonly d: {
    store: Store; svc: PayoutService; inbox: Inbox; awx: Pick<PayoutAirwallex, "createBeneficiary" | "createTransfer">;
    send?: SendEmail; publicUrl?: string; offline: boolean;
  }) {
    d.store.db.exec(`CREATE TABLE IF NOT EXISTS penny_checks (
      id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL, payout_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL,
      contact TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, transfer_id TEXT, created_at TEXT NOT NULL, sim_reference TEXT
    )`);
  }

  /** Where Sayso would reach this payee: the sender of an invoice it already paid them. */
  contactOnFile(payeeName: string): string | undefined {
    const paid = this.d.inbox.list().find((i) => i.payout?.status === "paid" && i.fields.payeeName && norm(i.fields.payeeName) === norm(payeeName) && addressOf(i.from));
    return paid ? addressOf(paid.from)! : undefined;
  }

  async start(inboxId: string, now = new Date()): Promise<PennyCheck> {
    const item = this.d.inbox.get(inboxId);
    if (!item?.payoutId) throw new PayoutError(404, "no such invoice");
    if (item.status !== "needs_verification") throw new PayoutError(409, "only an invoice on hold needs this check");
    const open = this.forInbox(inboxId);
    if (open && (open.status === "sent" || open.status === "confirmed")) return open;
    if (open?.status === "denied") throw new PayoutError(409, "The payee said these are not their bank details. Don't pay this invoice.");
    const payee = item.fields.payeeName ?? "";
    const contact = this.contactOnFile(payee);
    if (!contact) throw new PayoutError(409, `Sayso has never paid ${payee || "this payee"}, so it has no contact on file to ask. Call them on a number you already had.`);
    const p = this.d.svc.book.get(item.payoutId)!;

    const id = randomUUID();
    const code = String(randomInt(100_000, 1_000_000));
    const token = randomUUID().replaceAll("-", "");
    const reference = `SAYSO CODE ${code}`;
    // The cent goes to the new account, like any payout: Airwallex checks the details, and request_id makes it once-only.
    const ben = await this.d.awx.createBeneficiary({ beneficiary: p.beneficiary, transfer_methods: [p.method], nickname: `Check ${payee}`.slice(0, 50) });
    const t = await this.d.awx.createTransfer({
      request_id: `penny-${id}`, beneficiary_id: ben.id, transfer_amount: "0.01", transfer_currency: p.currency, transfer_method: p.method,
      reference, source_currency: p.currency, reason: "business_expenses",
    });
    this.d.store.db.prepare("INSERT INTO penny_checks (id, inbox_id, payout_id, token, code_hash, contact, status, transfer_id, created_at, sim_reference) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, inboxId, p.id, token, hashCode(id, code), contact, "sent", t.id, now.toISOString(), this.d.offline ? reference : null);

    const link = `${this.d.publicUrl ?? "http://127.0.0.1:4021"}/v/${token}`;
    const text = `Hi,\n\nWe received an invoice from ${payee} asking us to pay new bank details (account ending ${last4(p.beneficiary)}).\n\nIf that is really you, we've just sent 0.01 ${p.currency} to that account. Its reference holds a 6-digit code. Enter it here:\n\n${link}\n\nIf you didn't change your bank details, open the link and tell us; nothing will be paid.\n`;
    if (this.d.send) await this.d.send(contact, `Did ${payee} change its bank details?`, text).catch((e) => emit("escalate", `Could not email ${contact}: ${String(e).slice(0, 160)}`, { payout: p.id }));
    else emit("observe", `Email to ${contact} (no mail sender configured): ${link}`, { payout: p.id });
    emit("act", `Sent 0.01 ${p.currency} with a code to the new account, and asked ${contact} (the contact on file) for it`, { payout: p.id }, t.id);
    return this.forInbox(inboxId)!;
  }

  /** The payee's answer, from the link. */
  answer(token: string, reply: { code?: string; denied?: boolean }, now = new Date()): { ok: boolean; message: string; check?: PennyCheck } {
    const row = this.d.store.db.prepare("SELECT * FROM penny_checks WHERE token = ?").get(token) as Record<string, string | number | null> | undefined;
    if (!row) return { ok: false, message: "This link isn't valid." };
    const c = decode(row);
    if (c.status !== "sent") return { ok: c.status === "confirmed", message: c.status === "confirmed" ? "Already confirmed. Thank you." : "This check is closed.", check: c };
    if (now.getTime() - new Date(c.createdAt).getTime() > TTL_MS) { this.set(c.id, "failed"); return { ok: false, message: "This link has expired." }; }
    if (reply.denied) {
      this.set(c.id, "denied");
      emit("escalate", `${c.contact} says they did NOT change their bank details: the invoice is blocked`, { payout: c.payoutId });
      return { ok: true, message: "Thank you. We won't pay those details, and we'll be in touch." };
    }
    const attempts = c.attempts + 1;
    this.d.store.db.prepare("UPDATE penny_checks SET attempts = ? WHERE id = ?").run(attempts, c.id);
    if (hashCode(c.id, (reply.code ?? "").replace(/\D/g, "")) === row.code_hash) {
      this.set(c.id, "confirmed");
      emit("decide", `${c.contact} confirmed the new bank details with the code from the 1-cent payment`, { payout: c.payoutId });
      return { ok: true, message: "Confirmed. Thank you, your invoice can now be paid.", check: this.get(c.id) };
    }
    if (attempts >= MAX_ATTEMPTS) {
      this.set(c.id, "failed");
      emit("escalate", `Wrong code ${MAX_ATTEMPTS} times for the new bank details: the invoice stays blocked`, { payout: c.payoutId });
      return { ok: false, message: "That code is wrong, and this check is now closed." };
    }
    return { ok: false, message: `That code doesn't match. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? "try" : "tries"} left.` };
  }

  /** Whether the payee proved the new details: the owner's tap then clears the hold. */
  confirmed(inboxId: string): boolean {
    return this.forInbox(inboxId)?.status === "confirmed";
  }

  forInbox(inboxId: string): PennyCheck | undefined {
    const row = this.d.store.db.prepare("SELECT * FROM penny_checks WHERE inbox_id = ? ORDER BY created_at DESC LIMIT 1").get(inboxId);
    return row ? decode(row as Record<string, string | number | null>) : undefined;
  }

  /** The payee's side of a link, for its page. Never the code. */
  byToken(token: string): (PennyCheck & { item: InboxItem | undefined }) | undefined {
    const row = this.d.store.db.prepare("SELECT * FROM penny_checks WHERE token = ?").get(token);
    if (!row) return undefined;
    const c = decode(row as Record<string, string | number | null>);
    return { ...c, item: this.d.inbox.get(c.inboxId) };
  }

  private get(id: string): PennyCheck | undefined {
    const row = this.d.store.db.prepare("SELECT * FROM penny_checks WHERE id = ?").get(id);
    return row ? decode(row as Record<string, string | number | null>) : undefined;
  }

  private set(id: string, status: PennyStatus) {
    this.d.store.db.prepare("UPDATE penny_checks SET status = ? WHERE id = ?").run(status, id);
  }
}

function decode(r: Record<string, string | number | null>): PennyCheck {
  return {
    id: String(r.id), inboxId: String(r.inbox_id), payoutId: String(r.payout_id), contact: String(r.contact), status: r.status as PennyStatus,
    attempts: Number(r.attempts), transferId: (r.transfer_id as string | null) ?? null, createdAt: String(r.created_at),
    ...(r.sim_reference ? { simStatementReference: String(r.sim_reference) } : {}),
  };
}

export function last4(beneficiary: Record<string, unknown>): string {
  const bank = (beneficiary.bank_details ?? {}) as Record<string, string>;
  return (bank.iban ?? bank.account_number ?? "").replace(/\s+/g, "").slice(-4);
}
