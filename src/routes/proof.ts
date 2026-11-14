import express from "express";
import { createPublicClient, http, type Address } from "viem";
import { readAnchor, RECEIPT_TAG, type Receipts } from "../metal/receipts.js";
import { buildProof, CLAIMS, type Disputes } from "../payouts/proof.js";
import type { OfferSigner } from "../payouts/offer.js";
import type { Payout } from "../payouts/book.js";
import type { PayoutAirwallex, PayoutService } from "../payouts/service.js";
import type { Trail } from "../trail.js";

export interface ProofDeps {
  svc: PayoutService;
  receipts: Receipts;
  anchorAddress: Address | undefined;
  offline: boolean;
  awx: PayoutAirwallex;
  trail: Trail;
  offers: OfferSigner;
  disputes: Disputes;
}

type View = { status: number; body: Record<string, unknown> };

export function proofRoutes(d: ProofDeps) {
  const { svc, receipts, anchorAddress, awx, trail, offers, disputes } = d;
  const router = express.Router();
  // A payout's receipt, and the Metal transaction that anchors its hash. Public, like the payout itself:
  // it holds no bank details, and anyone can check it against the chain.
  const receiptView = (id: string): View => {
    const p = svc.book.get(id);
    if (!p) return { status: 404, body: { error: "no such payout" } };
    const anchored = receipts.get(p.id);
    if (!anchored.length) return { status: 409, body: { error: `payout is ${p.status}; a receipt is issued once it is paid or refunded` } };
    return {
      status: 200,
      body: {
        anchors: anchored, anchor_address: anchorAddress ?? null,
        how_to_verify: "SHA-256 the receipt's JSON with its keys sorted (no spaces); the anchor transaction's data is 0x534159534f31 (\"SAYSO1\") followed by that hash, sent by anchor_address to itself.",
      },
    };
  };
  router.get("/v1/payouts/:id/receipt", (req, res) => { const r = receiptView(String(req.params.id)); res.status(r.status).json(r.body); });

  // The landing's receipt check: the newest real receipt, and its anchor transaction as Metal reports it
  // (read by Sayso from the RPC; the explorer link lets anyone read it themselves).
  router.get("/v1/receipts/latest", async (_req, res) => {
    const a = receipts.latest();
    if (!a) return void res.status(404).json({ error: "no receipt has been issued yet" });
    let chain: Record<string, unknown> = { read: false, why: a.tx?.startsWith("sim:") ? "this receipt was anchored by the simulator, not on Metal" : "no Metal RPC" };
    const rpc = process.env.METAL_RPC_URL;
    if (a.tx?.startsWith("0x") && rpc && !d.offline) {
      try {
        const t = await readAnchor(createPublicClient({ transport: http(rpc) }), a.tx as `0x${string}`);
        chain = { read: true, ...t, from_is_sayso: anchorAddress ? t.from.toLowerCase() === anchorAddress.toLowerCase() : null, tag: RECEIPT_TAG };
      } catch (err) { chain = { read: false, why: `Metal RPC: ${String(err).slice(0, 120)}` }; }
    }
    res.json({ payout: a.payout, status: a.status, receipt: a.receipt, hash: a.hash, tx: a.tx, explorer: a.explorer, anchor_address: anchorAddress ?? null, chain });
  });

  // "Prove it": what Sayso can show when an agent's purchase is questioned. Public like the receipt:
  // the payout id is the key, and the proof holds no bank details.
  const proofOf = async (p: Payout) => {
    const t = p.transferId ? await awx.transferByRequestId(p.id).catch(() => undefined) : undefined;
    return buildProof(p, trail.for(p.id), receipts.get(p.id), t?.status, offers.recorded(p.id));
  };
  const proofView = async (id: string): Promise<View> => {
    const p = svc.book.get(id);
    if (!p) return { status: 404, body: { error: "no such payout" } };
    return { status: 200, body: { ...(await proofOf(p)), disputes: disputes.for(p.id), claims: CLAIMS } };
  };
  router.get("/v1/payouts/:id/proof", async (req, res) => { const r = await proofView(String(req.params.id)); res.status(r.status).json(r.body); });
  return { router, receiptView, proofView, proofOf };
}
