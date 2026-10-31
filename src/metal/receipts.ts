// Payout receipts anchored on Metal. When a payout is final (delivered, or refunded), Sayso hashes
// what happened (the quote, the Airwallex transfer, the outcome, the payee's hash, never their bank
// details) and writes that hash on chain in a transaction of its own. Anyone holding the receipt can
// check it against the chain without asking Sayso: hash it, and compare with the transaction's data.
//
// The anchor is a transaction from Sayso's receipt key to itself whose data is "SAYSO1" and the
// 32-byte hash, paid for in USDZ through Metal's MIP20 gas envelope.

import { createHash, randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, stringToHex, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { emit } from "../events.js";
import type { Payout } from "../payouts/book.js";
import type { Store } from "../store.js";
import { toMajor } from "../treasury/money.js";
import { METAL_TESTNET_CHAIN_ID, USDZ } from "./mandate.js";

export const RECEIPT_TAG: Hex = stringToHex("SAYSO1");
const EXPLORER = "https://testnet.metalntwx.com/tx/";

export interface Receipt {
  v: 1;
  payout: string;
  status: "paid" | "refunded";
  amount: string;
  currency: string;
  price_usdz: string;
  payee_hash: string;
  reference: string;
  funding_tx: string | null;
  airwallex_transfer_id: string | null;
  refund_tx: string | null;
  final_at: string;
}

export function receiptOf(p: Payout, at = new Date()): Receipt {
  if (p.status !== "paid" && p.status !== "refunded") throw new Error(`payout ${p.id} is ${p.status}, not final`);
  return {
    v: 1, payout: p.id, status: p.status, amount: toMajor(p.amountMinor).toFixed(2), currency: p.currency, price_usdz: toMajor(p.totalMinor).toFixed(2),
    payee_hash: p.payeeHash, reference: p.reference, funding_tx: p.fundingTx, airwallex_transfer_id: p.transferId, refund_tx: p.refundTx, final_at: at.toISOString(),
  };
}

/** SHA-256 over the receipt's keys in sorted order, as 0x hex. Anyone can recompute it. */
export function hashReceipt(r: Receipt): Hex {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The calldata an anchor carries. */
export const anchorData = (hash: Hex): Hex => `${RECEIPT_TAG}${hash.slice(2)}`;

export interface Anchorer {
  /** Writes the hash on chain. Returns the transaction. */
  anchor(hash: Hex): Promise<{ tx: string; explorer?: string }>;
}

/** Live: a funded Metal key sends the anchor to itself, paying gas in USDZ. */
export class MetalAnchorer implements Anchorer {
  readonly address: Address;
  private readonly wallet;
  private readonly client: PublicClient;

  constructor(privateKey: Hex, rpcUrl: string, chainId = METAL_TESTNET_CHAIN_ID) {
    const chain = { id: chainId, name: "Metal", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    this.client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  }

  static fromEnv(): MetalAnchorer | undefined {
    const { METAL_RECEIPT_KEY, METAL_RPC_URL } = process.env;
    return METAL_RECEIPT_KEY && METAL_RPC_URL ? new MetalAnchorer(METAL_RECEIPT_KEY as Hex, METAL_RPC_URL) : undefined;
  }

  // One anchor at a time: two sent together from the same key race for the same nonce.
  private queue: Promise<unknown> = Promise.resolve();
  anchor(hash: Hex): Promise<{ tx: string; explorer?: string }> {
    const next = this.queue.then(() => this.send(hash));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(hash: Hex) {
    const { sendMip20Call } = await import("@metalntwx/metal-ts");
    const tx = await sendMip20Call({ walletClient: this.wallet, publicClient: this.client, to: this.address, data: anchorData(hash), gasToken: USDZ, gasFallback: 80_000n });
    const receipt = await this.client.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error(`anchor transaction reverted: ${tx}`);
    return { tx, explorer: `${EXPLORER}${tx}` };
  }
}

/** Offline: the anchor is recorded, and its proof says sim:. */
export class SimAnchorer implements Anchorer {
  async anchor(_hash: Hex) {
    return { tx: `sim:0x${randomUUID().replaceAll("-", "")}` };
  }
}

/** Checks an anchor from the chain alone: it is Sayso's, it succeeded, and it carries this hash. */
export async function verifyAnchor(client: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">, tx: Hash, hash: Hex, anchorAddress: Address): Promise<{ ok: boolean; problem?: string }> {
  const [t, r] = await Promise.all([client.getTransaction({ hash: tx }), client.getTransactionReceipt({ hash: tx })]);
  if (r.status !== "success") return { ok: false, problem: "the anchor transaction failed" };
  if (t.from.toLowerCase() !== anchorAddress.toLowerCase()) return { ok: false, problem: `sent by ${t.from}, not Sayso's receipt key` };
  if (t.input.toLowerCase() !== anchorData(hash).toLowerCase()) return { ok: false, problem: "the transaction carries a different hash" };
  return { ok: true };
}

export interface Anchored {
  status: Receipt["status"];
  receipt: Receipt;
  hash: Hex;
  tx: string | null;
  explorer: string | null;
  error: string | null;
}

/** Keeps each final payout's receipt and its anchor. A payout paid and later bounced has two. */
export class Receipts {
  constructor(private readonly store: Store, private readonly anchorer: Anchorer, readonly anchorAddress?: Address) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      payout_id TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT NOT NULL, hash TEXT NOT NULL,
      tx TEXT, explorer TEXT, error TEXT, PRIMARY KEY (payout_id, status)
    )`);
  }

  /** Records the receipt first, then anchors it, so a crash between the two leaves it to retry. */
  async issue(p: Payout, now = new Date()): Promise<Anchored | undefined> {
    if (p.status !== "paid" && p.status !== "refunded") return undefined;
    const existing = this.get(p.id).find((a) => a.status === p.status);
    if (existing?.tx) return existing;
    const receipt = existing?.receipt ?? receiptOf(p, now);
    const hash = hashReceipt(receipt);
    if (!existing) this.store.db.prepare("INSERT OR IGNORE INTO receipts (payout_id, status, receipt, hash) VALUES (?, ?, ?, ?)").run(p.id, p.status, JSON.stringify(receipt), hash);
    try {
      const { tx, explorer } = await this.anchorer.anchor(hash);
      this.store.db.prepare("UPDATE receipts SET tx = ?, explorer = ?, error = NULL WHERE payout_id = ? AND status = ?").run(tx, explorer ?? null, p.id, p.status);
      emit("reconcile", `Receipt for ${p.id.slice(0, 8)} (${p.status}) anchored on Metal`, { payout: p.id, hash }, explorer ?? tx);
    } catch (err) {
      this.store.db.prepare("UPDATE receipts SET error = ? WHERE payout_id = ? AND status = ?").run(String(err).slice(0, 300), p.id, p.status);
      emit("escalate", `Could not anchor the receipt for ${p.id.slice(0, 8)}: ${String(err).slice(0, 200)}`, { payout: p.id });
    }
    return this.get(p.id).find((a) => a.status === p.status);
  }

  /** Anchors any receipt that failed to anchor before. */
  async retry(): Promise<void> {
    const rows = this.store.db.prepare("SELECT payout_id, status FROM receipts WHERE tx IS NULL").all() as Array<{ payout_id: string; status: string }>;
    for (const r of rows) {
      const a = this.get(r.payout_id).find((x) => x.status === r.status)!;
      try {
        const { tx, explorer } = await this.anchorer.anchor(a.hash);
        this.store.db.prepare("UPDATE receipts SET tx = ?, explorer = ?, error = NULL WHERE payout_id = ? AND status = ?").run(tx, explorer ?? null, r.payout_id, r.status);
      } catch { /* left for the next tick */ }
    }
  }

  /** The newest anchored receipt, preferring one anchored on Metal over a simulated one. */
  latest(): (Anchored & { payout: string }) | undefined {
    const row = this.store.db.prepare("SELECT payout_id, status FROM receipts WHERE tx IS NOT NULL ORDER BY (tx LIKE '0x%') DESC, rowid DESC LIMIT 1").get() as { payout_id: string; status: string } | undefined;
    const a = row && this.get(row.payout_id).find((x) => x.status === row.status);
    return a && { ...a, payout: row.payout_id };
  }

  get(payoutId: string): Anchored[] {
    return this.store.db.prepare("SELECT * FROM receipts WHERE payout_id = ? ORDER BY rowid").all(payoutId).map((row) => {
      const x = row as Record<string, string | null>;
      return { status: x.status as Receipt["status"], receipt: JSON.parse(x.receipt!), hash: x.hash as Hex, tx: x.tx ?? null, explorer: x.explorer ?? null, error: x.error ?? null };
    });
  }
}

/** Reads an anchor transaction from the chain: who sent it, whether it succeeded, and the data it carries. */
export async function readAnchor(client: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">, tx: Hash) {
  const [t, r] = await Promise.all([client.getTransaction({ hash: tx }), client.getTransactionReceipt({ hash: tx })]);
  return { from: t.from, to: t.to, input: t.input, status: r.status, block: Number(r.blockNumber) };
}
