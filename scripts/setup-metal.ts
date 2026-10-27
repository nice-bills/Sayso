// One-time Metal testnet setup, all through the official metal-agent CLI:
// owner key -> owner's smart account (the principal that receives x402 payments) -> ramp key ->
// a sweep mandate whose only payee is the ramp, and a refund mandate capped per refund and in
// total, both bound on chain -> faucet funds for gas and the demo's buyer agents.
// Keys live in .metal/ (gitignored). Prints the env lines to paste into .env.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { MetalMandate } from "../src/metal/mandate.js";
import { toMinor } from "../src/treasury/money.js";
import type { Address } from "viem";

if (!process.env.METAL_RPC_URL) throw new Error("Set METAL_RPC_URL (create an endpoint at https://console-testnet.metalntwx.com)");
mkdirSync(".metal", { recursive: true });
const key = (name: string) => `.metal/${name}.json`;
const address = (name: string) => JSON.parse(readFileSync(key(name), "utf8")).address as Address;

const base = new MetalMandate({ network: "testnet", rpcUrl: process.env.METAL_RPC_URL, ownerKey: key("owner"), credential: ".metal/mandate.json", rampAddress: "0x0000000000000000000000000000000000000000" });
for (const name of ["owner", "ramp", "receipts", "buyer1", "buyer2", "buyer3"]) {
  if (!existsSync(key(name))) await base.cli(["key", "create", "--out", key(name)]).catch(() => undefined);
}
const mandate = new MetalMandate({ ...base.cfg, rampAddress: address("ramp") });
// Binding a mandate is a transaction from the owner key, which pays gas in USDZ: fund it first.
await mandate.cli(["fund", address("owner")]).then(() => console.log(`funded owner ${address("owner")}`)).catch((e) => console.error(`fund owner: ${String(e).slice(0, 200)}`));
const { principal, gasKeyAddress } = await mandate.setup({ capCents: toMinor(5000), budgetCents: toMinor(50000) });
// Refunds go back to whichever agent paid, so this one has no payee list: Metal caps each refund and the total.
const refunds = new MetalMandate({ ...mandate.cfg, credential: ".metal/refund.json" });
const refund = await refunds.setup({ capCents: toMinor(2500), budgetCents: toMinor(10000), anyPayee: true, description: "Sayso refunds to buyer agents" });

// The receipt key anchors each final payout's receipt hash on chain, paying gas in USDZ.
for (const a of [gasKeyAddress, refund.gasKeyAddress, address("receipts"), ...["buyer1", "buyer2", "buyer3"].map(address)]) {
  if (a) await mandate.cli(["fund", a]).then(() => console.log(`funded ${a}`)).catch((e) => console.error(`fund ${a}: ${String(e).slice(0, 200)}`));
}

const buyers = ["buyer1", "buyer2", "buyer3"].map((n) => JSON.parse(readFileSync(key(n), "utf8")).privateKey as string);
console.log(`\nPaste into .env:
METAL_PRINCIPAL=${principal}
METAL_RAMP_ADDRESS=${address("ramp")}
METAL_OWNER_KEY=${key("owner")}
METAL_MANDATE=.metal/mandate.json
METAL_REFUND_MANDATE=.metal/refund.json
METAL_RECEIPT_KEY=${JSON.parse(readFileSync(key("receipts"), "utf8")).privateKey as string}
METAL_BUYER_KEYS=${buyers.join(",")}`);
