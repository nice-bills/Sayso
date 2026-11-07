// The buyer releases payment for a delivered job. The job's payout goes through Sayso, which applies
// the app's rules and the owner's approval; this function never moves money itself.
//
// Needs the same secrets as sayso-pay: SAYSO_URL and SAYSO_APP_KEY.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";

export default async function (req: Request) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { job_id } = await req.json();
  const job = await base44.asServiceRole.entities.Job.get(String(job_id));
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  // Only the buyer who posted the job can release its payment.
  if (job.buyer_email !== user.email) return Response.json({ error: "Only the buyer can release this payment" }, { status: 403 });
  if (job.status !== "delivered") return Response.json({ error: `job is ${job.status}, not delivered` }, { status: 409 });

  const freelancer = await base44.asServiceRole.entities.Freelancer.get(job.freelancer_id);
  if (!freelancer?.iban) return Response.json({ error: "freelancer has no bank details" }, { status: 422 });

  const ref = `job-${job.id}`; // same ref on retry, so a double click cannot pay twice
  const res = await fetch(`${secrets.get("SAYSO_URL")}/v1/platform/payouts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secrets.get("SAYSO_APP_KEY")}` },
    body: JSON.stringify({
      ref,
      payee_name: freelancer.name,
      amount: job.amount,
      currency: job.currency,
      reference: `JOB-${String(job.id).slice(-8)}`,
      bank: { country: freelancer.country, iban: freelancer.iban },
      context: `Payment for delivered job "${job.title}", released by the buyer.`,
    }),
  });
  const out = await res.json();
  if (!res.ok) return Response.json(out, { status: res.status });

  await base44.asServiceRole.entities.Job.update(job.id, { status: "released", sayso_ref: ref });
  return Response.json(out, { status: res.status });
}
