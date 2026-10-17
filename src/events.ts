// The agent's narration stream: every observe / decide / act / reconcile step is an event.
// The dashboard renders it live; the demo video is this stream.

import { EventEmitter } from "node:events";

export type Phase = "observe" | "decide" | "act" | "reconcile" | "escalate" | "refuse";

export interface AgentEvent {
  at: string;
  phase: Phase;
  title: string;
  detail?: Record<string, unknown>;
  /** Proof link: a Metal explorer tx or an Airwallex object id. */
  proof?: string;
}

export const bus = new EventEmitter();
const history: AgentEvent[] = [];

export function emit(phase: Phase, title: string, detail?: Record<string, unknown>, proof?: string): AgentEvent {
  const e: AgentEvent = { at: new Date().toISOString(), phase, title, detail, proof };
  history.push(e);
  if (history.length > 500) history.shift();
  bus.emit("event", e);
  console.log(`[${phase}] ${title}${proof ? ` (${proof})` : ""}`);
  return e;
}

export const recentEvents = (): AgentEvent[] => [...history];
