// Money is handled in integer minor units (cents) so no decision depends on float rounding.
// Airwallex takes major units on the wire; convert only at the API boundary.

export type Currency = "USD" | "EUR" | "GBP" | (string & {});

export const toMinor = (major: number): number => Math.round(major * 100);
export const toMajor = (minor: number): number => minor / 100;

/** Minor units of `buy` you get for `sellMinor` of the base currency at `rate` (buy per 1 sell). */
export const convertMinor = (sellMinor: number, rate: number): number => Math.floor(sellMinor * rate);

/** Minor units of the sell currency needed to buy `buyMinor` at `rate`, rounded up so we never under-fund. */
export const sellNeededMinor = (buyMinor: number, rate: number): number => Math.ceil(buyMinor / rate);

export const fmt = (minor: number, ccy: Currency): string => `${ccy} ${(minor / 100).toFixed(2)}`;
