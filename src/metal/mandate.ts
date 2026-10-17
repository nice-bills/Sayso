// The sweep leg on Metal: the agent's earnings account pays the ramp under a Metal mandate,
// so the limits are enforced by Metal's Mandate Binding on chain, not by our code.
// - the only payee the mandate allows is the ramp address;
// - every pull is capped (--cap) and the lifetime total is budgeted (--budget);
// - a pull to anyone else is refused by the chain, and --record-refusal writes that refusal
//   on chain as evidence (the "heist" beat of the demo).
//
// We drive the official metal-agent CLI rather than re-implementing its L3a signing.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createPublicClient, http, type Address, type Hash } from "viem";
import type { MetalSettlementVerifier } from "../bridge/ramp.js";
import { emit } from "../events.js";
import type { Store } from "../store.js";
import { verifyMip20Transfer } from "./verify.js";

const run = promisify(execFile);
const CLI = createRequire(import.meta.url).resolve("@metalntwx/metal-agent/dist/index.js");

export const USDZ: Address = "0x000000000000000000000000000000000000B5d5";
export const METAL_TESTNET_CHAIN_ID = 63825;
/** USDZ has 18 decimals; our ledger keeps cents. */
export const centsToUsdzUnits = (cents: number): bigint => BigInt(cents) * 10n ** 16n;
export const centsToUsdz = (cents: number): string => (cents / 100).toFixed(2);

/** metal-agent prints `key value` lines. Repeated keys (payee) keep the first value. */
export function parseCliOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([a-z][a-z-]*)\s+(.*)$/);
    if (m && !(m[1]! in out)) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export type PullResult =
  | { outcome: "paid"; tx: Hash; explorer?: string; spent?: string }
  | { outcome: "refused"; tx: Hash; reason: string; explorer?: string }
  | { outcome: "refused_unsent"; reason: string };

export function parsePull(stdout: string): PullResult {
  const kv = parseCliOutput(stdout);
  const outcome = kv.outcome ?? "";
  if (outcome.startsWith("refused, not sent")) return { outcome: "refused_unsent", reason: kv.reason ?? "unknown" };
  const tx = kv.transaction?.split(" ")[0] as Hash | undefined;
  if (!tx) throw new Error(`metal-agent printed no transaction: ${stdout}`);
  if (outcome === "paid") return { outcome: "paid", tx, explorer: kv.explorer, spent: kv.spent };
  if (outcome === "refused") return { outcome: "refused", tx, reason: kv.reason ?? "unknown", explorer: kv.explorer };
  throw new Error(`unrecognised pull outcome: ${stdout}`);
}

export interface MandateConfig {
  network: "testnet" | "devnet";
  rpcUrl?: string;
  /** The owner's key file. Lives where no agent can read it. */
  ownerKey: string;
  /** The credential file written by `setup`. */
  credential: string;
  /** Where swept earnings go: the off-ramp's Metal address. */
  rampAddress: Address;
}

export class MetalMandate {
  constructor(readonly cfg: MandateConfig) {}

  static fromEnv(): MetalMandate {
    const { METAL_OWNER_KEY, METAL_MANDATE, METAL_RAMP_ADDRESS, METAL_RPC_URL, METAL_NETWORK } = process.env;
    if (!METAL_OWNER_KEY || !METAL_MANDATE || !METAL_RAMP_ADDRESS) throw new Error("Set METAL_OWNER_KEY, METAL_MANDATE and METAL_RAMP_ADDRESS (see scripts/setup-metal.ts)");
    return new MetalMandate({ network: (METAL_NETWORK as "testnet" | "devnet") ?? "testnet", rpcUrl: METAL_RPC_URL, ownerKey: METAL_OWNER_KEY, credential: METAL_MANDATE, rampAddress: METAL_RAMP_ADDRESS as Address });
  }

  /** Runs metal-agent; a non-zero exit still returns stdout, because an unsent refusal exits 1. */
  async cli(args: string[]): Promise<{ stdout: string; code: number }> {
    const full = [...args, "--network", this.cfg.network, ...(this.cfg.rpcUrl ? ["--rpc-url", this.cfg.rpcUrl] : [])];
    try {
      const { stdout } = await run(process.execPath, [CLI, ...full], { timeout: 120_000 });
      return { stdout, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      if (e.stdout && /outcome/.test(e.stdout)) return { stdout: e.stdout, code: e.code ?? 1 };
      throw new Error(`metal-agent ${args.slice(0, 2).join(" ")} failed: ${e.stderr || e.stdout || String(err)}`);
    }
  }

  /** The owner's smart-account address: the principal the mandate spends from. */
  async account(): Promise<Address> {
    const { stdout } = await this.cli(["account", "create", "--key", this.cfg.ownerKey]);
    const a = parseCliOutput(stdout).account;
    if (!a) throw new Error(`no account in: ${stdout}`);
    return a as Address;
  }

  /**
   * One-time: write a credential and bind it on the owner's account. By default it may pay ONLY
   * the ramp; `anyPayee` (the refund mandate) drops the payee list and relies on cap and budget.
   */
  async setup(limits: { capCents: number; budgetCents: number; expiresInSeconds?: number; anyPayee?: boolean; description?: string }): Promise<{ principal: Address; reference: string; gasKeyAddress: string }> {
    const principal = await this.account();
    const create = await this.cli([
      "mandate", "credential", "create",
      "--principal", principal,
      "--cap", centsToUsdz(limits.capCents),
      "--budget", centsToUsdz(limits.budgetCents),
      ...(limits.anyPayee ? [] : ["--payee", `${this.cfg.rampAddress},CoinSlotRamp`]),
      "--description", limits.description ?? "Coin Slot earnings sweep to the Airwallex off-ramp",
      ...(limits.expiresInSeconds ? ["--expires-in", String(limits.expiresInSeconds)] : []),
      "--key", this.cfg.ownerKey,
      "--out", this.cfg.credential,
    ]);
    const kv = parseCliOutput(create.stdout);
    await this.cli(["mandate", "bind", "--credential", this.cfg.credential, "--key", this.cfg.ownerKey]);
    emit("act", limits.anyPayee ? "Bound refund mandate: any payee, capped per refund and in total" : "Bound sweep mandate: payee is the ramp only", { principal, cap: centsToUsdz(limits.capCents), budget: centsToUsdz(limits.budgetCents) }, kv.reference);
    return { principal, reference: kv.reference ?? "", gasKeyAddress: kv["gas-key-address"] ?? "" };
  }

  async pull(to: Address, amountCents: number, recordRefusal = false): Promise<PullResult> {
    const { stdout } = await this.cli([
      "mandate", "pull", "--credential", this.cfg.credential, "--to", to, "--amount", centsToUsdz(amountCents),
      ...(recordRefusal ? ["--record-refusal"] : []),
    ]);
    return parsePull(stdout);
  }

  /** The heist beat: try to pay an address the mandate never allowed, and record Metal's refusal on chain. */
  async attemptAndRecordRefusal(attacker: Address, amountCents: number): Promise<PullResult> {
    const r = await this.pull(attacker, amountCents, true);
    if (r.outcome === "paid") {
      emit("escalate", `Mandate PAID a non-ramp address ${attacker}: the mandate is misconfigured`, {}, r.tx);
    } else {
      emit("refuse", `Metal refused a payout to ${attacker}: ${r.reason}`, { recorded: r.outcome === "refused" }, r.outcome === "refused" ? r.explorer ?? r.tx : undefined);
    }
    return r;
  }

  async status(tx: Hash): Promise<Record<string, string>> {
    return parseCliOutput((await this.cli(["status", tx])).stdout);
  }
}

/**
 * The ramp's MetalSettlementVerifier backed by a real mandate pull. One pull per epoch:
 * the tx hash is stored the moment it is known, so a retry re-verifies that tx instead of paying again.
 */
export class MandateSweepVerifier implements MetalSettlementVerifier {
  constructor(private readonly mandate: MetalMandate, private readonly store: Store, private readonly principal: Address, private readonly rpcUrl: string) {}

  async verify(epoch: string, amountMinor: number): Promise<{ eventKey: string }> {
    let prior = this.store.pullFor(epoch);
    if (!prior?.txHash) {
      const r = await this.mandate.pull(this.mandate.cfg.rampAddress, amountMinor);
      if (r.outcome !== "paid") {
        this.store.recordPull(epoch, r.outcome === "refused" ? r.tx : null, r.outcome, r.reason);
        throw new Error(`mandate refused the sweep: ${r.reason}`);
      }
      this.store.recordPull(epoch, r.tx, "paid");
      emit("act", `Swept ${centsToUsdz(amountMinor)} USDZ to the ramp under the mandate`, { epoch }, r.explorer ?? r.tx);
      prior = { txHash: r.tx, outcome: "paid" };
    }
    const client = createPublicClient({ transport: http(this.rpcUrl) });
    const { eventKey } = await verifyMip20Transfer(client, this.rpcUrl, {
      hash: prior.txHash as Hash, token: USDZ, from: this.principal, to: this.mandate.cfg.rampAddress, amount: centsToUsdzUnits(amountMinor),
    });
    emit("reconcile", `Sweep for ${epoch} is final on Metal`, { eventKey }, prior.txHash ?? undefined);
    return { eventKey };
  }
}

/** Refunds a buyer under the refund mandate: Metal caps each refund and the lifetime total. */
export class MandateRefunder {
  constructor(private readonly mandate: MetalMandate) {}

  static fromEnv(): MandateRefunder {
    const base = MetalMandate.fromEnv();
    const credential = process.env.METAL_REFUND_MANDATE;
    if (!credential) throw new Error("Set METAL_REFUND_MANDATE (see scripts/setup-metal.ts)");
    return new MandateRefunder(new MetalMandate({ ...base.cfg, credential }));
  }

  async refund(to: string, amountMinor: number, payoutId: string): Promise<{ tx: string }> {
    const r = await this.mandate.pull(to as Address, amountMinor);
    if (r.outcome !== "paid") throw new Error(`refund mandate refused ${payoutId}: ${r.reason}`);
    return { tx: r.explorer ?? r.tx };
  }
}
