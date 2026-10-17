// The demo screen: a live feed of the agent's events over SSE, plus the state behind them.
// A person approves flagged actions here; the approval is bound to the exact terms shown.

import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bus, recentEvents, type AgentEvent } from "../events.js";

export interface DashboardHooks {
  state: () => unknown;
  approve: (obligationId: string, approver: string) => { granted: string[] };
}

const page = () => readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

export function startDashboard(hooks: DashboardHooks, port = Number(process.env.DASHBOARD_PORT ?? 4300), mount?: (app: express.Express) => void) {
  const app = express();
  mount?.(app); // before the JSON parser: the webhook route needs the raw body
  app.use(express.json());
  app.get("/", (_req, res) => res.type("html").send(page()));
  app.get("/state", (_req, res) => res.json(hooks.state()));
  app.post("/approve/:obligationId", (req, res) => res.json(hooks.approve(req.params.obligationId, String(req.body?.approver ?? "dashboard"))));
  app.get("/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    recentEvents().forEach(send);
    bus.on("event", send);
    req.on("close", () => bus.off("event", send));
  });
  const server = app.listen(port, () => console.log(`Dashboard on http://127.0.0.1:${port}`));
  return server;
}
