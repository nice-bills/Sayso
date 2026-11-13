// The demo screen: a live feed of the agent's events over SSE, plus the state behind them.
// A person approves flagged actions here; the approval is bound to the exact terms shown.

import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bus, recentEvents, type AgentEvent } from "../events.js";

export interface DashboardHooks {
  state: () => unknown;
  /** Who is asking now; undefined once the session has ended. */
  viewFor: (req: express.Request) => "owner" | "viewer" | undefined;
  forViewer: (v: unknown) => unknown;
  approve: (id: string, approver: string, body: Record<string, unknown>) => unknown;
}

const page = () => readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

/** The operator's back office, mountable anywhere (e.g. /ops/). */
export function dashboardRouter(hooks: DashboardHooks): express.Router {
  const r = express.Router();
  r.use(express.json());
  r.get("/", (req, res, next) => (req.originalUrl.endsWith("/") ? res.type("html").send(page()) : res.redirect(req.originalUrl + "/")));
  r.get("/state", (_req, res) => res.json(hooks.state()));
  r.post("/approve/:id", async (req, res) => {
    try {
      res.json(await hooks.approve(req.params.id, String(req.body?.approver ?? "operator"), req.body ?? {}));
    } catch (err) {
      res.status((err as { status?: number }).status ?? 500).json({ error: String((err as Error).message ?? err) });
    }
  });
  r.get("/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (e: AgentEvent) => {
      if (hooks.viewFor(req) !== "viewer") return void res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (!e.private) res.write(`data: ${JSON.stringify(hooks.forViewer(e))}\n\n`);
    };
    recentEvents().forEach(send);
    bus.on("event", send);
    // A stream must not outlive its session.
    const recheck = setInterval(() => { if (!hooks.viewFor(req)) res.end(); }, 30_000);
    req.on("close", () => { clearInterval(recheck); bus.off("event", send); });
  });
  return r;
}
