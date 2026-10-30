import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { judge, type Claim, type Evidence, type Proof } from "../src/payouts/proof.js";

const quoteBody = (iban = "ES9121000418450200051332") => ({
  amount: "300.00", currency: "EUR", reference: "agent job",
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban }, bank_country_code: "ES" },
});

const proofWith = (s: Partial<Record<Evidence["id"], Evidence["status"]>>): Proof => ({
  payout: "p", hash: "0x",
  evidence: (["order", "mandate", "approval", "funding", "delivery", "receipt"] as const).map((id) => ({ id, title: id, status: s[id] ?? "proven", detail: "" })),
});

describe("judge: a dispute settled from the proof", () => {
  const cases: Array<[Claim, Partial<Record<Evidence["id"], Evidence["status"]>>, string]> = [
    ["not_authorized", {}, "denied"],
    ["not_authorized", { mandate: "missing" }, "upheld"],
    ["not_authorized", { mandate: "against" }, "upheld"],
    ["wrong_amount", {}, "denied"],
    ["wrong_amount", { funding: "missing" }, "review"],
    ["not_delivered", {}, "denied"],
    ["not_delivered", { delivery: "against" }, "upheld"],
    ["not_delivered", { delivery: "missing" }, "review"],
    ["wrong_payee", {}, "denied"],
    ["wrong_payee", { approval: "against" }, "upheld"],
    ["other", {}, "review"],
  ];
  it.each(cases)("%s with %j is %s", (claim, evidence, verdict) => {
    expect(judge(claim, proofWith(evidence)).verdict).toBe(verdict);
  });
});

async function start(policy = "required") {
  process.env.SAYSO_AGENT_MANDATES = policy;
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const owner = { authorization: `Bearer ${cs.ownerToken}` };
  return { cs, server, call, owner };
}

afterEach(() => { delete process.env.SAYSO_AGENT_MANDATES; });

describe("prove it: what Sayso shows when an agent's purchase is questioned", () => {
  it("proves an agent's payout from the record, denies a dispute the proof answers, and anchors that answer", async () => {
    const { cs, server, call } = await start();
    try {
      cs.simMandates!.bind("0xm", { principal: "0xOwner", capCents: 40_000, budgetCents: 70_000 });
      const q = await call("POST", "/v1/quotes", quoteBody());
      expect((await call("POST", q.body.pay_url, undefined, { "x-sim-mandate": "0xm", "x-sim-signed-order": "sim" })).status).toBe(202);
      for (let i = 0; i < 3; i++) await cs.tick();
      expect(cs.svc.book.get(q.body.id)!.status).toBe("paid");

      // Anyone holding the payout id can check it, with no sign-in.
      const proof = await call("GET", `/v1/payouts/${q.body.id}/proof`);
      expect(proof.status).toBe(200);
      expect(Object.fromEntries(proof.body.evidence.map((e: Evidence) => [e.id, e.status]))).toEqual({ order: "proven", mandate: "proven", approval: "proven", funding: "proven", delivery: "proven", receipt: "proven" });
      expect(proof.body.evidence[0].detail).toMatch(/signed this exact order/);
      expect(JSON.stringify(proof.body)).not.toMatch(/ES9121/); // no bank details

      const d = await call("POST", `/v1/payouts/${q.body.id}/disputes`, { claim: "not_authorized", note: "I never allowed this" });
      expect(d.status).toBe(201);
      expect(d.body.dispute.verdict).toBe("denied");
      expect(d.body.dispute.reason).toMatch(/mandate allowed/);
      expect(d.body.dispute.anchor_tx).toMatch(/^sim:/);
      expect(d.body.payout.status).toBe("paid");
    } finally {
      server.close();
    }
  });

  it("refunds when the proof contradicts the payout, and leaves an unsettled claim to the owner", async () => {
    const { cs, server, call, owner } = await start("verify");
    try {
      cs.simMandates!.bind("0xm", { principal: "0xOwner", capCents: 40_000, budgetCents: 200_000 });
      const pay = async (headers: Record<string, string>) => {
        const q = await call("POST", "/v1/quotes", quoteBody());
        await call("POST", q.body.pay_url, undefined, headers);
        for (let i = 0; i < 3; i++) await cs.tick();
        return q.body.id as string;
      };
      const a = await pay({ "x-sim-payer": "0xBareAgent" }); // paid from a bare key, under no mandate
      const b = await pay({ "x-sim-mandate": "0xm" });

      // Something the proof doesn't cover goes to the owner, who can still refund it with their passkey.
      const other = await call("POST", `/v1/payouts/${b}/disputes`, { claim: "other", note: "duplicate job" });
      expect(other.body.dispute.verdict).toBe("review");
      expect((await call("POST", `/v1/payouts/${b}/disputes`, { claim: "other" })).status).toBe(409);
      const kept = await call("POST", `/v1/payouts/${b}/dispute/deny`, {}, owner);
      expect(kept.body.dispute.verdict).toBe("denied_by_owner");

      // No mandate on record: Sayso can't show the agent was allowed, so it refunds.
      const upheld = await call("POST", `/v1/payouts/${a}/disputes`, { claim: "not_authorized" });
      expect(upheld.body.dispute.verdict).toBe("upheld");
      await new Promise((r) => setTimeout(r, 30));
      expect(cs.svc.book.get(a)!.status).toBe("refunded");
      expect((await call("POST", `/v1/payouts/${a}/disputes`, { claim: "not_authorized" })).status).toBe(409);
    } finally {
      server.close();
    }
  });
});
