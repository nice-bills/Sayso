// The public API. Agents pay for payouts over x402: the price of POST /v1/payouts/:id/pay is the
// quote's total, so the 402 response itself tells the agent exactly what it will be charged.
//
//   POST /v1/quotes            free   -> quote (or needs_review / rejected, with reasons)
//   POST /v1/payouts/:id/pay   x402   -> 202 accepted; fiat moves only after the payment settles
//   GET  /v1/payouts/:id       free   -> status, transfer id, refund tx
//
// x402's Express middleware settles only when the handler answers < 400, and only after it, so:
// the handler locks the quote; the after-settle hook starts the payout; a failed settlement
// releases the quote.

import express, { type Router } from "express";
import { paymentMiddleware } from "@x402/express";
import type { x402ResourceServer } from "@x402/core/server";
import { emit } from "../events.js";
import { PayoutError, publicView, type PayoutService } from "./service.js";

export type PaymentMode =
  | { kind: "x402"; server: x402ResourceServer; network: string; payTo: string }
  /** Offline: the request names its payer in x-sim-payer and is treated as settled. */
  | { kind: "sim" };

const PAY = /^\/v1\/payouts\/([0-9a-f-]{36})\/pay$/;

export function payoutApi(svc: PayoutService, mode: PaymentMode): Router {
  const r = express.Router();
  r.use(express.json({ limit: "64kb" }));

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
    mode.server.onAfterSettle(async (ctx) => {
      const id = idFrom(ctx.transportContext);
      if (!id || !ctx.result.success) return;
      // Do not hold the buyer's response on the bank: the payout runs after the reply.
      void svc.onFunded(id, ctx.result.payer ?? "", ctx.result.transaction).catch((e) => emit("escalate", `Payout ${id.slice(0, 8)} crashed after funding: ${String(e)}`));
    });
    mode.server.onSettleFailure(async (ctx) => { const id = idFrom(ctx.transportContext); if (id) svc.release(id); });
    mode.server.onVerifiedPaymentCanceled(async (ctx) => { const id = idFrom(ctx.transportContext); if (id) svc.release(id); });
    r.use(paymentMiddleware({
      "POST /v1/payouts/:id/pay": {
        accepts: [{
          scheme: "exact",
          network: mode.network,
          payTo: mode.payTo,
          price: (ctx: { path: string }) => svc.priceOf(ctx.path.match(PAY)?.[1] ?? "") ?? "0",
        }],
        description: "Pay a real-world invoice in local currency through Airwallex",
      },
    } as Parameters<typeof paymentMiddleware>[0], mode.server));
  } else {
    r.use("/v1/payouts/:id/pay", (req, res, next) => {
      const payer = req.header("x-sim-payer");
      if (!payer) return void res.status(402).json({ error: "payment required", price_usdz: svc.priceOf(String(req.params.id)) });
      res.on("finish", () => {
        if (res.statusCode < 400) void svc.onFunded(String(req.params.id), payer, `sim:0xsettle${String(req.params.id).slice(0, 8)}`);
        else svc.release(String(req.params.id));
      });
      next();
    });
  }

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

function idFrom(transport: unknown): string | undefined {
  const path = (transport as { request?: { path?: string } } | undefined)?.request?.path ?? "";
  return path.match(PAY)?.[1];
}

function sendError(res: express.Response, err: unknown) {
  if (err instanceof PayoutError) res.status(err.status).json({ error: err.message, ...(err.payout ? { payout: publicView(err.payout) } : {}) });
  else {
    emit("escalate", `Payout API error: ${String(err).slice(0, 200)}`);
    res.status(502).json({ error: "upstream error; nothing was charged" });
  }
}
