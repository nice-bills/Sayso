// Give an agent a budget on Metal, run by the agent's OWNER, never by Sayso and never by the agent.
// The owner's account binds a mandate whose only payee is Sayso, with a cap per payment, a total
// budget and an expiry. Metal enforces it on chain: a payment above the cap, past the budget, after
// the expiry or to anyone but Sayso is refused at settlement, whatever the agent was told to do.
//
//   SAYSO_PAY_TO=0x... (Sayso's Metal address, from GET /healthz on a live Sayso)
//   npm run setup:agent-budget -- --cap 250 --budget 1000 --days 30 --out .metal/agent-budget.json
//
// Then give the agent SAYSO_MANDATE=.metal/agent-budget.json; the mandate key it needs is written beside it.
//
// To approve a higher cap (Sayso holds a bill that costs more than the cap and is due soon):
//   npm run setup:agent-budget -- --cap 400 --budget 1000 --days 30 --replaces .metal/agent-budget.json
// The old mandate is revoked in the same transaction and its spending carries over; the agent keeps its
// SAYSO_MANDATE path, which now holds the new credential (the old one is kept as .replaced.json).
// The owner key stays with the owner, OUTSIDE the agent's folder: ~/.sayso-owner/agent-owner.json (0600) by
// default. It signs the agent's credential, so an agent that could read it could write itself any budget;
// and .metal/ ships to the host in METAL_BUNDLE, so it never goes there. Only the issuer's PUBLIC key is
// copied to .metal/ for the agent to show. Revoke any time:
//   npx metal-agent mandate revoke --credential .metal/agent-budget.json --key ~/.sayso-owner/agent-owner.json --network testnet --rpc-url $METAL_RPC_URL

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Address } from "viem";
import { MetalMandate } from "../src/metal/mandate.js";
import { toMinor } from "../src/treasury/money.js";

const { values } = parseArgs({ options: {
  cap: { type: "string", default: "250" }, budget: { type: "string", default: "1000" }, days: { type: "string", default: "30" },
  out: { type: "string", default: ".metal/agent-budget.json" }, owner: { type: "string", default: join(process.env.SAYSO_OWNER_DIR ?? join(homedir(), ".sayso-owner"), "agent-owner.json") },
  replaces: { type: "string" },
} });
// Replacing in place: keep the old credential beside it, and write the new one where the agent already looks.
const replaced = values.replaces && values.replaces === values.out ? values.out.replace(/\.json$/, ".replaced.json") : values.replaces;
if (values.replaces && replaced !== values.replaces) {
  copyFileSync(values.replaces, replaced!);
  const oldKey = values.replaces.replace(/\.json$/, ".key.json");
  if (existsSync(oldKey)) copyFileSync(oldKey, replaced!.replace(/\.json$/, ".key.json"));
}
const payTo = process.env.SAYSO_PAY_TO as Address | undefined;
if (!payTo) throw new Error("Set SAYSO_PAY_TO to Sayso's Metal address (pay_to in its GET /healthz)");
if (!process.env.METAL_RPC_URL) throw new Error("Set METAL_RPC_URL (create an endpoint at https://console-testnet.metalntwx.com)");
mkdirSync(".metal", { recursive: true });

// The owner's keys never sit where the agent (or the host bundle) can read them.
const ownerDir = resolve(dirname(values.owner));
if (ownerDir === resolve(".metal") || ownerDir === resolve(dirname(values.out))) {
  throw new Error(`--owner ${values.owner} is in the agent's folder. Keep the owner key elsewhere (default ~/.sayso-owner/).`);
}
mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
// Older runs wrote the owner key into .metal/; move it (and its issuer keys) out.
for (const f of existsSync(".metal") ? readdirSync(".metal") : []) {
  if (!f.startsWith("agent-owner.") || f === "agent-owner.issuer.public.json") continue;
  const to = join(ownerDir, f);
  if (!existsSync(to)) { renameSync(join(".metal", f), to); console.log(`Moved ${join(".metal", f)} to ${to}: the agent must not hold the owner's keys.`); }
}

const owner = new MetalMandate({ network: "testnet", rpcUrl: process.env.METAL_RPC_URL, ownerKey: values.owner, credential: values.out, rampAddress: payTo });
if (!existsSync(values.owner)) await owner.cli(["key", "create", "--out", values.owner]);
chmodSync(values.owner, 0o600);
const ownerAddress = JSON.parse(readFileSync(values.owner, "utf8")).address as string;
if (!replaced) await owner.cli(["fund", ownerAddress]).catch((e) => console.error(`fund owner: ${String(e).slice(0, 200)}`));

const { principal, reference, gasKeyAddress } = await owner.setup({
  capCents: toMinor(Number(values.cap)), budgetCents: toMinor(Number(values.budget)), expiresInSeconds: Number(values.days) * 86_400,
  payeeName: "Sayso", description: `Pay real-world invoices through Sayso: up to ${values.cap} USDZ each, ${values.budget} USDZ in total`,
  replaces: replaced,
  mandateKeyFile: replaced && existsSync(values.out.replace(/\.json$/, ".key.json")) ? values.out.replace(/\.json$/, ".key.json") : undefined,
});
if (replaced) {
  console.log(`\nReplaced on Metal: the agent may now pay Sayso up to ${values.cap} USDZ a payment, ${values.budget} USDZ in total. The old mandate is revoked.\n  mandate  ${reference}\n  old      ${replaced}`);
  process.exit(0);
}
// The agent shows the owner's issuer PUBLIC key with its credential; the private issuer key stays with the owner.
for (const f of readdirSync(ownerDir)) {
  if (f.endsWith(".issuer.public.json")) copyFileSync(join(ownerDir, f), join(".metal", "agent-owner.issuer.public.json"));
  else if (f.includes(".issuer")) chmodSync(join(ownerDir, f), 0o600);
}
if (gasKeyAddress) await owner.cli(["fund", gasKeyAddress]).catch(() => undefined);
// The agent pays from the owner's account, so that is where the budget's USDZ has to be.
await owner.cli(["fund", principal]).catch((e) => console.error(`fund the account: ${String(e).slice(0, 200)}`));

console.log(`
Bound on Metal: the agent may pay only Sayso (${payTo}), up to ${values.cap} USDZ a payment and ${values.budget} USDZ in total, for ${values.days} days.
  owner account  ${principal}
  mandate        ${reference}

Give the agent:
SAYSO_MANDATE=${values.out}
SAYSO_MANDATE_AGENT_KEY=${values.out.replace(/\.json$/, ".key.json")}`);
