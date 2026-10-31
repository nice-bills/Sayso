import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainPayerCheck, disputeMessage } from "../src/payouts/dispute-auth.js";

describe("who may dispute a payout, live", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const now = Date.parse("2026-11-01T10:00:00Z");
  // Unreachable RPC: a plain key must be checked without the chain.
  const check = chainPayerCheck("http://127.0.0.1:9", () => now);
  const req = async (signer: typeof payer, claim = "not_authorized", issuedAt = new Date(now).toISOString(), signedClaim = claim) => check({
    buyer: payer.address, payoutId: "p-1", claim, header: () => undefined,
    body: { issued_at: issuedAt, signature: await signer.signMessage({ message: disputeMessage("p-1", signedClaim, issuedAt) }) },
  });

  it("accepts the key that paid", async () => {
    expect(await req(payer)).toBeUndefined();
  });
  it("refuses another key, a missing signature, a stale one, and a signature for another claim", async () => {
    expect(await req(stranger)).toMatch(/not from the address that paid/);
    expect(await check({ buyer: payer.address, payoutId: "p-1", claim: "other", header: () => undefined, body: {} })).toMatch(/required/);
    expect(await req(payer, "not_authorized", new Date(now - 11 * 60_000).toISOString())).toMatch(/within 10 minutes/);
    expect(await req(payer, "not_authorized", undefined, "other")).toMatch(/not from the address that paid/);
  });
});
