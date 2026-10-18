// Turns planned actions into Airwallex calls without ever paying twice.
// - Every operation gets a request_id stored BEFORE the call; a retry reuses it.
// - An ambiguous result (timeout, 5xx) is looked up by request_id before anything is resent.
// - (obligation, kind, attempt) is unique, so only one live attempt exists per obligation.
// - A replacement is created only after the original reached a terminal CANCELLED state.
// - Anything flagged needsApproval waits for an approval bound to exactly these terms.

import { randomUUID } from "node:crypto";
import { AirwallexError, chargedFeeDetail, transferFailure, type Airwallex, type Transfer } from "../airwallex/client.js";
import { emit } from "../events.js";
import type { Store } from "../store.js";
import { ApprovalGate, type Approval, type ApprovalTerms } from "../treasury/approval.js";
import { toMajor, toMinor } from "../treasury/money.js";
import type { Action } from "../treasury/policy.js";

export type AirwallexPort = Pick<Airwallex, "fxConvert" | "createTransfer" | "transferByRequestId">;

export interface ExecutorDeps {
  awx: AirwallexPort;
  store: Store;
  gate: ApprovalGate;
  /** Approvals granted by a person, keyed by obligation id + action. */
  approvals: Map<string, Approval>;
  evidenceHash: (obligationId: string) => string;
  reference: (obligationId: string) => string;
  baseCurrency: string;
}

export const approvalKey = (obligationId: string, action: "convert" | "pay") => `${obligationId}:${action}`;
const isAmbiguous = (err: unknown) => !(err instanceof AirwallexError) || err.status >= 500 || err.status === 408 || err.status === 429;

export function termsOf(a: Extract<Action, { kind: "convert" | "pay" }>, evidenceHash: string): ApprovalTerms {
  return a.kind === "convert"
    ? { action: "convert", obligationId: a.obligationId, currency: a.buyCurrency, amountMinor: a.buyMinor, evidenceHash }
    : { action: "pay", obligationId: a.obligationId, currency: a.currency, amountMinor: a.amountMinor, beneficiaryId: a.beneficiaryId, evidenceHash };
}

/** Returns true when the action may proceed now. */
function approved(d: ExecutorDeps, a: Extract<Action, { kind: "convert" | "pay" }>): boolean {
  if (!a.needsApproval) return true;
  const approval = d.approvals.get(approvalKey(a.obligationId, a.kind));
  if (!approval) {
    emit("escalate", `Approval needed: ${a.kind} for ${a.obligationId}`, { terms: termsOf(a, d.evidenceHash(a.obligationId)) });
    return false;
  }
  const check = d.gate.check(approval, termsOf(a, d.evidenceHash(a.obligationId)));
  if (!check.ok) {
    emit("refuse", `Approval refused for ${a.obligationId}: ${check.reason}`);
    d.approvals.delete(approvalKey(a.obligationId, a.kind));
    return false;
  }
  return true;
}

export async function executeConvert(d: ExecutorDeps, a: Extract<Action, { kind: "convert" }>): Promise<void> {
  const prior = d.store.latestOp(a.obligationId, "convert");
  if (prior && prior.status !== "failed") return; // already converted or in flight
  if (!approved(d, a)) return;
  const requestId = randomUUID();
  d.store.insertOp({ requestId, obligationId: a.obligationId, kind: "convert", attempt: (prior?.attempt ?? 0) + 1, status: "submitted", currency: a.buyCurrency, amountMinor: a.buyMinor });
  try {
    // FX settles immediately (status SETTLED); there is no pending state to track.
    const c = await d.awx.fxConvert({ request_id: requestId, sell_currency: a.sellCurrency, buy_currency: a.buyCurrency, buy_amount: toMajor(a.buyMinor).toFixed(2) });
    // The sell side is kept for reconciliation: base currency out must match what was bought.
    d.store.updateOp(requestId, "settled", c.id, JSON.stringify({ sell_currency: a.sellCurrency, sell_minor: toMinor(c.sell_amount) }));
    emit("act", `Converted ${a.sellCurrency} -> ${toMajor(a.buyMinor).toFixed(2)} ${a.buyCurrency} for ${a.obligationId}`, { sell_amount: c.sell_amount }, c.id);
  } catch (err) {
    // A conversion can't be looked up by request_id here, so an ambiguous one is held for a person.
    d.store.updateOp(requestId, isAmbiguous(err) ? "ambiguous" : "failed", null, String(err));
    emit(isAmbiguous(err) ? "escalate" : "refuse", `Conversion for ${a.obligationId} ${isAmbiguous(err) ? "outcome unknown; held" : "rejected"}`, { error: String(err) });
  }
}

export async function executePay(d: ExecutorDeps, a: Extract<Action, { kind: "pay" }>): Promise<void> {
  const prior = d.store.latestOp(a.obligationId, "pay");
  if (prior && prior.status !== "failed") return; // paid, in flight, ambiguous or escalated: never send another
  if (!approved(d, a)) return;
  const attempt = (prior?.attempt ?? 0) + 1;
  const requestId = randomUUID();
  d.store.insertOp({ requestId, obligationId: a.obligationId, kind: "pay", attempt, status: "submitted", currency: a.currency, amountMinor: a.amountMinor, detail: JSON.stringify({ fee_minor: a.feeMinor }) });
  await submitTransfer(d, requestId, a);
}

async function submitTransfer(d: ExecutorDeps, requestId: string, a: Extract<Action, { kind: "pay" }>, isRetry = false): Promise<void> {
  try {
    const t = await d.awx.createTransfer({
      request_id: requestId,
      beneficiary_id: a.beneficiaryId,
      transfer_amount: toMajor(a.amountMinor).toFixed(2),
      transfer_currency: a.currency,
      transfer_method: a.method,
      reference: d.reference(a.obligationId),
      source_currency: a.currency,
      reason: "business_expenses",
    });
    d.store.updateOp(requestId, "submitted", t.id, chargedFeeDetail(t, a.currency));
    emit("act", `Payout ${toMajor(a.amountMinor).toFixed(2)} ${a.currency} to ${a.beneficiaryId} via ${a.method}${isRetry ? " (same request_id)" : ""}`, { status: t.status }, t.id);
  } catch (err) {
    if (!isAmbiguous(err)) {
      d.store.updateOp(requestId, "failed", null, String(err));
      emit("refuse", `Payout for ${a.obligationId} rejected`, { error: String(err) });
      return;
    }
    // Did it go through? Look it up by our request_id before doing anything else.
    d.store.updateOp(requestId, "ambiguous", null, String(err));
    const found = await d.awx.transferByRequestId(requestId).catch(() => undefined);
    if (found) {
      d.store.updateOp(requestId, "submitted", found.id);
      emit("observe", `Payout for ${a.obligationId} did go through; adopting it, not resending`, { status: found.status }, found.id);
    } else if (!isRetry) {
      await submitTransfer(d, requestId, a, true);
    } else {
      emit("escalate", `Payout for ${a.obligationId} still unconfirmed after one retry; held for a person`);
    }
  }
}

/**
 * React to a transfer's state. PAID closes it. CANCELLED (a FAILED transfer is cancelled, and its money returned, seconds later)
 * records the failure_type and either queues one replacement or escalates.
 */
export function onTransferState(d: Pick<ExecutorDeps, "store">, t: Transfer, beneficiaryStillAllowed: boolean): "settled" | "replace" | "escalate" | "pending" {
  const op = d.store.opByAirwallexId(t.id);
  if (!op) return "pending";
  if (t.status === "PAID") {
    d.store.updateOp(op.requestId, "settled");
    emit("reconcile", `Payout ${t.id} PAID`, {}, t.id);
    return "settled";
  }
  if (t.status !== "CANCELLED") return "pending"; // SENT is in flight, never final
  // The fee stays in the detail: a bounce returns the transfer amount, not Airwallex's fee.
  const feeMinor = op.detail?.startsWith("{") ? (JSON.parse(op.detail) as { fee_minor?: number }).fee_minor ?? 0 : 0;
  const reason = transferFailure(t);
  const detail = JSON.stringify({ fee_minor: feeMinor, failure: reason });
  if (op.attempt >= 2 || !beneficiaryStillAllowed) {
    d.store.updateOp(op.requestId, "escalated", null, detail);
    emit("escalate", `Payout ${t.id} failed (${reason}); escalated instead of retrying`, {}, t.id);
    return "escalate";
  }
  // Marking it failed releases the duplicate lock for exactly one new attempt.
  d.store.updateOp(op.requestId, "failed", null, detail);
  emit("decide", `Payout ${t.id} failed (${reason}); the original is terminal, so one replacement is allowed`, {}, t.id);
  return "replace";
}
