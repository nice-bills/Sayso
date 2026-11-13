// One table per state machine: which states exist, what each means, who has to act next, and where it can go.
// The tables are the source of truth for the types, for the checks on every state change, and for what
// agents and apps are told about states (GET /v1/machines).

import { emit } from "./events.js";

/** Who has to act before this state can change. "nobody" means the state is final. */
export type WaitingOn = "agent" | "owner" | "payee" | "bank" | "sayso" | "nobody";

export interface StateInfo<S extends string> {
  /** One plain sentence for a person or an agent reading the state. */
  means: string;
  waitingOn: WaitingOn;
  /** The states this one can move to. Empty means final. */
  to: readonly S[];
}

export interface Machine<S extends string> {
  name: string;
  /** States a new record can start in. */
  initial: readonly S[];
  states: Readonly<Record<S, StateInfo<S>>>;
  terminal(s: S): boolean;
  can(from: S, to: S): boolean;
  /** Call before a compare-and-set: every state in `from` must be allowed to move to `to`. */
  check(from: readonly S[], to: S): void;
  /** Plain data for docs, agents and apps. */
  describe(): { name: string; initial: readonly S[]; states: Array<{ state: S; means: string; waiting_on: WaitingOn; terminal: boolean; to: readonly S[] }> };
}

// `T` is inferred from the table itself, so the state names stay literal and a status type derived from a
// table (keyof typeof X.states) is the union of its state names rather than plain `string`. `to` values are
// plain strings here so a table that names an undeclared state still compiles and is caught by the runtime
// check below.
export function machine<const T extends Record<string, StateInfo<string>>>(name: string, initial: readonly (keyof T & string)[], states: T): Machine<keyof T & string> {
  type S = keyof T & string;
  const table = states as unknown as Record<S, StateInfo<S>>;
  const all = Object.keys(table) as S[];
  for (const s of all) for (const t of table[s].to) if (!(t in table)) throw new Error(`${name}: ${s} -> ${t} names a state that is not declared`);
  for (const s of initial) if (!(s in table)) throw new Error(`${name}: initial state ${s} is not declared`);
  const can = (from: S, to: S) => table[from]?.to.includes(to) ?? false;
  return {
    name, initial, states: table, can,
    terminal: (s) => table[s].to.length === 0,
    check(from, to) {
      const bad = from.filter((f) => !can(f, to));
      if (!bad.length) return;
      const message = `${name}: ${bad.join(", ")} -> ${to} is not a declared move`;
      emit("escalate", `A record tried a move its table doesn't allow: ${message}`, { machine: name, from: bad, to });
      // shortcut: an undeclared move only fails under test and is logged in production, so a gap in a table cannot stop a payout; throw everywhere once the tables have run in production for a while.
      if (process.env.VITEST) throw new Error(message);
      console.error(`[machine] ${message}`);
    },
    describe: () => ({ name, initial, states: all.map((s) => ({ state: s, means: table[s].means, waiting_on: table[s].waitingOn, terminal: table[s].to.length === 0, to: table[s].to })) }),
  };
}

/** Every machine by name, filled in by the modules that declare them. */
export const machines: Record<string, Machine<string>> = {};
export function register<S extends string>(m: Machine<S>): Machine<S> {
  machines[m.name] = m as unknown as Machine<string>;
  return m;
}
