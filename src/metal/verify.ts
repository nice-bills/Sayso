// Server-side verification of a Metal MIP20 transfer before anything is credited off chain.
// Follows Metal's "Accept and Verify Transfers" guide: successful receipt, the exact Transfer
// event, consensus finality via `consensus_status`, and a durable event key.

import { parseAbiItem, type Address, type Hash, type PublicClient } from "viem";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface ExpectedTransfer {
  hash: Hash;
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}

async function finalizedBlock(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "consensus_status", params: [] }),
  });
  const payload = (await res.json()) as { result?: { finalized: { number: number | string } }; error?: unknown };
  if (!res.ok || !payload.result) throw new Error(`consensus_status failed: ${JSON.stringify(payload.error)}`);
  return BigInt(payload.result.finalized.number);
}

async function waitForFinality(rpcUrl: string, blockNumber: bigint, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await finalizedBlock(rpcUrl)) < blockNumber) {
    if (Date.now() >= deadline) throw new Error(`finality timeout at block ${blockNumber}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Returns the durable event key `${chainId}:${txHash}:${logIndex}` once the movement is final. */
export async function verifyMip20Transfer(client: PublicClient, rpcUrl: string, expected: ExpectedTransfer): Promise<{ eventKey: string; blockNumber: bigint }> {
  const receipt = await client.waitForTransactionReceipt({ hash: expected.hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${expected.hash}`);

  const logs = await client.getLogs({
    address: expected.token,
    event: transferEvent,
    args: { from: expected.from, to: expected.to },
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const movement = logs.find((l) => l.transactionHash === expected.hash && l.args.value === expected.amount);
  if (!movement || movement.logIndex === null) throw new Error("expected Transfer event was not emitted");

  await waitForFinality(rpcUrl, receipt.blockNumber);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error("receipt block is not on the finalized chain");

  const chainId = await client.getChainId();
  return { eventKey: `${chainId}:${expected.hash}:${movement.logIndex}`, blockNumber: receipt.blockNumber };
}
