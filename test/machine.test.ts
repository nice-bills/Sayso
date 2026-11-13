import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { machine, machines, type Machine } from "../src/machine.js";
import { BATCH } from "../src/payouts/batch.js";
import { PAYOUT } from "../src/payouts/book.js";
import { INBOX } from "../src/inbox/inbox.js";
import { PENNY } from "../src/inbox/penny.js";
import { SWEEP } from "../src/bridge/ledger.js";
import { OAUTH_REQUEST } from "../src/agents/oauth.js";
import { AGENT_REGISTRATION } from "../src/agents/authmd.js";
import { buildSayso } from "../src/app.js";
import { recentEvents } from "../src/events.js";
import { studioBankChange, studioInvoice } from "../samples/invoices.js";
import express from "express";
import { APP_PAYOUT } from "../src/platform/platform.js";
import { openApiSpec } from "../src/platform/openapi.js";
import { publicView, PayoutService } from "../src/payouts/service.js";
import { heuristicRead } from "../src/agent/reader.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";

/** The three tables seen through the wide type, so one loop can read them all. */
const all: Array<Machine<string>> = [PAYOUT, BATCH, INBOX] as unknown as Array<Machine<string>>;

/** States you cannot get to by walking `to` from an initial state. Sorted, so the answer is stable. */
function unreachable<S extends string>(m: Machine<S>): string[] {
  const states = m.states as unknown as Record<string, { to: readonly string[] }>;
  const seen = new Set<string>(m.initial);
  const queue = [...m.initial] as string[];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of states[s]!.to) if (!seen.has(t)) { seen.add(t); queue.push(t); }
  }
  return Object.keys(states).filter((s) => !seen.has(s)).sort();
}

describe("machine tables", () => {
  it("rejects a table whose move names a state that is not declared", () => {
    expect(() => machine("bad", ["a"], {
      a: { means: "A", waitingOn: "agent", to: ["nowhere"] },
    })).toThrow("bad: a -> nowhere names a state that is not declared");
  });

  it("checks a move against the table, throwing under vitest for an undeclared one", () => {
    const local = machine("local", ["a"], {
      a: { means: "A", waitingOn: "agent", to: ["b"] },
      b: { means: "B", waitingOn: "sayso", to: ["c"] },
      c: { means: "C", waitingOn: "nobody", to: [] },
    });
    expect(() => local.check(["a"], "b")).not.toThrow();
    expect(() => local.check(["b"], "c")).not.toThrow();
    expect(() => local.check(["c"], "a")).toThrow("local: c -> a is not a declared move");
    expect(() => local.check(["a", "c"], "b")).toThrow("local: c -> b is not a declared move");
  });

  it("escalates an undeclared move as well as throwing under vitest", () => {
    const local = machine("local-escalate", ["a"], {
      a: { means: "A", waitingOn: "agent", to: ["b"] },
      b: { means: "B", waitingOn: "nobody", to: [] },
    });
    expect(() => local.check(["b"], "a")).toThrow("local-escalate: b -> a is not a declared move");
    const event = recentEvents().at(-1)!;
    expect(event.phase).toBe("escalate");
    expect(event.title).toContain("local-escalate: b -> a is not a declared move");
    expect(event.detail).toMatchObject({ machine: "local-escalate", from: ["b"], to: "a" });
  });

  it("knows the payout moves the old picture in book.ts left out", () => {
    expect(PAYOUT.can("paid", "failed")).toBe(true);
    expect(PAYOUT.can("paid", "quoted")).toBe(false);
    expect(PAYOUT.can("refunded", "paid")).toBe(false);
    expect(PAYOUT.terminal("refunded")).toBe(true);
    // A bank can return a payout after it was paid, so paid has a move out and is not final.
    expect(PAYOUT.terminal("paid")).toBe(false);
  });

  it("declares every state reachable, except the batch status kept for old records", () => {
    expect(unreachable(PAYOUT)).toEqual([]);
    expect(unreachable(INBOX)).toEqual([]);
    expect(unreachable(BATCH)).toEqual(["rejected"]);
  });

  it("waits on nobody in every final state except a refund that did not go through", () => {
    for (const m of all) {
      for (const [state, info] of Object.entries(m.states)) {
        if (info.to.length !== 0) continue;
        expect({ machine: m.name, state, waitingOn: info.waitingOn }).toEqual({ machine: m.name, state, waitingOn: m.name === "payout" && state === "refund_failed" ? "owner" : "nobody" });
      }
    }
    expect(PAYOUT.states.refund_failed.waitingOn).toBe("owner");
    expect(PAYOUT.terminal("refund_failed")).toBe(true);
  });

  it("describes one entry per state, with terminal matching an empty move list", () => {
    for (const m of all) {
      const d = m.describe();
      expect(d.name).toBe(m.name);
      expect(d.states.map((s) => s.state).sort()).toEqual(Object.keys(m.states).sort());
      for (const s of d.states) expect(s.terminal).toBe(s.to.length === 0);
    }
  });

  it("registers the machines under the names the docs and the endpoint use", () => {
    const names = Object.keys(machines);
    expect(names).toEqual(expect.arrayContaining(["payout", "batch", "invoice"]));
    expect(machines.payout!.describe().states.length).toBe(12);
    expect(machines.batch!.describe().states.length).toBe(5);
    expect(machines.invoice!.describe().states.length).toBe(7);
    expect(Object.values(machines)).toEqual(expect.arrayContaining([PAYOUT, BATCH, INBOX]));
  });
});

describe("small machines", () => {
  const small: Array<Machine<string>> = [PENNY, SWEEP, OAUTH_REQUEST, AGENT_REGISTRATION] as unknown as Array<Machine<string>>;

  it("declares every state reachable, and waits on nobody in every final state", () => {
    for (const m of small) {
      expect({ machine: m.name, unreachable: unreachable(m) }).toEqual({ machine: m.name, unreachable: [] });
      for (const [state, info] of Object.entries(m.states)) {
        if (info.to.length === 0) expect({ machine: m.name, state, waitingOn: info.waitingOn }).toEqual({ machine: m.name, state, waitingOn: "nobody" });
      }
    }
  });

  it("never reopens a closed record", () => {
    expect(PENNY.can("confirmed", "denied")).toBe(false);
    expect(OAUTH_REQUEST.can("used", "allowed")).toBe(false);
    expect(AGENT_REGISTRATION.can("issued", "claimed")).toBe(false);
    expect(SWEEP.can("credited", "rejected")).toBe(false);
  });

  it("keeps a confirmed bank-detail check confirmed when the same link is answered again", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body?: unknown) => {
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}` }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    try {
      // Pay the studio's first invoice, so there is a contact on file for the check to email.
      const first = await post("/v1/inbox", { message_id: studioInvoice.messageId, from: studioInvoice.from, subject: studioInvoice.subject, body: studioInvoice.body });
      await post(`/v1/inbox/${encodeURIComponent(first.body.id)}/approve`, { approver: "will" });
      for (let i = 0; i < 2; i++) await cs.svc.follow();

      const held = await post("/v1/inbox", { message_id: studioBankChange.messageId, from: studioBankChange.from, subject: studioBankChange.subject, body: studioBankChange.body });
      const id = encodeURIComponent(held.body.id);
      const check = await post(`/v1/inbox/${id}/penny`);
      const code = check.body.simStatementReference.slice(-6);

      const sent = recentEvents().filter((e) => e.title.startsWith("Email to billing@kreuzberg-studio.example")).at(-1)!;
      const link = base + new URL(sent.title.match(/https?:\/\/\S+/)![0]).pathname;
      const answer = (form: Record<string, string>) => fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });

      expect((await answer({ code })).status).toBe(200);
      // A second answer on the same link must not flip a confirmed check to denied.
      expect((await answer({ denied: "1" })).status).toBe(200);

      const after = await (await fetch(`${base}/v1/inbox/${id}/penny`, { headers: { authorization: `Bearer ${cs.ownerToken}` } })).json() as { check: { status: string } };
      expect(after.check.status).toBe("confirmed");
    } finally {
      server.close();
    }
  });
});

describe("published machines", () => {
  it("declares every app payout state reachable, and only the five that end it are terminal", () => {
    expect(unreachable(APP_PAYOUT)).toEqual([]);
    expect(Object.keys(APP_PAYOUT.states).filter((s) => APP_PAYOUT.terminal(s as keyof typeof APP_PAYOUT.states)).sort()).toEqual(["duplicate", "failed", "ignored", "refunded", "rejected"]);
  });

  it("explains a payout's own state in every reply", async () => {
    const store = new Store(":memory:");
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(5000), EUR: toMinor(100) }), store, refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
    const q = await svc.quote({
      amount: "280.00", currency: "EUR", reference: "INV-2026-114",
      payee: { name: "Kreuzberg Studio GmbH", address: { country_code: "DE", city: "Berlin", street_address: "Oranienstr. 1", postcode: "10999" }, bank: { iban: "DE89370400440532013000" }, bank_country_code: "DE" },
    });
    const v = publicView(svc.book.get(q.id)!);
    expect(typeof v.status_means).toBe("string");
    expect(v.status_means.length).toBeGreaterThan(0);
    expect(v.waiting_on).toBe("agent");
    expect(v.final).toBe(false);
  });

  it("publishes the app states in the OpenAPI enum, with all ten older names still there", () => {
    const spec = openApiSpec("http://x");
    const enumStates = [...spec.components.schemas.Payout.properties.state.enum].sort();
    expect(enumStates).toEqual(Object.keys(APP_PAYOUT.states).sort() as typeof enumStates);
    expect(enumStates).toEqual(expect.arrayContaining(["awaiting_approval", "needs_verification", "needs_details", "rejected", "duplicate", "ignored", "paying", "paid", "failed", "refunded"]));
  });

  it("serves every machine at GET /v1/machines", async () => {
    const app = express();
    app.get("/v1/machines", (_req, res) => res.json(Object.values(machines).map((m) => m.describe())));
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const list = await (await fetch(`http://127.0.0.1:${port}/v1/machines`)).json() as Array<{ name: string; initial: string[]; states: Array<{ state: string; means: string; waiting_on: string; terminal: boolean; to: string[] }> }>;
      expect(list.map((m) => m.name)).toEqual(expect.arrayContaining(["payout", "batch", "invoice", "app_payout"]));
      for (const m of list) {
        expect(m.initial.length).toBeGreaterThan(0);
        expect(m.states.length).toBeGreaterThan(0);
        for (const s of m.states) {
          expect(typeof s.means).toBe("string");
          expect(s.means.length).toBeGreaterThan(0);
          expect(typeof s.waiting_on).toBe("string");
          expect(typeof s.terminal).toBe("boolean");
          expect(Array.isArray(s.to)).toBe(true);
        }
      }
    } finally {
      server.close();
    }
  });
});
