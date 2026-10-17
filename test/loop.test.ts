import { describe, expect, it } from "vitest";
import { Agent, type AgentDeps } from "../src/agent/loop.js";
import { RampLedger } from "../src/bridge/ledger.js";
import { SimulatedDepositCredit } from "../src/bridge/deposit-credit.js";
import { beneficiaries, churnEmail, heistEmail, obligations, policyConfig } from "../src/scenario.js";
import { FakeAirwallex, FakeMandate, FakeSwarm } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { ApprovalGate } from "../src/treasury/approval.js";
import { toMinor } from "../src/treasury/money.js";

function setup(confidence = 0.85) {
  const store = new Store(":memory:");
  const ledger = new RampLedger(":memory:");
  const awx = new FakeAirwallex({ USD: toMinor(400), EUR: toMinor(10) });
  const swarm = new FakeSwarm(ledger);
  const ben = beneficiaries(false);
  const now = new Date("2026-11-02T09:00:00Z");
  const deps: AgentDeps = {
    awx, store, ledger, verifier: new FakeMandate("0xramp", toMinor(500)), credit: new SimulatedDepositCredit(awx, "sim:ga"), earnings: swarm,
    gate: new ApprovalGate(), approvals: new Map(), evidenceHash: () => "ev", reference: (id) => id, baseCurrency: "USD", cfg: policyConfig,
    obligations: obligations(now, ben), allowlist: new Set(Object.values(ben)), forecast: { expectedInflowMinor: toMinor(300), confidence },
  };
  return { agent: new Agent(deps), awx, swarm, store, ledger, now };
}

describe("Agent loop (offline)", () => {
  it("sweeps once, pays what it may autonomously, and holds the rest for approval", async () => {
    const { agent, awx, swarm, store, ledger, now } = setup();
    await swarm.run(4, 10);
    await agent.tick(now);
    await agent.tick(now); // a second tick must not pay or sweep again
    expect(ledger.creditedMinor("USD")).toBe(40);
    const paid = store.ops().filter((o) => o.kind === "pay").map((o) => o.obligationId).sort();
    // High confidence: everything under USD 100 is autonomous; the USD 150 licence waits for a person.
    expect(paid).toEqual(["contractor-wk45", "designer-nov", "office-rent-nov"]);
    expect(awx.balances.EUR).toBe(0);
  });

  it("tightens limits when an email contradicts the forecast", async () => {
    const { agent, store, now } = setup();
    agent.inbox.push(churnEmail);
    await agent.tick(now);
    const paid = store.ops().filter((o) => o.kind === "pay").map((o) => o.obligationId).sort();
    expect(paid).toEqual(["contractor-wk45", "designer-nov"]);
  });

  it("never changes where money goes because an email asked", async () => {
    const { agent, store, now } = setup();
    agent.inbox.push(heistEmail);
    await agent.tick(now);
    expect(agent.flagged).toHaveLength(1);
    expect(agent.flagged[0]!.addresses).toEqual(["0x9f3a6C0b9a2b9E3d7F1c5aE4B2d8C6e0F1a2B3c4"]);
    const rent = store.latestOp("office-rent-nov", "pay");
    expect(rent?.status).toBe("submitted"); // still paid, to the verified beneficiary on file
  });
});
