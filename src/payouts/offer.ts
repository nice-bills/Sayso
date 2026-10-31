// Sayso's signed offer. Every payable quote carries an EIP-712 signature from Sayso's quote key over
// exactly what it promises: this payout id, this amount and currency to this payee, for this many
// USDZ paid to this address, until this time. The agent checks it against the key Sayso publishes
// (GET /healthz, quote_signer) before it pays, and keeps it: if Sayso later charged more, paid
// someone else or paid late, the agent holds Sayso's own signature saying what was agreed.

import { randomBytes } from "node:crypto";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { METAL_TESTNET_CHAIN_ID } from "../metal/mandate.js";
import type { Store } from "../store.js";
import type { Payout } from "./book.js";

export const OFFER_DOMAIN = { name: "Sayso", version: "1", chainId: METAL_TESTNET_CHAIN_ID } as const;
export const OFFER_TYPES = {
  Offer: [
    { name: "quote", type: "string" },
    { name: "amountMinor", type: "uint256" },
    { name: "currency", type: "string" },
    { name: "payeeHash", type: "string" },
    { name: "reference", type: "string" },
    { name: "priceUsdzMinor", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** What the signature covers, in the API's shape (strings, so JSON carries it unchanged). */
export interface OfferTerms {
  quote: string;
  amountMinor: string;
  currency: string;
  payeeHash: string;
  reference: string;
  priceUsdzMinor: string;
  payTo: Address;
  /** Unix seconds. */
  expiresAt: string;
}

export interface SignedOffer {
  signer: Address;
  terms: OfferTerms;
  signature: Hex;
}

const message = (t: OfferTerms) => ({ ...t, amountMinor: BigInt(t.amountMinor), priceUsdzMinor: BigInt(t.priceUsdzMinor), expiresAt: BigInt(t.expiresAt) });

export function termsOf(p: Payout, payTo: Address): OfferTerms {
  return {
    quote: p.id, amountMinor: String(p.amountMinor), currency: p.currency, payeeHash: p.payeeHash, reference: p.reference,
    priceUsdzMinor: String(p.totalMinor), payTo, expiresAt: String(Math.floor(new Date(p.expiresAt).getTime() / 1000)),
  };
}

/** True when `o` is signed by `signer` over exactly its terms. */
export async function verifyOffer(o: SignedOffer, signer: Address): Promise<boolean> {
  if (o.signer.toLowerCase() !== signer.toLowerCase()) return false;
  return verifyTypedData({ address: signer, domain: OFFER_DOMAIN, types: OFFER_TYPES, primaryType: "Offer", message: message(o.terms), signature: o.signature }).catch(() => false);
}

/**
 * Sayso's quote key: SAYSO_QUOTE_KEY, or one made on first start and kept in the database, so the
 * published signer stays the same across restarts. It holds no funds; it only signs offers.
 */
export class OfferSigner {
  private readonly account: PrivateKeyAccount;

  constructor(store: Store, key = process.env.SAYSO_QUOTE_KEY as Hex | undefined) {
    store.db.exec("CREATE TABLE IF NOT EXISTS signing_keys (name TEXT PRIMARY KEY, private_key TEXT NOT NULL)");
    let k = key;
    if (!k) {
      const row = store.db.prepare("SELECT private_key FROM signing_keys WHERE name = 'quote'").get() as { private_key: string } | undefined;
      k = (row?.private_key as Hex | undefined) ?? (`0x${randomBytes(32).toString("hex")}` as Hex);
      if (!row) store.db.prepare("INSERT INTO signing_keys (name, private_key) VALUES ('quote', ?)").run(k);
    }
    this.account = privateKeyToAccount(k);
  }

  get address(): Address { return this.account.address; }

  /** Signs what a payout promises. Deterministic (RFC 6979), so the same quote always gets the same signature. */
  async sign(p: Payout, payTo: Address): Promise<SignedOffer> {
    const terms = termsOf(p, payTo);
    const signature = await this.account.signTypedData({ domain: OFFER_DOMAIN, types: OFFER_TYPES, primaryType: "Offer", message: message(terms) });
    return { signer: this.address, terms, signature };
  }
}
