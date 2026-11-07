import express, { type Request, type RequestHandler } from "express";
import { baseUrl } from "../auth.js";
import type { AgentKeys } from "../agents/keys.js";
import { PayoutError } from "../payouts/service.js";
import { openApiSpec } from "./openapi.js";
import { type Platform, type PlatformApp } from "./platform.js";
import { RulesError } from "./rules.js";

export function platformRouter(platform: Platform, keys: AgentKeys, requireOwner: RequestHandler): express.Router {
  const r = express.Router();
  const fail = (res: express.Response, err: unknown) => {
    if (err instanceof PayoutError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof RulesError) return void res.status(422).json({ error: err.message });
    res.status(500).json({ error: "failed" });
  };
  const appOf = (req: Request): PlatformApp | undefined => {
    const key = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const agent = key ? keys.verify(key) : undefined;
    return agent ? platform.appOfKey(agent) : undefined;
  };
  const asApp = (h: (app: PlatformApp, req: Request, res: express.Response) => Promise<void> | void): RequestHandler => async (req, res) => {
    const app = appOf(req);
    if (!app) return void res.status(401).json({ error: "send your app's Sayso key as a Bearer token (the owner makes one under Apps)" });
    try { await h(app, req, res); } catch (err) { fail(res, err); }
  };

  // The spec Base44 (or any builder) imports as a custom integration.
  r.get("/v1/platform/openapi.json", (req, res) => void res.json(openApiSpec(baseUrl(req))));

  // The owner connects an app and writes its rules.
  r.get("/v1/platform/apps", requireOwner, (_req, res) => void res.json(platform.list().map(({ rules: _r, ...a }) => ({ ...a, events: platform.eventStats(a.id) }))));
  r.post("/v1/platform/apps", requireOwner, express.json(), async (req, res) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const out = await platform.createApp(String(b.name ?? ""), typeof b.webhook_url === "string" && b.webhook_url ? b.webhook_url : null, typeof b.rules === "string" ? b.rules : "");
      // The key and webhook secret are shown once.
      res.status(201).json({ app_id: out.app.id, name: out.app.name, api_key: out.apiKey, webhook_secret: out.webhookSecret, rules_enforced: out.rules });
    } catch (err) { fail(res, err); }
  });
  r.put("/v1/platform/apps/:id/rules", requireOwner, express.json(), async (req, res) => {
    try { res.json({ rules_enforced: await platform.setRules(String(req.params.id), String(req.body?.rules ?? "")) }); } catch (err) { fail(res, err); }
  });
  r.put("/v1/platform/apps/:id/webhook", requireOwner, express.json(), (req, res) => {
    try { platform.setWebhook(String(req.params.id), req.body?.webhook_url ? String(req.body.webhook_url) : null); res.json({ ok: true }); } catch (err) { fail(res, err); }
  });
  r.post("/v1/platform/apps/:id/revoke", requireOwner, express.json(), (req, res) => {
    if (!platform.revokeApp(String(req.params.id))) return void res.status(404).json({ error: "no such app" });
    res.json({ ok: true });
  });

  // The app asks Sayso to pay someone. It can read its own payouts and nothing else.
  r.post("/v1/platform/payouts", express.json({ limit: "64kb" }), asApp(async (app, req, res) => {
    const { created, payout } = await platform.submit(app, req.body);
    res.status(created ? 201 : 200).json(payout);
  }));
  r.get("/v1/platform/payouts", asApp((app, _req, res) => void res.json(platform.listFor(app))));
  r.get("/v1/platform/payouts/:ref", asApp((app, req, res) => {
    const v = platform.view(app, String(req.params.ref));
    v ? res.json(v) : res.status(404).json({ error: "no such payout" });
  }));
  r.get("/v1/platform/rules", asApp((app, _req, res) => void res.json({ text: app.rulesText })));
  return r;
}
