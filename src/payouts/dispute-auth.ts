// Who may dispute a payout: the owner, signed in, or the agent that paid for it. The agent proves
// it holds the paying address by signing a short message naming the payout and the claim, so a
// stranger who only knows the payout id can't start one. Live, the signature is checked against the
// chain (EOA or ERC-1271 smart account); offline, the simulated payer header stands in, as it does
// when paying.
//
// An agent that paid under its owner's mandate paid from the owner's smart account, which a plain
// signature can't speak for. It signs with its mandate key instead (P-256, over the SHA-256 of the
// message, as it signs its orders), and Sayso checks that against the agent key Metal has bound to
// that mandate on chain.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readBoundAgentKey } from "@metalntwx/metal-pay/mandates";
import { createPublicClient, hexToBytes, http, isAddressEqual, recoverMessageAddress, type Address, type Hex, type PublicClient } from "viem";

/** How long a signed dispute stays usable: long enough for a slow agent, short enough not to replay later. */
export const DISPUTE_SIGNATURE_TTL_MS = 10 * 60_000;

/** What the paying agent signs (EIP-191) to dispute a payout. */
export function disputeMessage(payoutId: string, claim: string, issuedAt: string): string {
  return `Sayso dispute\npayout: ${payoutId}\nclaim: ${claim}\nissued_at: ${issuedAt}`;
}

export interface DisputeRequest {
  /** The address that paid for the payout. */
  buyer: string;
  payoutId: string;
  claim: string;
  body: { signature?: unknown; issued_at?: unknown; signer?: unknown };
  header(name: string): string | undefined;
  /** The Metal mandate the payout was paid under, when it was. */
  mandateRef?: string;
}

/** The digest an agent's mandate key signs for a dispute: SHA-256 of the message. */
export function disputeDigest(message: string): Hex {
  return `0x${createHash("sha256").update(message).digest("hex")}`;
}

/** Checks a P-256 signature (r ‖ s) over SHA-256(message) against a mandate's bound agent key. */
export function verifyMandateKeySignature(message: string, signature: Hex, key: { x: Hex; y: Hex }): boolean {
  const b64 = (h: Hex) => Buffer.from(hexToBytes(h)).toString("base64url");
  try {
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(key.x), y: b64(key.y) }, format: "jwk" });
    return verify("sha256", Buffer.from(message), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(hexToBytes(signature)));
  } catch {
    return false;
  }
}

/** Returns why the caller isn't the payer, or undefined when it is. */
export type PayerCheck = (r: DisputeRequest) => Promise<string | undefined>;

/** Live: the signature must recover to (or be accepted by) the address that paid. */
export function chainPayerCheck(rpcUrl: string, now = () => Date.now()): PayerCheck {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return async ({ buyer, payoutId, claim, body, mandateRef }) => {
    const issuedAt = String(body.issued_at ?? "");
    const signature = String(body.signature ?? "");
    if (!signature || !issuedAt) return "sign the dispute with the key that paid: signature and issued_at are required";
    const t = Date.parse(issuedAt);
    if (!Number.isFinite(t) || Math.abs(now() - t) > DISPUTE_SIGNATURE_TTL_MS) return "issued_at must be within 10 minutes of now";
    const message = disputeMessage(payoutId, claim, issuedAt);
    if (body.signer === "mandate_key") {
      if (!mandateRef) return "this payout wasn't paid under a mandate, so sign with the key that paid";
      const bound = await readBoundAgentKey(client as PublicClient, buyer as Address, mandateRef as Hex).catch(() => undefined);
      if (!bound) return "Metal has no agent key bound for this payout's mandate";
      return verifyMandateKeySignature(message, signature as Hex, bound.agentKey) ? undefined : "the signature is not from the agent key bound to this payout's mandate";
    }
    // A plain key recovers locally; a smart account (ERC-1271) is asked on chain.
    const signer = await recoverMessageAddress({ message, signature: signature as Hex }).catch(() => undefined);
    const ok = (signer && isAddressEqual(signer, buyer as Address))
      || await client.verifyMessage({ address: buyer as Address, message, signature: signature as Hex }).catch(() => false);
    return ok ? undefined : "the signature is not from the address that paid for this payout";
  };
}

/** Offline: the simulated payer (or mandate) headers must name the payer, as they did when it was paid. */
export function simPayerCheck(principalOf: (mandateRef: string) => string | undefined): PayerCheck {
  return async ({ buyer, header }) => {
    const ref = header("x-sim-mandate");
    const payer = header("x-sim-payer") ?? (ref ? principalOf(ref) : undefined);
    return payer?.toLowerCase() === buyer.toLowerCase() ? undefined : "only the agent that paid can dispute this payout";
  };
}
