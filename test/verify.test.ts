import { afterEach, describe, expect, it, vi } from "vitest";
import { TransferRejected, verifyMip20Transfer } from "../src/metal/verify.js";

const hash = "0xaaaa" as const;
const token = "0x0000000000000000000000000000000000000001" as const;
const from = "0x0000000000000000000000000000000000000002" as const;
const to = "0x0000000000000000000000000000000000000003" as const;
const expected = { hash, token, from, to, amount: 500n };

const client = (o: { status?: string; value?: bigint; blockHash?: string } = {}) => ({
  waitForTransactionReceipt: async () => ({ status: o.status ?? "success", blockNumber: 10n, blockHash: "0xblock" }),
  getLogs: async () => [{ transactionHash: hash, logIndex: 4, args: { value: o.value ?? 500n } }],
  getBlock: async () => ({ hash: o.blockHash ?? "0xblock" }),
  getChainId: async () => 63825,
}) as never;

const consensus = (result: unknown) => vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => result }));

afterEach(() => vi.unstubAllGlobals());

describe("verifyMip20Transfer", () => {
  it("returns the durable event key for a final transfer", async () => {
    consensus({ result: { finalized: { number: 10 } } });
    const r = await verifyMip20Transfer(client(), "http://rpc", expected);
    expect(r.eventKey).toBe(`63825:${hash}:4`);
  });

  it("rejects a reverted receipt", async () => {
    await expect(verifyMip20Transfer(client({ status: "reverted" }), "http://rpc", expected)).rejects.toBeInstanceOf(TransferRejected);
  });

  it("rejects when no Transfer matches the amount", async () => {
    await expect(verifyMip20Transfer(client({ value: 1n }), "http://rpc", expected)).rejects.toBeInstanceOf(TransferRejected);
  });

  it("rejects a block that is not on the finalized chain", async () => {
    consensus({ result: { finalized: { number: 10 } } });
    await expect(verifyMip20Transfer(client({ blockHash: "0xother" }), "http://rpc", expected)).rejects.toBeInstanceOf(TransferRejected);
  });

  it("leaves an RPC failure as a plain, retryable Error", async () => {
    consensus({ error: "down" });
    const err = await verifyMip20Transfer(client(), "http://rpc", expected).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransferRejected);
  });
});
