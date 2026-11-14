import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { sign } from "../src/airwallex/webhooks.js";
import { AgentKeys } from "../src/agents/keys.js";
import { Inbox } from "../src/inbox/inbox.js";
import { Platform, checkWebhookUrl, signWebhook, verifyWebhook } from "../src/platform/platform.js";
import { checkRules, describeRules, NO_RULES, parseRulesByPattern, RulesError, compileRules } from "../src/platform/rules.js";
import { PayoutService } from "../src/payouts/service.js";
import { FakeAirwallex, FakeRefunder } from "../src/sim/offline.js";
import { Store } from "../src/store.js";
import { toMinor } from "../src/treasury/money.js";
import { heuristicRead } from "../src/agent/reader.js";

const OWNER = { authorization: "Bearer sayso-demo", "content-type": "application/json" };
const payout = (over: Record<string, unknown> = {}) => ({
  ref: "job-1", payee_name: "Lingua Freelance", amount: "120.00", currency: "EUR", reference: "INV-1",
  bank: { iban: "DE89370400440532013000" }, context: "Invoice for the translation job", ...over,
});

describe("plain-English rules", () => {
  it("turns sentences into limits, and describes what the code will enforce", () => {
    const { rules, unparsed } = parseRulesByPattern("Never pay more than €500 per payout. Only pay EUR and GBP. Max 5,000 EUR a month. Never pay to RU and KP. Every payout needs a reference.");
    expect(unparsed).toEqual([]);
    expect(rules).toMatchObject({ maxPerPayout: { amount: 500, currency: "EUR" }, maxPerMonth: { amount: 5000, currency: "EUR" }, currencies: ["EUR", "GBP"], blockedCountries: ["RU", "KP"], requireReference: true });
    expect(describeRules(rules)).toHaveLength(5);
  });

  it("refuses to save rules it cannot enforce instead of dropping a sentence", async () => {
    await expect(compileRules("Max 100 EUR per payout. Be nice to freelancers.")).rejects.toThrow(RulesError);
    await expect(compileRules("Max 100 per payout")).rejects.toThrow(/currency/);
  });

  it("only ever refuses; a cap in another currency fails closed", () => {
    const { rules } = parseRulesByPattern("No more than 500 EUR per payout. Max 900 EUR a month.");
    const base = { bankCountry: "DE", reference: "x", spentThisMonthMinor: () => 0 };
    expect(checkRules(rules, { ...base, amountMinor: 50_000, currency: "EUR" })).toEqual([]);
    expect(checkRules(rules, { ...base, amountMinor: 50_001, currency: "EUR" })[0]).toMatch(/per-payout limit/);
    expect(checkRules(rules, { ...base, amountMinor: 1_000, currency: "GBP" })[0]).toMatch(/send this payout in EUR/);
    expect(checkRules(rules, { ...base, amountMinor: 50_000, currency: "EUR", spentThisMonthMinor: () => 45_000 })[0]).toMatch(/this month/);
    expect(checkRules(NO_RULES, { ...base, amountMinor: 1, currency: "JPY" })).toEqual([]);
  });
});

describe("webhook signatures", () => {
  it("verifies, and rejects tampering, the wrong secret and stale timestamps", () => {
    const sig = signWebhook("whsec_a", '{"a":1}', 1_000);
    expect(verifyWebhook("whsec_a", sig, '{"a":1}', 300, 1_100)).toBe(true);
    expect(verifyWebhook("whsec_a", sig, '{"a":2}', 300, 1_100)).toBe(false);
    expect(verifyWebhook("whsec_b", sig, '{"a":1}', 300, 1_100)).toBe(false);
    expect(verifyWebhook("whsec_a", sig, '{"a":1}', 300, 2_000)).toBe(false);
  });
  it("accepts only public https hosts outside offline mode", () => {
    for (const bad of ["http://example.com/x", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/x", "https://192.168.1.2/x"]) expect(() => checkWebhookUrl(bad, false)).toThrow();
    expect(checkWebhookUrl("https://my-app.base44.app/functions/sayso-webhook", false)).toContain("base44.app");
  });
});

describe("an app paying through Sayso", () => {
  it("applies the app's rules, keeps Sayso's approval, and sends signed events back", async () => {
    const received: Array<{ headers: Record<string, string>; raw: string }> = [];
    const hook = express().use(express.text({ type: "*/*" }), (req, res) => {
      // Only webhook deliveries count; anything else on this port (e.g. a local tool probing it) gets a 404.
      if (req.method !== "POST" || req.path !== "/functions/sayso-webhook") { res.sendStatus(404); return; }
      received.push({ headers: req.headers as Record<string, string>, raw: req.body }); res.sendStatus(200);
    }).listen(0);
    const s = await buildSayso({ offline: true, dbPath: ":memory:" });
    const server = s.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/functions/sayso-webhook`;
    try {
      // Apps can't be created without the owner.
      expect((await fetch(`${base}/v1/platform/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      const created = await fetch(`${base}/v1/platform/apps`, { method: "POST", headers: OWNER, body: JSON.stringify({ name: "Freelance Hub", webhook_url: hookUrl, rules: "No more than 500 EUR per payout. Only pay EUR and GBP." }) });
      expect(created.status).toBe(201);
      const app = await created.json() as { api_key: string; webhook_secret: string; rules_enforced: string[] };
      expect(app.rules_enforced).toHaveLength(2);
      const asApp = { authorization: `Bearer ${app.api_key}`, "content-type": "application/json" };
      const post = (b: unknown) => fetch(`${base}/v1/platform/payouts`, { method: "POST", headers: asApp, body: JSON.stringify(b) });

      // The app's key can't be used as an agent key, and a wrong key gets nothing.
      expect((await fetch(`${base}/v1/agent/invoices`, { headers: { authorization: `Bearer ${app.api_key}` } })).status).toBe(401);
      expect((await fetch(`${base}/v1/platform/payouts`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);

      // Its own rules refuse before anything reaches the inbox.
      const big = await post(payout({ ref: "big", amount: "900.00" }));
      expect(big.status).toBe(422);
      expect(((await big.json()) as { error: string }).error).toMatch(/per-payout limit/);
      expect((await post(payout({ ref: "usd", currency: "USD" }))).status).toBe(422);

      // A valid payout waits for the owner. The app has no way to approve it.
      const ok = await post(payout());
      expect(ok.status).toBe(201);
      const first = await ok.json() as { state: string; approval_url: string };
      expect(first.state).toBe("awaiting_approval");
      expect(first.approval_url).toMatch(/\/p\//);
      // Retrying is safe; changing the body under the same ref is not.
      expect((await post(payout())).status).toBe(200);
      expect((await post(payout({ bank: { iban: "DE02120300000000202051" } }))).status).toBe(409);

      // The owner approves; the payout is delivered; the app hears each step.
      const inboxId = s.inbox.list().find((i) => i.id.startsWith("b44:"))!.id;
      await s.inbox.approve(inboxId, "owner", {});
      for (let i = 0; i < 4; i++) { await s.svc.follow(); await s.tick(); }
      const done = await (await fetch(`${base}/v1/platform/payouts/job-1`, { headers: asApp })).json() as { state: string };
      expect(done.state).toBe("paid");

      const events = received.map((r) => ({ ...JSON.parse(r.raw), sig: r.headers["sayso-signature"], raw: r.raw }));
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("payout.awaiting_approval");
      expect(types).toContain("payout.paid");
      expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i + 1));
      for (const e of events) expect(verifyWebhook(app.webhook_secret, e.sig, e.raw)).toBe(true);
      expect(JSON.stringify(events)).not.toContain("DE89"); // bank details never go back out
    } finally {
      server.close(); hook.close();
    }
  }, 30_000);

  it("an app hears about its payout even after 200 newer invoices", async () => {
    const store = new Store(":memory:");
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(5000), EUR: toMinor(100) }), store, refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
    const inbox = new Inbox(store, svc);
    const platform = new Platform(store, new AgentKeys(store), inbox, { offline: true, baseUrl: () => "http://sayso.test", approvalPath: (id) => `/approve/${id}` });
    const { app } = await platform.createApp("Old Co", null, "");
    await platform.submit(app, payout({ ref: "old-1" }));
    for (let i = 0; i < 201; i++) store.db.prepare("INSERT INTO inbox (id, sender, subject, received_at, body, fields, missing, status) VALUES (?,?,?,?,?,?,?,?)").run(`filler-${i}`, "x", "x", new Date(Date.now() + 86_400_000 + i * 1000).toISOString(), "", "{}", "[]", "ignored");
    const count = () => (store.db.prepare("SELECT COUNT(*) AS n FROM platform_events").get() as { n: number }).n;
    await platform.tick();
    const before = count();
    inbox.ignore((store.db.prepare("SELECT id FROM inbox WHERE id LIKE 'b44:%'").get() as { id: string }).id);
    await platform.tick();
    expect(count()).toBe(before + 1);
  });

  it("queues one payout when two identical submits race for the same ref", async () => {
    const store = new Store(":memory:");
    const keys = new AgentKeys(store);
    const svc = new PayoutService({ awx: new FakeAirwallex({ USD: toMinor(5000), EUR: toMinor(100) }), store, refunder: new FakeRefunder(), read: async (t) => heuristicRead(t) });
    const inbox = new Inbox(store, svc);
    const platform = new Platform(store, keys, inbox, { offline: true, baseUrl: () => "http://sayso.test", approvalPath: (id) => `/approve/${id}` });
    const { app } = await platform.createApp("Race Co", null, "");
    const input = payout({ ref: "race-1" });
    // Started in the same tick, so both pass the "has this ref been seen?" read before either queues it.
    const [a, b] = await Promise.all([platform.submit(app, input), platform.submit(app, input)]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    // Both answers name the payout the first one queued, and only one reached the inbox.
    expect(a.payout?.payout_id).toBeTruthy();
    expect(a.payout?.payout_id).toBe(b.payout?.payout_id);
    expect(inbox.list().filter((i) => i.id.startsWith("b44:"))).toHaveLength(1);
  });
});

// Builds an offline app with a receiver, one approved payout taken to paid, and hands back what a test needs.
async function paidApp(ref: string) {
  const received: Array<{ headers: Record<string, string>; raw: string }> = [];
  const hook = express().use(express.text({ type: "*/*" }), (req, res) => {
    if (req.method !== "POST" || req.path !== "/functions/sayso-webhook") { res.sendStatus(404); return; }
    received.push({ headers: req.headers as Record<string, string>, raw: req.body }); res.sendStatus(200);
  }).listen(0);
  const s = await buildSayso({ offline: true, dbPath: ":memory:" });
  const server = s.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/functions/sayso-webhook`;
  const created = await fetch(`${base}/v1/platform/apps`, { method: "POST", headers: OWNER, body: JSON.stringify({ name: "Freelance Hub", webhook_url: hookUrl, rules: "" }) });
  const app = await created.json() as { api_key: string; webhook_secret: string };
  const asApp = { authorization: `Bearer ${app.api_key}`, "content-type": "application/json" };
  expect((await fetch(`${base}/v1/platform/payouts`, { method: "POST", headers: asApp, body: JSON.stringify(payout({ ref })) })).status).toBe(201);
  const item = s.inbox.list().find((i) => i.id.startsWith("b44:"))!;
  await s.inbox.approve(item.id, "owner", {});
  for (let i = 0; i < 4; i++) { await s.svc.follow(); await s.tick(); }
  const done = await (await fetch(`${base}/v1/platform/payouts/${ref}`, { headers: asApp })).json() as { state: string };
  expect(done.state).toBe("paid");
  const payoutId = s.inbox.view(item.id)!.payoutId!;
  const p = s.svc.book.get(payoutId)!;
  const events = () => received.map((r) => ({ ...JSON.parse(r.raw), sig: r.headers["sayso-signature"], raw: r.raw }));
  const bounce = () => ({ id: `evt_bounce_${ref}`, name: "payout.transfer.failed", created_at: new Date().toISOString(), data: { object: { id: p.transferId, request_id: payoutId, status: "FAILED", transfer_amount: 120, transfer_currency: "EUR", failure_type: "BENEFICIARY_BANK_RETURNED" } } });
  return { s, base, app, p, payoutId, events, bounce, close: () => { server.close(); hook.close(); } };
}

describe("returns after paid", () => {
  it("hears a bounce after paid through the real Airwallex webhook", async () => {
    process.env.AWX_WEBHOOK_SECRET = "whsec_test";
    const h = await paidApp("job-1");
    try {
      const raw = JSON.stringify(h.bounce());
      const ts = String(Date.now());
      const res = await fetch(`${h.base}/webhooks/airwallex`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sign("whsec_test", ts, raw) }, body: raw });
      expect(res.status).toBe(200);
      for (let i = 0; i < 40 && !["failed", "refunded"].includes(h.s.svc.book.get(h.payoutId)!.status); i++) await new Promise((r) => setTimeout(r, 50));
      const final = h.s.svc.book.get(h.payoutId)!.status;
      expect(["failed", "refunded"]).toContain(final);
      await h.s.tick(); await h.s.tick();
      const events = h.events();
      const types = events.map((e) => e.type);
      expect(types.indexOf("payout.paid")).toBeGreaterThan(-1);
      expect(types.indexOf(`payout.${final}`)).toBeGreaterThan(types.indexOf("payout.paid"));
      expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i + 1));
      for (const e of events) expect(verifyWebhook(h.app.webhook_secret, e.sig, e.raw)).toBe(true);
    } finally {
      delete process.env.AWX_WEBHOOK_SECRET;
      h.close();
    }
  }, 30_000);

  it("stops watching a ref 120 days after it was paid, but not one paid 10 days ago", async () => {
    for (const [days, heard] of [[121, false], [10, true]] as const) {
      const h = await paidApp("job-1");
      try {
        const before = h.events().length;
        (h.s.svc.book as unknown as { store: Store }).store.db.prepare("UPDATE platform_refs SET state_at = ? WHERE ref = 'job-1'").run(new Date(Date.now() - days * 86_400_000).toISOString());
        await h.s.svc.onTransfer({ id: h.p.transferId!, request_id: h.payoutId, status: "FAILED", transfer_amount: 120, transfer_currency: "EUR", failure_type: "BENEFICIARY_BANK_RETURNED" } as never);
        await h.s.tick(); await h.s.tick();
        const added = h.events().slice(before).map((e) => e.type);
        if (heard) expect(added.some((t) => t === "payout.failed" || t === "payout.refunded")).toBe(true);
        else expect(added).toEqual([]);
      } finally {
        h.close();
      }
    }
  }, 60_000);
});
