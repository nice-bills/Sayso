import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { checkWebhookUrl, signWebhook, verifyWebhook } from "../src/platform/platform.js";
import { checkRules, describeRules, NO_RULES, parseRulesByPattern, RulesError, compileRules } from "../src/platform/rules.js";

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
    const hook = express().use(express.text({ type: "*/*" }), (req, res) => { received.push({ headers: req.headers as Record<string, string>, raw: req.body }); res.sendStatus(200); }).listen(0);
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
});
