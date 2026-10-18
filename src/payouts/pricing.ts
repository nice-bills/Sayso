// What a payout costs the buying agent, in USDZ cents. Pure.
// The buyer prefunds everything: the payout amount at Airwallex's rate plus a buffer, any SWIFT
// fee, and Coin Slot's fee. The buffer covers rate movement between quote and conversion; what
// it doesn't use is Coin Slot's FX margin, recorded as such.

import { sellNeededMinor } from "../treasury/money.js";

export interface PricingConfig {
  /** Flat fee per payout, USD cents. */
  flatFeeMinor: number;
  /** Fee as a fraction of the payout's USD value. */
  pctFee: number;
  /** Headroom on the indicative rate, as a fraction. */
  rateBuffer: number;
  /** SWIFT fee charged by Airwallex per currency, in that currency's minor units. */
  swiftFeeMinor: Record<string, number>;
  /** LOCAL fee Airwallex charges the payer per currency (seen on the sandbox: EUR 2.68, GBP 2.26). */
  localFeeMinor: Record<string, number>;
}

export const DEFAULT_PRICING: PricingConfig = { flatFeeMinor: 25, pctFee: 0.005, rateBuffer: 0.01, swiftFeeMinor: { EUR: 1285 }, localFeeMinor: { EUR: 268, GBP: 226 } };

/** The fee Airwallex takes from our balance for one transfer, in the payout currency. */
export const transferFee = (method: "LOCAL" | "SWIFT", currency: string, cfg: PricingConfig = DEFAULT_PRICING): number =>
  (method === "SWIFT" ? cfg.swiftFeeMinor : cfg.localFeeMinor)[currency] ?? 0;

export interface Price {
  /** USD needed to deliver the payout (and any transfer fee), at the buffered rate. */
  costMinor: number;
  feeMinor: number;
  transferFeeMinor: number;
  totalMinor: number;
  /** Units of payout currency per 1 USD, after the buffer. */
  rateUsed: number;
}

export function price(amountMinor: number, currency: string, method: "LOCAL" | "SWIFT", usdRate: number, cfg: PricingConfig = DEFAULT_PRICING): Price {
  const transferFeeMinor = transferFee(method, currency, cfg);
  const deliverMinor = amountMinor + transferFeeMinor;
  const rateUsed = currency === "USD" ? 1 : usdRate * (1 - cfg.rateBuffer);
  const costMinor = currency === "USD" ? deliverMinor : sellNeededMinor(deliverMinor, rateUsed);
  const feeMinor = cfg.flatFeeMinor + Math.ceil(costMinor * cfg.pctFee);
  return { costMinor, feeMinor, transferFeeMinor, totalMinor: costMinor + feeMinor, rateUsed };
}
