// Receives Sayso's payout events and writes them to SaysoPayout, so a job shows "waiting for approval",
// "on its way", "paid" or "refunded" as it happens.
//
// Sayso signs `Sayso-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + rawBody)>`. Anything without a
// valid, fresh signature is refused, because this endpoint writes with the service role.
import { createFileRoute } from "@tanstack/react-router";
import { secrets } from "base44:runtime";

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function valid(header, body, secret) {
  const t = Number(header.match(/t=(\d+)/)?.[1]);
  const v1 = header.match(/v1=([0-9a-f]+)/)?.[1];
  if (!secret || !t || !v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  if (want.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/sayso-webhook")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        const body = await request.text();
        if (!(await valid(request.headers.get("sayso-signature") ?? "", body, secrets.get("SAYSO_WEBHOOK_SECRET")))) {
          return Response.json({ error: "bad signature" }, { status: 401 });
        }
        const event = JSON.parse(body);
        const d = event.data ?? {};
        const payouts = context.getBase44().asServiceRole.entities.SaysoPayout;
        const [row] = await payouts.filter({ ref: d.ref });

        // Events can arrive twice or out of order: apply only what moves this payout forward.
        if (row && (row.last_event_id === event.id || (row.last_sequence ?? 0) >= event.sequence)) return Response.json({ ok: true, ignored: true });

        const patch = {
          state: d.state, approval_url: d.approval_url ?? "", reasons: d.reasons ?? [], failure: d.failure ?? "", payout_id: d.payout_id ?? "",
          last_sequence: event.sequence, last_event_id: event.id,
        };
        if (row) await payouts.update(row.id, patch);
        else await payouts.create({ ref: d.ref, payee_name: d.payee ?? "", amount: d.amount ?? "", currency: d.currency ?? "", ...patch });
        return Response.json({ ok: true });
      },
    },
  },
});
