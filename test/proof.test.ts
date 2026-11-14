import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import type { Anchored } from "../src/metal/receipts.js";
import type { Payout } from "../src/payouts/book.js";
import { buildProof, Disputes, judge, type Claim, type Evidence, type Proof } from "../src/payouts/proof.js";
import type { TrailStep } from "../src/trail.js";
import { Store } from "../src/store.js";

const quoteBody = (iban = "ES9121000418450200051332") => ({
  amount: "300.00", currency: "EUR", reference: "agent job",
  payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban }, bank_country_code: "ES" },
});

const proofWith = (s: Partial<Record<Evidence["id"], Evidence["status"]>>, signed = { order: false, owner: false }): Proof => ({
  payout: "p", hash: "0x", signed,
  evidence: (["order", "mandate", "approval", "funding", "delivery", "receipt"] as const).map((id) => ({ id, title: id, status: s[id] ?? "proven", detail: "" })),
});

describe("judge: a dispute settled from the proof", () => {
  const cases: Array<[Claim, Partial<Record<Evidence["id"], Evidence["status"]>>, string]> = [
    ["not_authorized", {}, "denied"],
    // The payee already has the money: never refunded on the agent's word alone.
    ["not_authorized", { mandate: "missing" }, "review"],
    ["not_authorized", { mandate: "against" }, "review"],
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
  it("answers 'never agreed to that price' with the agent's own signature, and 'not allowed' with the owner's", () => {
    expect(judge("wrong_amount", proofWith({}, { order: true, owner: true })).reason).toMatch(/signed this exact order, price included/);
    expect(judge("not_authorized", proofWith({}, { order: true, owner: true })).reason).toMatch(/owner signed the mandate/);
  });
});

describe("a denial claims only what the evidence shows", () => {
  const payout = (over: Partial<Payout> = {}): Payout => ({
    id: "p1", buyer: "0xAgent", currency: "EUR", amountMinor: 30_000, method: "LOCAL", bankCountry: "ES",
    payeeName: "Etiqueta SL", payeeHash: "h", beneficiary: {}, reference: "agent job", costMinor: 30_000, feeMinor: 300,
    totalMinor: 30_300, rateUsed: 1, status: "paid", reasons: [], createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
    fundingTx: "0x" + "a".repeat(64), transferId: "awx_transfer_1", refundTx: null, failure: null, decision: null, ...over,
  } as Payout);
  const anchored = (tx: string): Anchored => ({ status: "paid", receipt: {} as Anchored["receipt"], hash: `0x${"b".repeat(64)}` as `0x${string}`, tx, explorer: null, error: null });
  const step = (title: string): TrailStep[] => [{ at: new Date().toISOString(), kind: "payee", title }];

  it("says plainly when a not_delivered denial rests on simulated evidence", () => {
    const proof = buildProof(payout({ fundingTx: "sim:0xfund", transferId: "sim:tfr_1" }), [], [anchored("sim:0xanchor")]);
    for (const id of ["funding", "delivery", "receipt"] as const) {
      expect(proof.evidence.find((e) => e.id === id)!.simulated).toBe(true);
      expect(proof.evidence.find((e) => e.id === id)!.detail).toMatch(/simulat/i);
    }
    const j = judge("not_delivered", proof);
    expect(j.verdict).toBe("denied");
    expect(j.reason).toMatch(/simulated run/);
    expect(j.reason).not.toMatch(/reached the payee's bank|receipt on chain/);
  });

  it("a real transfer with a simulator's receipt anchor drops only the on-chain claim", () => {
    const proof = buildProof(payout(), [], [anchored("sim:0xanchor")]);
    const j = judge("not_delivered", proof);
    expect(j.verdict).toBe("denied");
    expect(j.reason).toMatch(/anchored by the simulator, not on chain/);
    expect(j.reason).not.toMatch(/receipt on chain says/);
  });

  it("a wrong_payee denial without a name check claims the account details only", () => {
    const proof = buildProof(payout(), step("The payee's bank says the account exists (name matching is off on the sandbox)"), []);
    expect(proof.nameChecked).toBe(false);
    const j = judge("wrong_payee", proof);
    expect(j.verdict).toBe("denied");
    expect(j.reason).toMatch(/no name check is on record/);
    expect(j.reason).not.toMatch(/bank confirmed/);
  });

  it("real evidence and a run name check keep the strong wording", () => {
    const proof = buildProof(payout(), step("The payee's bank says the account belongs to Etiqueta SL"), [anchored("0x" + "c".repeat(64))]);
    expect(proof.nameChecked).toBe(true);
    expect(judge("not_delivered", proof).reason).toBe("Airwallex reports the transfer reached the payee's bank, and the receipt on chain says so too.");
    expect(judge("wrong_payee", proof).reason).toBe("The money went to the bank details in the agent's own order, and the payee's bank confirmed them or the owner approved them.");
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
      expect(proof.body.evidence[1].detail).toMatch(/showed no credential/);
      expect(JSON.stringify(proof.body)).not.toMatch(/ES9121/); // no bank details

      // A stranger with the payout id can't dispute it; the owner of the mandate's account can.
      const stranger = await call("POST", `/v1/payouts/${q.body.id}/disputes`, { claim: "not_authorized" });
      expect(stranger.status).toBe(401);
      const d = await call("POST", `/v1/payouts/${q.body.id}/disputes`, { claim: "not_authorized", note: "I never allowed this" }, { "x-sim-mandate": "0xm" });
      expect(d.status).toBe(201);
      expect(d.body.dispute.verdict).toBe("denied");
      expect(d.body.dispute.reason).toMatch(/mandate allowed/);
      expect(d.body.dispute.anchor_tx).toMatch(/^sim:/);
      expect(d.body.payout.status).toBe("paid");
    } finally {
      server.close();
    }
  });

  it("sends a claim against a delivered payment to the owner, never refunds it on the agent's word, and refuses strangers", async () => {
    const { cs, server, call, owner } = await start("verify");
    try {
      cs.simMandates!.bind("0xm", { principal: "0xOwner", capCents: 40_000, budgetCents: 200_000 });
      const pay = async (headers: Record<string, string>) => {
        const q = await call("POST", "/v1/quotes", quoteBody());
        await call("POST", q.body.pay_url, undefined, headers);
        for (let i = 0; i < 3; i++) await cs.tick();
        return q.body.id as string;
      };
      const bare = { "x-sim-payer": "0xBareAgent" };
      const a = await pay(bare); // paid from a bare key, under no mandate
      const b = await pay({ "x-sim-mandate": "0xm" });

      // The hole the audit found: anyone with the payout id could get a delivered payout refunded.
      for (const headers of [{}, { "x-sim-payer": "0xSomeoneElse" }] as Array<Record<string, string>>) {
        const r = await call("POST", `/v1/payouts/${a}/disputes`, { claim: "not_authorized", by: "the paying agent" }, headers);
        expect(r.status).toBe(401);
      }
      expect(cs.svc.book.get(a)!.status).toBe("paid");

      // Something the proof doesn't cover goes to the owner, who can still refund it with their passkey.
      const other = await call("POST", `/v1/payouts/${b}/disputes`, { claim: "other", note: "duplicate job" }, owner);
      expect(other.body.dispute.verdict).toBe("review");
      expect(other.body.dispute.by).toBe("you");
      expect((await call("POST", `/v1/payouts/${b}/disputes`, { claim: "other" }, owner)).status).toBe(409);
      const kept = await call("POST", `/v1/payouts/${b}/dispute/deny`, {}, owner);
      expect(kept.body.dispute.verdict).toBe("denied_by_owner");

      // The real payer, under no mandate: the payee has the money, so it waits for the owner, unrefunded.
      const claimed = await call("POST", `/v1/payouts/${a}/disputes`, { claim: "not_authorized" }, bare);
      expect(claimed.status).toBe(201);
      expect(claimed.body.dispute.verdict).toBe("review");
      expect(claimed.body.dispute.by).toMatch(/^the paying agent/);
      await new Promise((r) => setTimeout(r, 30));
      expect(cs.svc.book.get(a)!.status).toBe("paid");
      expect((await call("POST", `/v1/payouts/${a}/disputes`, { claim: "not_authorized" }, bare)).status).toBe(409);
    } finally {
      server.close();
    }
  });

  it("checks the owner's signature when the agent shows the credential it was given", async () => {
    const { cs, server, call, owner } = await start();
    try {
      cs.simMandates!.bind("0xm", { principal: "0xOwner", capCents: 40_000, budgetCents: 70_000 });
      const q = await call("POST", "/v1/quotes", quoteBody());
      await call("POST", q.body.pay_url, { mandate_credential: { layer1: "x" }, mandate_issuer: { iss: "self", kid: "k", jwk: {} } }, { "x-sim-mandate": "0xm", "x-sim-signed-order": "sim" });
      for (let i = 0; i < 3; i++) await cs.tick();
      const proof = await call("GET", `/v1/payouts/${q.body.id}/proof`);
      expect(proof.body.evidence[1].detail).toMatch(/owner's signature and the issuer's match/);
      expect(proof.body.signed).toEqual({ order: true, owner: true });
      const d = await call("POST", `/v1/payouts/${q.body.id}/disputes`, { claim: "wrong_amount", note: "my agent never agreed to that price" }, owner);
      expect(d.body.dispute.verdict).toBe("denied");
      expect(d.body.dispute.reason).toMatch(/signed this exact order, price included/);
    } finally {
      server.close();
    }
  });
});

describe("Disputes anchoring", () => {
  it("retries the anchor of a denied dispute", () => {
    const d = new Disputes(new Store(":memory:"));
    const base = { payout: "p1", claim: "not_received" as Claim, note: "", by: "agent", reason: "r", cites: [], proof_hash: "0xabc" };
    const denied = d.add({ ...base, verdict: "denied" });
    d.add({ ...base, verdict: "upheld" });
    expect(d.unanchored().map((x) => x.id)).toEqual([denied.id]);
    d.anchored(denied.id, "sim:0x1");
    expect(d.unanchored()).toEqual([]);
  });
});
