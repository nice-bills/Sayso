// Fresh demo buyers for a live run. The Metal testnet faucet funds each address once (100 USDZ),
// and a full live demo spends about 50 USDZ from the second buyer, so each run before a recording
// starts from three new funded keys. Writes METAL_BUYER_KEYS into .env.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MetalMandate } from "../src/metal/mandate.js";

if (!process.env.METAL_RPC_URL) throw new Error("Set METAL_RPC_URL");
const m = new MetalMandate({ network: "testnet", rpcUrl: process.env.METAL_RPC_URL, ownerKey: ".metal/owner.json", credential: ".metal/mandate.json", rampAddress: "0x0000000000000000000000000000000000000000" });
let n = 1;
const keys: string[] = [];
while (keys.length < 3) {
  const f = `.metal/buyer${n++}.json`;
  if (existsSync(f)) continue;
  await m.cli(["key", "create", "--out", f]);
  const k = JSON.parse(readFileSync(f, "utf8")) as { address: string; privateKey: string };
  await m.cli(["fund", k.address]);
  console.log(`funded ${k.address}`);
  keys.push(k.privateKey);
}
const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
writeFileSync(".env", /^METAL_BUYER_KEYS=/m.test(env) ? env.replace(/^METAL_BUYER_KEYS=.*$/m, `METAL_BUYER_KEYS=${keys.join(",")}`) : `${env}\nMETAL_BUYER_KEYS=${keys.join(",")}\n`);
console.log("METAL_BUYER_KEYS updated in .env");
