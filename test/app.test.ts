import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { designerInvoice, studioInvoice } from "../samples/invoices.js";

describe("Sayso service (offline)", () => {
  it("pays inbox invoices and an agent's payout, sweeps earnings, and reconciles to the cent", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}`, ...headers }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<Record<string, unknown>>);
    try {
      for (const e of [studioInvoice, designerInvoice]) {
        const item = await post("/v1/inbox", { message_id: e.messageId, from: e.from, subject: e.subject, body: e.body });
        expect(item.status).toBe("awaiting_approval");
        await post(`/v1/inbox/${encodeURIComponent(String(item.id))}/approve`, { approver: "will" });
      }
      const q = await post("/v1/quotes", { amount: "300.00", currency: "EUR", reference: "agent job", payee: { name: "Etiqueta SL", address: { country_code: "ES", city: "Madrid", street_address: "Calle 1", postcode: "28001" }, bank: { iban: "ES9121000418450200051332" }, bank_country_code: "ES" } });
      await post(String(q.pay_url), undefined, { "x-sim-payer": "0xAgent" });
      for (let i = 0; i < 3; i++) await cs.tick();
      const statuses = cs.svc.book.list().map((p) => p.status);
      expect(statuses).toEqual(["paid", "paid", "paid"]);
      const r = await cs.reconcileNow();
      expect(r.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("keeps the inbox, approvals and back office behind the owner's sign-in", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = { "content-type": "application/json" };
    try {
      for (const [method, path] of [["GET", "/v1/inbox"], ["POST", "/v1/inbox"], ["POST", "/v1/inbox/x/approve"], ["GET", "/v1/payouts"], ["GET", "/ops/state"], ["POST", "/v1/payouts/x/review"]] as const) {
        const r = await fetch(base + path, { method, headers: json, body: method === "POST" ? "{}" : undefined });
        expect(r.status, `${method} ${path}`).toBe(401);
      }
      expect((await fetch(base + "/auth/login", { method: "POST", headers: json, body: JSON.stringify({ token: "wrong" }) })).status).toBe(401);
      const login = await fetch(base + "/auth/login", { method: "POST", headers: json, body: JSON.stringify({ token: cs.ownerToken }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      expect(cookie).toMatch(/^cs_session=/);
      expect((await fetch(base + "/v1/inbox", { headers: { cookie } })).status).toBe(200);
      // A cross-site form post carries the cookie but can't send JSON.
      const form = await fetch(base + "/v1/inbox", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "from=a&body=b" });
      expect(form.status).toBe(415);
      // Agents still quote for free with no sign-in.
      const q = await fetch(base + "/v1/quotes", { method: "POST", headers: json, body: "{}" });
      expect(q.status).not.toBe(401);
    } finally {
      server.close();
    }
  });

  it("rejects zero amounts and non-string inbox fields, and sends clickjacking headers", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = { authorization: `Bearer ${cs.ownerToken}`, "content-type": "application/json" };
    const post = (path: string, body: unknown, headers: Record<string, string> = owner) =>
      fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      // A payout of zero is not a payout: quotes, app payouts and inbox invoices all refuse it.
      const zeroQuote = await post("/v1/quotes", {
        amount: "0.00", currency: "EUR", reference: "zero",
        payee: { name: "Nobody", address: { country_code: "DE", city: "Berlin", street_address: "Street 1", postcode: "10115" }, bank: { iban: "DE89370400440532013000" }, bank_country_code: "DE" },
      }, { "content-type": "application/json" });
      expect(zeroQuote.status).toBe(400);

      const created = await post("/v1/platform/apps", { name: "Zero App", rules: "" });
      expect(created.status).toBe(201);
      const app = await created.json() as { api_key: string };
      const zeroPayout = await post("/v1/platform/payouts", {
        ref: "zero", payee_name: "Nobody", amount: "0.00", currency: "EUR", reference: "zero",
        bank: { iban: "DE89370400440532013000" },
      }, { authorization: `Bearer ${app.api_key}`, "content-type": "application/json" });
      expect(zeroPayout.status).toBe(400);

      const zeroInvoice = await (await post("/v1/inbox", {
        message_id: "zero-invoice", from: "billing@example.test", subject: "Invoice",
        body: "Pay to: Nobody Ltd\nInvoice total: EUR 0.00\nIBAN: DE89370400440532013000",
      })).json() as { status: string; missing: string[] };
      expect(zeroInvoice.status).toBe("needs_details");
      expect(zeroInvoice.missing).toContain("amount");

      // Non-string inbox fields are a bad request, not a 500.
      const valid = { message_id: "bad-field", from: "billing@example.test", subject: "Invoice", body: "Pay to: Nobody Ltd\nInvoice total: EUR 10.00\nIBAN: DE89370400440532013000" };
      for (const bad of [{ from: 1 }, { subject: 1 }, { body: {} }, { message_id: 1 }]) {
        expect((await post("/v1/inbox", { ...valid, ...bad })).status).toBe(400);
      }

      // Clickjacking protection, without advertising Express.
      const r = await fetch(base + "/healthz");
      expect(r.headers.get("x-powered-by")).toBeNull();
      expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    } finally {
      server.close();
    }
  });
});
