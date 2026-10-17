// A swarm of buyer agents that pay the seller per call, for load and for the demo's coin counter.
// Each agent has its own testnet key and pays at most MAX_PAYMENT per call.

import { privateKeyToAccount } from "viem/accounts";
import { createMetalPaymentClient, usdzBaseUnits } from "@metalntwx/metal-pay";

const keys = (process.env.METAL_BUYER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean) as `0x${string}`[];
if (keys.length === 0) throw new Error("Set METAL_BUYER_KEYS to comma-separated testnet private keys");

const target = process.env.SELLER_URL ?? "http://127.0.0.1:4021/v1/answer";
const callsPerAgent = Number(process.env.CALLS ?? 20);

const agents = keys.map((k) => {
  const account = privateKeyToAccount(k);
  const { fetchWithPayment } = createMetalPaymentClient({ account, network: "testnet", maxAmount: BigInt(usdzBaseUnits("0.05")) });
  return { address: account.address, fetchWithPayment };
});

let ok = 0;
let failed = 0;
await Promise.all(agents.map(async (a, i) => {
  // One account signs one payment at a time, so each agent runs its calls in sequence.
  for (let n = 0; n < callsPerAgent; n++) {
    const res = await a.fetchWithPayment(`${target}?q=agent${i}-call${n}`);
    if (res.ok) ok++; else { failed++; console.error(a.address, res.status, await res.text()); }
  }
}));
console.log(`swarm done: ${ok} paid calls, ${failed} failed, ${agents.length} agents`);
