// Freelance Hub's server side. Every function is a public endpoint, so each one checks who is calling
// before it touches data with the service role. Money never moves here: releasing a job only asks Sayso,
// which applies this app's rules and waits for its owner's passkey.
import { createServerFn } from "@tanstack/react-start";
import { secrets } from "base44:runtime";
import { z } from "zod";
import { requireUser } from "@/lib/auth-middleware";

const svc = (context) => context.getBase44().asServiceRole.entities;
const jobOf = (context, id) => svc(context).Job.get(id).catch(() => null);

// Sayso anchors a hash of every final payout's receipt on Metal a moment after it is paid. Look it up once
// and keep the explorer link, so the buyer can check the payout on chain without trusting us or Sayso.
async function metalUrl(context, p) {
  if (p.metal_url || !p.payout_id || !["paid", "refunded"].includes(p.state)) return p.metal_url ?? "";
  const out = await fetch(`${secrets.get("SAYSO_URL")}/v1/payouts/${p.payout_id}/receipt`).then((r) => r.json()).catch(() => null);
  const url = out?.anchors?.find((a) => a.explorer)?.explorer ?? "";
  if (/^https:\/\//.test(url)) await svc(context).SaysoPayout.update(p.id, { metal_url: url });
  return url;
}

export const listFreelancers = createServerFn({ method: "GET" })
  .middleware([requireUser])
  // Bank details stay on the server: buyers only need a name to pick.
  .handler(async ({ context }) => (await svc(context).Freelancer.list()).map(({ id, name, country }) => ({ id, name, country })));

export const addFreelancer = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator(z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200),
    country: z.string().trim().length(2),
    iban: z.string().trim().min(10).max(40),
  }))
  .handler(async ({ data, context }) => {
    if (context.user.role !== "admin") return { error: "Only admins can add freelancers" };
    await svc(context).Freelancer.create({ ...data, country: data.country.toUpperCase(), iban: data.iban.replace(/\s+/g, "").toUpperCase() });
    return { ok: true };
  });

export const myJobs = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const mine = { buyer_email: context.user.email };
    const [jobs, payouts] = await Promise.all([svc(context).Job.filter(mine, "-created_date", 50), svc(context).SaysoPayout.filter(mine, "-created_date", 50)]);
    const admin = context.user.role === "admin";
    return Promise.all(jobs.map(async (j) => {
      const p = payouts.find((x) => x.ref === j.sayso_ref);
      return {
        id: j.id, title: j.title, freelancer_name: j.freelancer_name, amount: j.amount, currency: j.currency, status: j.status,
        // Only the Sayso owner can approve, so only admins get the link.
        payout: p ? { state: p.state, reasons: p.reasons ?? [], failure: p.failure ?? "", approval_url: admin ? p.approval_url ?? "" : "", metal_url: await metalUrl(context, p) } : null,
      };
    }));
  });

export const postJob = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator(z.object({
    title: z.string().trim().min(1).max(160),
    freelancer_id: z.string().min(1).max(64),
    amount: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, "Amount like 480.00"),
    currency: z.enum(["EUR", "GBP", "USD"]),
  }))
  .handler(async ({ data, context }) => {
    const freelancer = await svc(context).Freelancer.get(data.freelancer_id).catch(() => null);
    if (!freelancer) return { error: "No such freelancer" };
    await svc(context).Job.create({ ...data, freelancer_name: freelancer.name, buyer_email: context.user.email, status: "in_progress" });
    return { ok: true };
  });

// shortcut: the buyer confirms delivery, because freelancers have no login here; give them one when they need to deliver themselves.
export const markDelivered = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator(z.object({ job_id: z.string().min(1).max(64) }))
  .handler(async ({ data, context }) => {
    const job = await jobOf(context, data.job_id);
    if (!job || job.buyer_email !== context.user.email) return { error: "No such job" };
    if (job.status !== "in_progress") return { error: `This job is ${job.status}` };
    await svc(context).Job.update(job.id, { status: "delivered" });
    return { ok: true };
  });

export const releasePayment = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator(z.object({ job_id: z.string().min(1).max(64) }))
  .handler(async ({ data, context }) => {
    const job = await jobOf(context, data.job_id);
    // Only the buyer who posted the job can release its payment.
    if (!job || job.buyer_email !== context.user.email) return { error: "No such job" };
    if (job.status !== "delivered") return { error: `This job is ${job.status}, not delivered` };
    const freelancer = await svc(context).Freelancer.get(job.freelancer_id).catch(() => null);
    if (!freelancer?.iban) return { error: "The freelancer has no bank details" };

    const ref = `job-${job.id}`; // the same ref on a retry, so a double click cannot pay twice
    const res = await fetch(`${secrets.get("SAYSO_URL")}/v1/platform/payouts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secrets.get("SAYSO_APP_KEY")}` },
      body: JSON.stringify({
        ref, payee_name: freelancer.name, amount: job.amount, currency: job.currency,
        reference: `JOB-${String(job.id).slice(-8)}`,
        bank: { country: freelancer.country, iban: freelancer.iban },
        context: `Payment for delivered job "${job.title}", released by the buyer.`,
      }),
    });
    const out = await res.json().catch(() => ({}));
    // Sayso's rules can refuse; pass the reason on so the buyer sees why.
    if (!res.ok) return { error: out.error ?? `Sayso refused this payout (${res.status})`, reasons: out.reasons ?? [] };

    const row = { buyer_email: job.buyer_email, payee_name: out.payee ?? freelancer.name, amount: out.amount ?? job.amount, currency: out.currency ?? job.currency };
    const [existing] = await svc(context).SaysoPayout.filter({ ref });
    // The webhook may have got here first; never overwrite a state it already applied.
    if (existing) await svc(context).SaysoPayout.update(existing.id, row);
    else await svc(context).SaysoPayout.create({ ...row, ref, state: out.state, approval_url: out.approval_url ?? "", reasons: out.reasons ?? [], failure: out.failure ?? "", last_sequence: 0 });
    await svc(context).Job.update(job.id, { status: "released", sayso_ref: ref });
    return { ok: true, state: out.state };
  });
