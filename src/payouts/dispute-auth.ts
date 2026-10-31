// Who may dispute a payout: the owner, signed in, or the agent that paid for it. The agent proves
// it holds the paying address by signing a short message naming the payout and the claim, so a
// stranger who only knows the payout id can't start one. Live, the signature is checked against the
// chain (EOA or ERC-1271 smart account); offline, the simulated payer header stands in, as it does
// when paying.

import { createPublicClient, http, isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";

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
  body: { signature?: unknown; issued_at?: unknown };
  header(name: string): string | undefined;
}

/** Returns why the caller isn't the payer, or undefined when it is. */
export type PayerCheck = (r: DisputeRequest) => Promise<string | undefined>;

/** Live: the signature must recover to (or be accepted by) the address that paid. */
export function chainPayerCheck(rpcUrl: string, now = () => Date.now()): PayerCheck {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return async ({ buyer, payoutId, claim, body }) => {
    const issuedAt = String(body.issued_at ?? "");
    const signature = String(body.signature ?? "");
    if (!signature || !issuedAt) return "sign the dispute with the key that paid: signature and issued_at are required";
    const t = Date.parse(issuedAt);
    if (!Number.isFinite(t) || Math.abs(now() - t) > DISPUTE_SIGNATURE_TTL_MS) return "issued_at must be within 10 minutes of now";
    const message = disputeMessage(payoutId, claim, issuedAt);
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
