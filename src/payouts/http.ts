// The public API. Agents pay for payouts over x402: the price of POST /v1/payouts/:id/pay is the
// quote's total, so the 402 response itself tells the agent exactly what it will be charged.
//
//   POST /v1/quotes            free   -> quote (or needs_review / rejected, with reasons)
//   POST /v1/payouts/:id/pay   x402   -> 202 accepted; fiat moves only after the payment settles
//   GET  /v1/payouts/:id       free   -> status, transfer id, refund tx
//   POST /v1/batches           free   -> many payouts quoted under one price (lines it won't pay are set aside)
//   POST /v1/batches/:id/pay   x402   -> one payment funds every line
//   GET  /v1/batches/:id       free   -> each line's progress
//
// x402's Express middleware settles only when the handler answers < 400, and only after it, so:
// the handler locks the quote; the after-settle hook starts the payout; a failed settlement
// releases the quote.

import express, { type Router } from "express";
import { paymentMiddleware } from "@x402/express";
import type { x402ResourceServer } from "@x402/core/server";
import { mandateRefOf, signedOfferOf, SIGNED_OFFER_REQUIRED } from "@metalntwx/metal-pay/mandates";
import { emit } from "../events.js";
import type { MandateChecker, MandatePolicy, MandateProof, SimMandates } from "../metal/agent-mandate.js";
import { PayoutError, publicView, type PayoutService } from "./service.js";
import type { BatchBook } from "./batch.js";

export type PaymentMode =
  | { kind: "x402"; server: x402ResourceServer; network: string; payTo: string; mandates?: MandateChecker }
  /** Offline: the request names its payer in x-sim-payer (or its mandate in x-sim-mandate) and is treated as settled. */
  | { kind: "sim"; mandates?: SimMandates };

/** How agents' Metal mandates are treated, and where a verified mandate is recorded. */
export interface MandateOptions {
  policy: MandatePolicy;
  /** Called with the payouts one payment funded and Metal's verification of the mandate it was made under. */
  record(payoutIds: string[], proof: MandateProof): void;
}

const PAY = /^\/v1\/payouts\/([0-9a-f-]{36})\/pay$/;
const PAY_BATCH = /^\/v1\/batches\/([0-9a-f-]{36})\/pay$/;

export function payoutApi(svc: PayoutService, mode: PaymentMode, batches: BatchBook, mandates: MandateOptions = { policy: "verify", record: () => {} }): Router {
  const r = express.Router();
  const linesOf = (x: { kind: "payout" | "batch"; id: string }) => (x.kind === "payout" ? [x.id] : batches.get(x.id)?.payoutIds ?? []);
  r.use(express.json({ limit: "1mb" }));

  r.post("/v1/batches", async (req, res) => {
    try {
      const b = await batches.create(req.body?.items, String(req.body?.reference ?? "Batch payout"));
      res.status(b.status === "rejected" ? 422 : 201).json(batches.view(b.id));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/v1/batches/:id", (req, res) => {
    const v = batches.view(req.params.id);
    if (!v) return void res.status(404).json({ error: "no such batch" });
    res.json(v);
  });
  r.post("/v1/batches/:id/pay", (req, res, next) => {
    const b = batches.get(req.params.id);
    if (!b) return void res.status(404).json({ error: "no such batch" });
    if (!batches.priceOf(b.id)) return void res.status(b.status === "quoted" ? 410 : 409).json({ error: b.status === "quoted" ? "batch quote expired" : `batch is ${b.status}`, batch: batches.view(b.id) });
    next();
  });

  r.post("/v1/quotes", async (req, res) => {
    try {
      const p = await svc.quote(req.body);
      res.status(p.status === "rejected" ? 422 : 201).json({ ...publicView(p), pay_url: p.status === "quoted" ? `/v1/payouts/${p.id}/pay` : null });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/v1/payouts/:id", (req, res) => {
    const p = svc.book.get(req.params.id);
    if (!p) return void res.status(404).json({ error: "no such payout" });
    res.json(publicView(p));
  });

  // Only a payable quote ever gets a 402; anything else is answered before payment is asked for.
  r.post("/v1/payouts/:id/pay", (req, res, next) => {
    const p = svc.book.get(req.params.id);
    if (!p) return void res.status(404).json({ error: "no such quote" });
    if (!svc.priceOf(p.id)) return void res.status(p.status === "quoted" ? 410 : 409).json({ error: p.status === "quoted" ? "quote expired" : `quote is ${p.status}`, payout: publicView(p) });
    next();
  });

  if (mode.kind === "x402") {
    const release = (t: unknown) => { const x = target(t); if (x?.kind === "payout") svc.release(x.id); else if (x?.kind === "batch") batches.release(x.id); };
    mode.server.onAfterSettle(async (ctx) => {
      const x = target(ctx.transportContext);
      if (!x || !ctx.result.success) return;
      // Do not hold the buyer's response on the bank: the payout runs after the reply.
      const run = x.kind === "payout" ? svc.onFunded(x.id, ctx.result.payer ?? "", ctx.result.transaction) : batches.onFunded(x.id, ctx.result.payer ?? "", ctx.result.transaction);
      void run.catch((e) => emit("escalate", `${x.kind} ${x.id.slice(0, 8)} crashed after funding: ${String(e)}`));
      // Paid under the owner's mandate: check it from the chain and keep the proof on the payout.
      const ref = mandateRefOf(ctx.paymentPayload as never);
      if (ref && mode.mandates && mandates.policy !== "off") {
        void mode.mandates.check({ tx: ctx.result.transaction, requirements: ctx.requirements, ref, checkoutMandate: signedOfferOf(ctx.paymentPayload as never) || undefined })
          .then((proof) => mandates.record(linesOf(x), proof))
          .catch((e) => emit("escalate", `Could not verify the mandate behind ${x.kind} ${x.id.slice(0, 8)}: ${String(e).slice(0, 200)}`));
      }
    });
    mode.server.onSettleFailure(async (ctx) => release(ctx.transportContext));
    // "required": a payment that names no owner mandate is refused before it settles; nothing moves.
    if (mandates.policy === "required") {
      mode.server.onBeforeVerify(async (ctx) => {
        if (target(ctx.transportContext) && !mandateRefOf(ctx.paymentPayload as never)) return { abort: true as const, reason: "mandate_required", message: "Pay under a Metal mandate your owner bound, with Sayso as its payee" };
      });
    }
    const extra = mandates.policy === "required" ? { extra: { ...SIGNED_OFFER_REQUIRED } } : {};
    mode.server.onVerifiedPaymentCanceled(async (ctx) => release(ctx.transportContext));
    r.use(paymentMiddleware({
      "POST /v1/payouts/:id/pay": {
        accepts: [{
          scheme: "exact",
          network: mode.network,
          payTo: mode.payTo,
          price: (ctx: { path: string }) => svc.priceOf(ctx.path.match(PAY)?.[1] ?? "") ?? "0",
          ...extra,
        }],
        description: "Pay a real-world invoice in local currency through Airwallex",
      },
      "POST /v1/batches/:id/pay": {
        accepts: [{
          scheme: "exact",
          network: mode.network,
          payTo: mode.payTo,
          price: (ctx: { path: string }) => batches.priceOf(ctx.path.match(PAY_BATCH)?.[1] ?? "") ?? "0",
          ...extra,
        }],
        description: "Pay many people in local currency through Airwallex, with one payment",
      },
    } as Parameters<typeof paymentMiddleware>[0], mode.server));
  } else {
    const simPay = (kind: "payout" | "batch"): express.RequestHandler => (req, res, next) => {
      const id = String(req.params.id);
      const price = kind === "payout" ? svc.priceOf(id) : batches.priceOf(id);
      const ref = req.header("x-sim-mandate");
      let payer = req.header("x-sim-payer");
      if (!payer && !ref) return void res.status(402).json({ error: "payment required", price_usdz: price });
      if (mandates.policy === "required" && !ref) return void res.status(402).json({ error: "mandate_required: pay under a Metal mandate your owner bound, with Sayso as its payee", price_usdz: price });
      if (ref && mode.mandates && price) {
        // What Metal checks at settlement: the payee, the cap, the budget, the expiry.
        const refused = mode.mandates.spend(ref, Math.round(Number(price) * 100));
        if (refused) return void res.status(402).json({ error: `payment refused: ${refused}`, price_usdz: price });
        payer = mode.mandates.principalOf(ref);
      }
      if (!payer) return void res.status(402).json({ error: "payment refused: mandate_not_bound", price_usdz: price });
      const tx = `sim:0xsettle${id.slice(0, 8)}`;
      res.on("finish", () => {
        if (res.statusCode >= 400) return void (kind === "payout" ? svc.release(id) : batches.release(id));
        void (kind === "payout" ? svc.onFunded(id, payer!, tx) : batches.onFunded(id, payer!, tx));
        if (ref && mode.mandates && mandates.policy !== "off") void mode.mandates.check({ tx, ref, checkoutMandate: req.header("x-sim-signed-order") }).then((proof) => mandates.record(linesOf({ kind, id }), proof));
      });
      next();
    };
    r.use("/v1/payouts/:id/pay", simPay("payout"));
    r.use("/v1/batches/:id/pay", simPay("batch"));
  }

  r.post("/v1/batches/:id/pay", (req, res) => {
    try {
      const b = batches.accept(req.params.id);
      res.status(202).json({ ...batches.view(b.id), status_url: `/v1/batches/${b.id}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/v1/payouts/:id/pay", (req, res) => {
    try {
      const p = svc.accept(req.params.id);
      res.status(202).json({ ...publicView(p), status_url: `/v1/payouts/${p.id}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

function target(transport: unknown): { kind: "payout" | "batch"; id: string } | undefined {
  const path = (transport as { request?: { path?: string } } | undefined)?.request?.path ?? "";
  const payout = path.match(PAY)?.[1];
  if (payout) return { kind: "payout", id: payout };
  const batch = path.match(PAY_BATCH)?.[1];
  return batch ? { kind: "batch", id: batch } : undefined;
}

function sendError(res: express.Response, err: unknown) {
  if (err instanceof PayoutError) res.status(err.status).json({ error: err.message, ...(err.payout ? { payout: publicView(err.payout) } : {}) });
  else {
    emit("escalate", `Payout API error: ${String(err).slice(0, 200)}`);
    res.status(502).json({ error: "upstream error; nothing was charged" });
  }
}
