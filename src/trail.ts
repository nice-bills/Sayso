// Why a payment happened, step by step: what was said or emailed, what Claude read in it, what
// the rules decided, whose account the bank says it is, which Metal mandate authorized the money,
// what Airwallex did, and the receipt anchored on chain. Every step carries its proof when it has one.
//
// Most steps are the narration events that already name a payout; the rest (the words heard,
// a mandate's verification) are added directly.

import { bus, type AgentEvent } from "./events.js";
import type { Store } from "./store.js";

export type TrailKind = "heard" | "source" | "read" | "risk" | "payee" | "mandate" | "escrow" | "receipt" | AgentEvent["phase"];

export interface TrailStep {
  at: string;
  kind: TrailKind;
  title: string;
  detail?: Record<string, unknown>;
  proof?: string;
}

export class Trail {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS trail (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, payout_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, detail TEXT, proof TEXT
    );
    CREATE INDEX IF NOT EXISTS trail_payout ON trail (payout_id, seq);`);
  }

  add(payoutId: string, kind: TrailKind, title: string, detail?: Record<string, unknown>, proof?: string, at = new Date()): void {
    this.store.db.prepare("INSERT INTO trail (payout_id, at, kind, title, detail, proof) VALUES (?, ?, ?, ?, ?, ?)")
      .run(payoutId, at.toISOString(), kind, title, detail ? JSON.stringify(detail) : null, proof ?? null);
  }

  for(payoutId: string): TrailStep[] {
    return this.store.db.prepare("SELECT at, kind, title, detail, proof FROM trail WHERE payout_id = ? ORDER BY seq").all(payoutId).map((r) => {
      const x = r as { at: string; kind: TrailKind; title: string; detail: string | null; proof: string | null };
      return { at: x.at, kind: x.kind, title: x.title, ...(x.detail ? { detail: JSON.parse(x.detail) } : {}), ...(x.proof ? { proof: x.proof } : {}) };
    });
  }

  /** The latest step of one kind, e.g. the mandate that paid. */
  last(payoutId: string, kind: TrailKind): TrailStep | undefined {
    return this.for(payoutId).filter((s) => s.kind === kind).at(-1);
  }

  /** Records every narration event that names a payout. Returns the unsubscribe. */
  follow(): () => void {
    const on = (e: AgentEvent) => {
      const id = e.detail?.payout;
      if (typeof id !== "string") return;
      const { payout: _, ...rest } = e.detail!;
      this.add(id, e.phase, e.title, Object.keys(rest).length ? rest : undefined, e.proof, new Date(e.at));
    };
    bus.on("event", on);
    return () => bus.off("event", on);
  }
}
