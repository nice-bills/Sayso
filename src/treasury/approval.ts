// Approvals are bound to exactly what the approver saw. Executing anything else is refused.

import { createHash, randomUUID } from "node:crypto";
import type { Currency } from "./money.js";

export interface ApprovalTerms {
  action: "convert" | "pay";
  obligationId: string;
  currency: Currency;
  amountMinor: number;
  beneficiaryId?: string;
  /** Hash of the evidence shown to the approver (invoice, email, quote). */
  evidenceHash: string;
}

export interface Approval {
  terms: ApprovalTerms;
  digest: string;
  nonce: string;
  approver: string;
  expiresAt: Date;
}

export const hashEvidence = (evidence: string | Buffer): string => createHash("sha256").update(evidence).digest("hex");

function digestOf(terms: ApprovalTerms, nonce: string, expiresAt: Date): string {
  const canonical = JSON.stringify([terms.action, terms.obligationId, terms.currency, terms.amountMinor, terms.beneficiaryId ?? null, terms.evidenceHash, nonce, expiresAt.toISOString()]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function grant(terms: ApprovalTerms, approver: string, ttlMs: number, now = new Date()): Approval {
  const nonce = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);
  return { terms, digest: digestOf(terms, nonce, expiresAt), nonce, approver, expiresAt };
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: "expired" | "replayed" | "terms_changed" };

/** Single-use: a consumed nonce is never accepted again. */
export class ApprovalGate {
  private readonly used = new Set<string>();

  check(approval: Approval, proposed: ApprovalTerms, now = new Date()): ApprovalCheck {
    if (now > approval.expiresAt) return { ok: false, reason: "expired" };
    if (this.used.has(approval.nonce)) return { ok: false, reason: "replayed" };
    if (digestOf(proposed, approval.nonce, approval.expiresAt) !== approval.digest) return { ok: false, reason: "terms_changed" };
    this.used.add(approval.nonce);
    return { ok: true };
  }
}
