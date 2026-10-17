// What the agent has earned and not yet swept: the USDZ balance of its Metal account, read from chain.
// The x402 meter on the seller is only for the screen; this is the number the sweep trusts.

import { createPublicClient, erc20Abi, http, type Address } from "viem";
import type { RampLedger } from "../bridge/ledger.js";
import { USDZ } from "./mandate.js";

export interface EarningsSource {
  /** The next epoch to sweep, or undefined when there is nothing worth sweeping. */
  pending(): Promise<{ epoch: string; amountMinor: number } | undefined>;
}

export class ChainEarnings implements EarningsSource {
  constructor(
    private readonly rpcUrl: string,
    private readonly principal: Address,
    private readonly ledger: RampLedger,
    /** The mandate's per-payment cap: a sweep never asks for more. */
    private readonly capMinor: number,
    private readonly minSweepMinor = 1,
  ) {}

  async pending() {
    const client = createPublicClient({ transport: http(this.rpcUrl) });
    const units = await client.readContract({ address: USDZ, abi: erc20Abi, functionName: "balanceOf", args: [this.principal] });
    const cents = Number(units / 10n ** 16n); // 18 decimals -> cents, rounded down
    const amountMinor = Math.min(cents, this.capMinor);
    if (amountMinor < this.minSweepMinor) return undefined;
    return { epoch: `epoch-${this.ledger.all().length + 1}`, amountMinor };
  }
}
