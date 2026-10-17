// One-time Metal testnet setup, all through the official metal-agent CLI:
// owner key -> owner's smart account (the principal that receives x402 earnings) -> ramp key ->
// a mandate whose only payee is the ramp, bound on chain -> faucet funds for gas and buyers.
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
for (const name of ["owner", "ramp", "buyer1", "buyer2", "buyer3"]) {
  if (!existsSync(key(name))) await base.cli(["key", "create", "--out", key(name)]).catch(() => undefined);
}
const mandate = new MetalMandate({ ...base.cfg, rampAddress: address("ramp") });
const { principal, gasKeyAddress } = await mandate.setup({ capCents: toMinor(500), budgetCents: toMinor(5000) });

for (const a of [gasKeyAddress, ...["buyer1", "buyer2", "buyer3"].map(address)]) {
  if (a) await mandate.cli(["fund", a]).then(() => console.log(`funded ${a}`)).catch((e) => console.error(`fund ${a}: ${String(e).slice(0, 200)}`));
}

const buyers = ["buyer1", "buyer2", "buyer3"].map((n) => JSON.parse(readFileSync(key(n), "utf8")).privateKey as string);
console.log(`\nPaste into .env:
METAL_PRINCIPAL=${principal}
METAL_SELLER_ADDRESS=${principal}
METAL_RAMP_ADDRESS=${address("ramp")}
METAL_OWNER_KEY=${key("owner")}
METAL_MANDATE=.metal/mandate.json
METAL_BUYER_KEYS=${buyers.join(",")}`);
