// "Prove it": what Sayso, as the seller, can show when an agent's purchase is questioned, and
// how a dispute is settled from that proof. Each piece of evidence is something already on the
// record: the quote the agent accepted, the Metal mandate its owner bound and the order the agent
// signed, the owner's approval when the payout was held, the Metal payment, the Airwallex transfer,
// and the receipt anchored on chain.
//
// A dispute names what it says went wrong. judge() checks that claim against the evidence, in code:
//   proof answers the claim       -> denied, citing the evidence (its hash is anchored on Metal)
//   proof contradicts the payout  -> upheld, and the agent's USDZ comes back under the refund mandate
//                                    (only where Sayso's own record is at fault: the money didn't arrive,
//                                    or a held payee was never cleared; never just on the agent's word)
//   proof can't settle it         -> review, for the owner to decide with their passkey

import { createHash, randomUUID } from "node:crypto";
import type { Anchored } from "../metal/receipts.js";
import type { MandateProof } from "../metal/agent-mandate.js";
import type { Store } from "../store.js";
import type { TrailStep } from "../trail.js";
import { toMajor } from "../treasury/money.js";
import type { Payout } from "./book.js";
import type { SignedOffer } from "./offer.js";

export type EvidenceId = "order" | "mandate" | "approval" | "funding" | "delivery" | "receipt";

export interface Evidence {
  id: EvidenceId;
  title: string;
  /** proven: the record shows it. against: the record shows the opposite. missing: nothing on record. */
  status: "proven" | "against" | "missing";
  detail: string;
  link?: string;
}

export interface Proof {
  payout: string;
  evidence: Evidence[];
  /** SHA-256 over the evidence, keys sorted: what a denied dispute anchors on chain. */
  hash: string;
}

export const CLAIMS = {
  not_authorized: "The agent wasn't allowed to buy this",
  wrong_amount: "The agent was charged more than it agreed to",
  not_delivered: "The payee never got the money",
  wrong_payee: "The money went to the wrong account",
  other: "Something else",
} as const;
export type Claim = keyof typeof CLAIMS;

export interface Judgement {
  verdict: "denied" | "upheld" | "review";
  reason: string;
  cites: EvidenceId[];
}

const EXPLORER = "https://testnet.metalntwx.com/tx/";
const usdz = (minor: number) => `${toMajor(minor).toFixed(2)} USDZ`;
const txLink = (tx: string | null | undefined) => (tx && tx.startsWith("0x") ? `${EXPLORER}${tx}` : undefined);

/** The evidence for one payout, from the book, its trail, its receipts and (when known) the transfer's status now. */
export function buildProof(p: Payout, steps: TrailStep[], anchors: Anchored[], transferStatus?: string, offer?: SignedOffer): Proof {
  const mandate = steps.filter((s) => s.kind === "mandate").at(-1)?.detail as MandateProof | undefined;
  const held = steps.some((s) => s.kind === "escalate" && s.title.startsWith("Held"));
  const cleared = steps.filter((s) => s.kind === "decide" && /cleared .* after review/.test(s.title)).at(-1);
  const payeeSteps = steps.filter((s) => s.kind === "payee").map((s) => s.title);

  const evidence: Evidence[] = [];
  evidence.push({
    id: "order", title: "The order the agent placed",
    status: "proven",
    detail: `${toMajor(p.amountMinor).toFixed(2)} ${p.currency} to ${p.payeeName} (${p.reference}), quoted at ${usdz(p.totalMinor)} on ${p.createdAt.slice(0, 16).replace("T", " ")} UTC${offer ? `; Sayso's quote key ${short(offer.signer)} signed this offer (EIP-712), so the price and payee can't be changed later` : ""}${mandate?.signed_order ? "; the agent's key signed this exact order" : ""}.`,
  });

  if (!mandate) evidence.push({ id: "mandate", title: "The owner's Metal mandate", status: "missing", detail: "No mandate was verified for this payment." });
  else if (!mandate.ok) evidence.push({ id: "mandate", title: "The owner's Metal mandate", status: "against", detail: `Metal could not verify it: ${mandate.problems.join("; ") || "a verification step failed"}.` });
  else evidence.push({
    id: "mandate", title: "The owner's Metal mandate", status: "proven",
    detail: `Bound by ${short(mandate.principal)}: ${mandate.limits.payees.length ? "Sayso as the only payee" : "any payee"}, up to ${mandate.limits.cap_usdz} USDZ a payment, ${mandate.left_usdz} of ${mandate.limits.budget_usdz} USDZ left. Metal checked it on chain (${mandate.steps.filter((s) => s.outcome === "pass").length} of ${mandate.steps.length} steps passed, the rest need the agent's credential).`,
  });

  if (cleared) evidence.push({ id: "approval", title: "The owner's approval", status: "proven", detail: `It was held, then cleared: "${cleared.title}" at ${cleared.at.slice(0, 16).replace("T", " ")} UTC.` });
  else if (held) evidence.push({ id: "approval", title: "The owner's approval", status: "against", detail: "It was held for review and nobody cleared it." });
  else evidence.push({ id: "approval", title: "The owner's approval", status: "proven", detail: payeeSteps.length ? `Not needed. ${payeeSteps.join(". ")}.` : "Not needed. No rule held it." });

  evidence.push(p.fundingTx
    ? { id: "funding", title: "The agent's payment on Metal", status: "proven", detail: `${usdz(p.totalMinor)}, the quoted price, settled in ${short(p.fundingTx)}.`, link: txLink(p.fundingTx) }
    : { id: "funding", title: "The agent's payment on Metal", status: "missing", detail: "No Metal payment is on record." });

  const now = transferStatus ?? (p.status === "paid" ? "PAID" : p.status);
  if (!p.transferId) evidence.push({ id: "delivery", title: "The bank transfer", status: "missing", detail: "No Airwallex transfer was made." });
  else if (now === "PAID" || now === "SETTLED") evidence.push({ id: "delivery", title: "The bank transfer", status: "proven", detail: `Airwallex transfer ${p.transferId} reached ${p.payeeName}'s bank (${now}).` });
  else if (/FAIL|RETURN|CANCEL|refund/i.test(now)) evidence.push({ id: "delivery", title: "The bank transfer", status: "against", detail: `Airwallex transfer ${p.transferId} did not arrive (${now}).` });
  else evidence.push({ id: "delivery", title: "The bank transfer", status: "missing", detail: `Airwallex transfer ${p.transferId} is still ${now}.` });

  const paid = anchors.find((a) => a.status === "paid");
  evidence.push(paid?.tx
    ? { id: "receipt", title: "The receipt on chain", status: "proven", detail: `Receipt ${short(paid.hash)} anchored in ${short(paid.tx)}; anyone can rehash it and compare.`, link: paid.explorer ?? txLink(paid.tx) }
    : { id: "receipt", title: "The receipt on chain", status: "missing", detail: paid ? "The receipt is recorded but not yet anchored." : "No receipt has been issued." });

  return { payout: p.id, evidence, hash: hashOf(evidence) };
}

/** Settles a claim from the evidence. Pure: the same proof and claim always give the same answer. */
export function judge(claim: Claim, proof: Proof): Judgement {
  const e = Object.fromEntries(proof.evidence.map((x) => [x.id, x])) as Record<EvidenceId, Evidence>;
  const is = (id: EvidenceId, s: Evidence["status"]) => e[id]?.status === s;

  switch (claim) {
    case "not_authorized":
      if (is("mandate", "proven") && is("funding", "proven")) return { verdict: "denied", reason: "The owner's Metal mandate allowed this payment, and Metal enforced its limits on chain when it settled.", cites: ["mandate", "order", "funding"] };
      // The payee already has the money, so a refund here would be Sayso paying twice. The owner decides.
      return { verdict: "review", reason: is("mandate", "against")
        ? "Metal couldn't verify the mandate behind this payment, but the payee has been paid. The owner decides whether to refund it."
        : "The agent's own key paid, under no mandate, and the payee has been paid. Sayso won't refund that on its own; the owner decides.", cites: ["mandate", "funding", "delivery"] };
    case "wrong_amount":
      if (is("funding", "proven")) return { verdict: "denied", reason: "The agent paid exactly the quoted price: Sayso's signed offer and the 402 response both named it before the agent paid.", cites: ["order", "funding"] };
      return { verdict: "review", reason: "No Metal payment is on record to compare with the quote.", cites: ["funding"] };
    case "not_delivered":
      if (is("delivery", "proven")) return { verdict: "denied", reason: "Airwallex reports the transfer reached the payee's bank, and the receipt on chain says so too.", cites: ["delivery", "receipt"] };
      if (is("delivery", "against")) return { verdict: "upheld", reason: "Airwallex reports the transfer did not arrive, so the agent gets its USDZ back.", cites: ["delivery"] };
      return { verdict: "review", reason: "The transfer hasn't settled yet, so the proof can't settle this.", cites: ["delivery"] };
    case "wrong_payee":
      if (is("approval", "against")) return { verdict: "upheld", reason: "The payee's bank didn't confirm the name, or a hold was never cleared, so the agent gets its USDZ back.", cites: ["approval"] };
      if (is("approval", "proven") && is("order", "proven")) return { verdict: "denied", reason: "The money went to the bank details in the agent's own order, and the payee's bank confirmed them or the owner approved them.", cites: ["order", "approval"] };
      return { verdict: "review", reason: "The record doesn't show who checked the bank details.", cites: ["approval"] };
    default:
      return { verdict: "review", reason: "The proof doesn't cover this claim, so the owner decides.", cites: [] };
  }
}

export interface Dispute {
  id: string;
  payout: string;
  claim: Claim;
  note: string;
  by: string;
  verdict: Judgement["verdict"] | "refunded_by_owner" | "denied_by_owner";
  reason: string;
  cites: EvidenceId[];
  proof_hash: string;
  anchor_tx: string | null;
  at: string;
}

/** Every dispute and how it was settled, in the agent's memory. */
export class Disputes {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS disputes (
      id TEXT PRIMARY KEY, payout_id TEXT NOT NULL, claim TEXT NOT NULL, note TEXT NOT NULL, by_who TEXT NOT NULL,
      verdict TEXT NOT NULL, reason TEXT NOT NULL, cites TEXT NOT NULL, proof_hash TEXT NOT NULL, anchor_tx TEXT, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS disputes_payout ON disputes (payout_id, at);`);
  }

  add(d: Omit<Dispute, "id" | "at" | "anchor_tx">, at = new Date()): Dispute {
    const row: Dispute = { ...d, id: randomUUID(), anchor_tx: null, at: at.toISOString() };
    this.store.db.prepare("INSERT INTO disputes (id, payout_id, claim, note, by_who, verdict, reason, cites, proof_hash, anchor_tx, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.payout, row.claim, row.note, row.by, row.verdict, row.reason, JSON.stringify(row.cites), row.proof_hash, null, row.at);
    return row;
  }

  anchored(id: string, tx: string): void {
    this.store.db.prepare("UPDATE disputes SET anchor_tx = ? WHERE id = ?").run(tx, id);
  }

  settle(id: string, verdict: Dispute["verdict"], reason: string): void {
    this.store.db.prepare("UPDATE disputes SET verdict = ?, reason = ? WHERE id = ?").run(verdict, reason, id);
  }

  for(payoutId: string): Dispute[] {
    return this.store.db.prepare("SELECT * FROM disputes WHERE payout_id = ? ORDER BY at").all(payoutId).map((r) => {
      const x = r as Record<string, string | null>;
      return { id: x.id!, payout: x.payout_id!, claim: x.claim as Claim, note: x.note!, by: x.by_who!, verdict: x.verdict as Dispute["verdict"], reason: x.reason!, cites: JSON.parse(x.cites!), proof_hash: x.proof_hash!, anchor_tx: x.anchor_tx ?? null, at: x.at! };
    });
  }

  /** The dispute still waiting for the owner, if any. */
  open(payoutId: string): Dispute | undefined {
    return this.for(payoutId).filter((d) => d.verdict === "review").at(-1);
  }
}

function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function hashOf(evidence: Evidence[]): string {
  const canonical = JSON.stringify(evidence.map((x) => Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))));
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}
