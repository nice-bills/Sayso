// Receives Sayso's payout events and writes them to the SaysoPayout entity, so the app's UI shows
// "waiting for approval", "paying", "paid" or "refunded" live.
//
// Secret to set: SAYSO_WEBHOOK_SECRET (the whsec_ value Sayso showed once when the app was connected).
// Give Sayso this function's URL as the webhook_url: https://<your-app-domain>/functions/sayso-webhook
//
// Sayso signs `Sayso-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + rawBody)>`. Anything without a valid,
// fresh signature is refused, because this endpoint writes with the service role.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function valid(header: string, body: string, secret: string): Promise<boolean> {
  const t = Number(header.match(/t=(\d+)/)?.[1]);
  const v1 = header.match(/v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  if (want.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export default async function (req: Request) {
  const body = await req.text();
  if (!(await valid(req.headers.get("sayso-signature") ?? "", body, secrets.get("SAYSO_WEBHOOK_SECRET")))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  const event = JSON.parse(body) as { id: string; type: string; sequence: number; data: Record<string, any> };
  const d = event.data;
  const base44 = createClientFromRequest(req);
  const rows = await base44.asServiceRole.entities.SaysoPayout.filter({ ref: d.ref });
  const row = rows[0];

  // Events can arrive twice or out of order: apply only what moves this payout forward.
  if (row && (row.last_event_id === event.id || (row.last_sequence ?? 0) >= event.sequence)) return Response.json({ ok: true, ignored: true });

  const patch = {
    state: d.state, approval_url: d.approval_url ?? "", reasons: d.reasons ?? [], failure: d.failure ?? "",
    last_sequence: event.sequence, last_event_id: event.id,
  };
  if (row) await base44.asServiceRole.entities.SaysoPayout.update(row.id, patch);
  else await base44.asServiceRole.entities.SaysoPayout.create({ ref: d.ref, payee_name: d.payee ?? "", amount: d.amount ?? "", currency: d.currency ?? "", ...patch });
  return Response.json({ ok: true });
}
