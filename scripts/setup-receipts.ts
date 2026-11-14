// Creates (once) and funds Sayso's receipt key on the Metal testnet, then writes METAL_RECEIPT_KEY
// into .env (never printed; copy it into Render from there). Safe to re-run: it reuses .metal/receipts.json and binds no mandates.
// Needs METAL_RPC_URL in .env (the same one Sayso already uses).

import { existsSync, readFileSync } from "node:fs";
import { lockMetalDir, setEnv } from "./env-file.js";
import { MetalMandate } from "../src/metal/mandate.js";

if (!process.env.METAL_RPC_URL) throw new Error("Set METAL_RPC_URL in .env (create an endpoint at https://console-testnet.metalntwx.com)");
lockMetalDir();
const file = ".metal/receipts.json";
const cli = new MetalMandate({ network: "testnet", rpcUrl: process.env.METAL_RPC_URL, ownerKey: ".metal/owner.json", credential: ".metal/mandate.json", rampAddress: "0x0000000000000000000000000000000000000000" });
if (!existsSync(file)) await cli.cli(["key", "create", "--out", file]);
lockMetalDir();
const { address, privateKey } = JSON.parse(readFileSync(file, "utf8")) as { address: string; privateKey: string };
// Each anchor pays a little gas in USDZ; the testnet faucet covers it.
await cli.cli(["fund", address]).then(() => console.log(`funded ${address} from the testnet faucet`)).catch((e) => console.error(`fund ${address}: ${String(e).slice(0, 200)}`));
setEnv("METAL_RECEIPT_KEY", privateKey);
console.log(`\nWrote METAL_RECEIPT_KEY into .env (owner-only) for receipt address ${address}. For Render, copy it from there into Environment; it is not printed here so it stays out of logs.`);
