// The off-ramp: earnings that settled on Metal become an Airwallex balance, exactly once.
// There is no sandbox link between Metal and Airwallex yet, so the credit side is an interface:
// today it is Airwallex's deposit simulation; the real Airwallex-Metal ramp replaces it later
// without touching the verification or the ledger.

import { randomUUID } from "node:crypto";
import type { RampLedger, Sweep } from "./ledger.js";

export interface SettledEarnings {
  epoch: string;
  amountMinor: number;
  currency: "USD";
}

/** Proves the Metal movement for an epoch is final; returns its durable event key. */
export interface MetalSettlementVerifier {
  verify(epoch: string, amountMinor: number): Promise<{ eventKey: string }>;
}

/** Credits the Airwallex side. Must be safe to call once per operation id. */
export interface AirwallexCredit {
  credit(operationId: string, amountMinor: number, currency: string): Promise<{ depositId: string }>;
}

export type SweepOutcome =
  | { outcome: "credited"; sweep: Sweep }
  | { outcome: "already_credited"; sweep: Sweep }
  | { outcome: "rejected"; sweep: Sweep };

export async function sweepEpoch(e: SettledEarnings, ledger: RampLedger, metal: MetalSettlementVerifier, awx: AirwallexCredit): Promise<SweepOutcome> {
  const op = ledger.record(randomUUID(), e.epoch, e.amountMinor, e.currency);
  if (op.status === "credited") return { outcome: "already_credited", sweep: op };
  if (op.status === "rejected") return { outcome: "rejected", sweep: op };

  if (op.status === "recorded") {
    try {
      const { eventKey } = await metal.verify(e.epoch, e.amountMinor);
      ledger.markVerified(op.operationId, eventKey);
    } catch (err) {
      // A movement that is not final, or not what we expected, is never credited.
      ledger.markRejected(op.operationId, err instanceof Error ? err.message : String(err));
      return { outcome: "rejected", sweep: ledger.get(op.operationId)! };
    }
  }

  const { depositId } = await awx.credit(op.operationId, op.amountMinor, op.currency);
  ledger.markCredited(op.operationId, depositId);
  return { outcome: "credited", sweep: ledger.get(op.operationId)! };
}
