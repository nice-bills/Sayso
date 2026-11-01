import { describe, expect, it } from "vitest";
import { createEs256Key, p256DigestSigner, privateKeyHex } from "@metalntwx/metal-pay/mandates";
import { bytesToHex } from "viem";
import { disputeDigest, disputeMessage, verifyMandateKeySignature } from "../src/payouts/dispute-auth.js";

const hexOf = (b64: string) => bytesToHex(Buffer.from(b64, "base64url"));

describe("an agent paying under its owner's mandate disputes with its mandate key", () => {
  it("accepts a signature from the bound agent key, and refuses another key or another claim", async () => {
    const agent = await createEs256Key();
    const other = await createEs256Key();
    const bound = { x: hexOf(agent.publicJwk.x), y: hexOf(agent.publicJwk.y) };
    const message = disputeMessage("p1", "wrong_amount", "2026-11-01T09:00:00.000Z");
    const signature = await p256DigestSigner(privateKeyHex(agent))(disputeDigest(message));
    expect(verifyMandateKeySignature(message, signature, bound)).toBe(true);
    expect(verifyMandateKeySignature(disputeMessage("p1", "not_delivered", "2026-11-01T09:00:00.000Z"), signature, bound)).toBe(false);
    const forged = await p256DigestSigner(privateKeyHex(other))(disputeDigest(message));
    expect(verifyMandateKeySignature(message, forged, bound)).toBe(false);
  });
});
