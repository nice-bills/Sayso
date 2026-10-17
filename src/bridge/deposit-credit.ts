// The Airwallex side of the off-ramp, today: the sandbox deposit simulation into the agent's
// USD global account. USDZ is credited 1:1 as USD cents. When a real Airwallex-Metal ramp exists,
// only this class changes; the verification and the ledger stay as they are.

import type { Airwallex } from "../airwallex/client.js";
import { toMajor } from "../treasury/money.js";
import type { AirwallexCredit } from "./ramp.js";

export class SimulatedDepositCredit implements AirwallexCredit {
  /** Deposits this process has seen land, for the reconciliation identity. */
  readonly deposits: Array<{ operationId: string; depositId: string; amountMinor: number }> = [];

  constructor(private readonly awx: Pick<Airwallex, "simulateDeposit">, private readonly globalAccountId: string) {}

  async credit(operationId: string, amountMinor: number, currency: string): Promise<{ depositId: string }> {
    if (currency !== "USD") throw new Error(`the ramp credits USD only, got ${currency}`);
    const { id } = await this.awx.simulateDeposit(this.globalAccountId, toMajor(amountMinor), `Coin Slot ramp ${operationId.slice(0, 8)}`);
    this.deposits.push({ operationId, depositId: id, amountMinor });
    return { depositId: id };
  }

  depositedMinor = (): number => this.deposits.reduce((s, d) => s + d.amountMinor, 0);
}
