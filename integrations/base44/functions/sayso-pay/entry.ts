// Pays someone through Sayso. Call it from your app: base44.functions.invoke("sayso-pay", { ... }).
//
// Secrets to set in the Base44 dashboard: SAYSO_URL (https://your-sayso-host) and SAYSO_APP_KEY (the key
// the Sayso owner made for this app). The key never reaches the browser.
//
// Sayso applies this app's plain-English rules and its own risk rules, then asks its owner to approve with a
// passkey. This function only asks; it cannot approve. Add your own business check below (who may request a payout).
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

export default async function (req: Request) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // Only app admins may ask for money to leave. Replace with your marketplace's own rule (e.g. the buyer who owns the job).
  if (user.role !== "admin") return Response.json({ error: "Only admins can request payouts" }, { status: 403 });

  const p = await req.json();
  const ref = String(p.ref ?? "");
  if (!ref) return Response.json({ error: "ref is required" }, { status: 400 });

  const res = await fetch(`${secrets.get("SAYSO_URL")}/v1/platform/payouts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.get("SAYSO_APP_KEY")}` },
    body: JSON.stringify({
      ref,
      payee_name: p.payee_name,
      amount: p.amount,
      currency: p.currency,
      reference: p.reference,
      due_date: p.due_date,
      bank: p.bank,
      address: p.address,
      context: p.context,
    }),
  });
  const out = await res.json();
  // Sayso's own rules can refuse (422); pass that on so the UI can say why.
  if (!res.ok) return Response.json(out, { status: res.status });

  // Mirror it as an entity so the UI updates live (entities.subscribe) as Sayso's events arrive.
  const existing = await base44.asServiceRole.entities.SaysoPayout.filter({ ref });
  const row = {
    ref, payee_name: out.payee ?? p.payee_name, amount: out.amount ?? p.amount, currency: out.currency ?? p.currency,
    state: out.state, approval_url: out.approval_url ?? "", reasons: out.reasons ?? [], failure: out.failure ?? "",
  };
  if (existing.length) await base44.asServiceRole.entities.SaysoPayout.update(existing[0].id, row);
  else await base44.asServiceRole.entities.SaysoPayout.create({ ...row, last_sequence: 0 });
  return Response.json(out, { status: res.status });
}
