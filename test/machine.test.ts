import { describe, expect, it } from "vitest";
import { machine, machines, type Machine } from "../src/machine.js";
import { BATCH } from "../src/payouts/batch.js";
import { PAYOUT } from "../src/payouts/book.js";
import { INBOX } from "../src/inbox/inbox.js";

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
