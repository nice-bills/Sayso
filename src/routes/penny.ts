// The one-cent code check: the payee's side, reached from the email sent to the contact on file.
// Plain HTML forms, no script, so it works in any mail app's browser.

import express from "express";
import { last4, type PennyChecks } from "../inbox/penny.js";
import type { PayoutService } from "../payouts/service.js";

export function pennyPages(penny: PennyChecks, svc: PayoutService): express.Router {
  const router = express.Router();
  const pennyPage = (res: express.Response, status: number, body: string) => {
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayso: confirm your bank details</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 16px;color:#111;background:#fafafa}h1{font-size:1.3rem}input{font:inherit;font-size:1.6rem;letter-spacing:.3em;width:100%;padding:.5rem;box-sizing:border-box;border:1px solid #bbb;border-radius:10px}button{font:inherit;width:100%;padding:.75rem;margin-top:.75rem;border:0;border-radius:10px;background:#111;color:#fff}.no{background:none;color:#b00020;border:1px solid #e3b5bc}.m{padding:.75rem;border-radius:10px;background:#eef}</style></head><body>${body}</body></html>`);
  };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  router.get("/v/:token", (req, res) => {
    const c = penny.byToken(String(req.params.token));
    if (!c) return pennyPage(res, 404, "<h1>This link isn't valid.</h1>");
    if (c.status !== "sent") return pennyPage(res, 200, `<h1>${c.status === "confirmed" ? "Already confirmed. Thank you." : "This check is closed."}</h1>`);
    const p = svc.book.get(c.payoutId);
    const who = esc(c.item?.fields.payeeName ?? "you");
    pennyPage(res, 200, `<h1>Did ${who} change its bank details?</h1><p>Someone sent an invoice asking to be paid ${esc(p ? `${(p.amountMinor / 100).toFixed(2)} ${p.currency}` : "")} into an account ending <b>${esc(p ? last4(p.beneficiary) : "")}</b>.</p><p>If that account is yours, we sent it 0.01 with a 6-digit code in the reference. Enter the code:</p>
<form method="post"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button>Confirm</button></form>
<form method="post"><input type="hidden" name="denied" value="1"><button class="no">These aren't our bank details</button></form>`);
  });
  router.post("/v/:token", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const r = penny.answer(String(req.params.token), { code: String(req.body?.code ?? ""), denied: req.body?.denied === "1" });
    pennyPage(res, r.ok ? 200 : 400, `<h1>${esc(r.message)}</h1>${!r.ok && /left/.test(r.message) ? `<form method="get"><button>Try again</button></form>` : ""}`);
  });
  return router;
}
