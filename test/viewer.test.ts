import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { emit } from "../src/events.js";
import { studioBankChange, studioInvoice } from "../samples/invoices.js";

describe("a read-only look around, for judges", () => {
  it("sees what the owner sees and can't pay, approve or change anything", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const me0 = await (await fetch(`${base}/auth/me`)).json();
      expect(me0.methods.viewer).toBe(true);
      const login = await fetch(`${base}/auth/viewer`, { method: "POST" });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

      const me = await (await call("GET", "/auth/me")).json();
      expect(me).toMatchObject({ owner: false, viewer: true });
      for (const path of ["/v1/summary", "/v1/payouts", "/v1/inbox", "/v1/agents"]) expect((await call("GET", path)).status).toBe(200);

      for (const [path, body] of [["/v1/inbox", { from: "a@b.c", body: "pay 10 EUR" }], ["/v1/say", { transcript: "pay Anna 20 euros" }], ["/v1/agents", { name: "x" }], ["/v1/inbox/x/approve", {}], ["/auth/passkey/register/options", {}]] as const) {
        const r = await call("POST", path, body);
        expect(r.status, path).toBe(403);
        expect((await r.json()).read_only).toBe(true);
      }
      // A forged viewer cookie is nobody.
      const forged = await fetch(`${base}/v1/payouts`, { headers: { cookie: `cs_viewer=${Date.now() + 60_000}.nope` } });
      expect(forged.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("sees the payee's bank details only to their last four", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = { authorization: `Bearer ${cs.ownerToken}`, "content-type": "application/json" };
    try {
      const iban = "DE89370400440532013000";
      const created = await fetch(`${base}/v1/inbox`, {
        method: "POST", headers: owner,
        body: JSON.stringify({ message_id: "viewer-bank", from: "billing@example.test", subject: "Invoice", body: `Pay to: Kreuzberg Studio\nInvoice total: EUR 480.00\nIBAN: ${iban}` }),
      });
      expect(created.status).toBe(201);

      const mine = await (await fetch(`${base}/v1/inbox`, { headers: owner })).text();
      expect(mine).toContain(iban);

      const login = await fetch(`${base}/auth/viewer`, { method: "POST" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const theirs = await (await fetch(`${base}/v1/inbox`, { headers: { cookie } })).text();
      expect(theirs).not.toContain(iban);
      expect(theirs).toContain("••••3000");
      // The operator's state view is masked too, since a viewer can read it.
      expect(await (await fetch(`${base}/ops/state`, { headers: { cookie } })).text()).not.toContain(iban);
    } finally {
      server.close();
    }
  });

  it("is off on a live deploy unless SAYSO_VIEWER=on", async () => {
    const { createAuth } = await import("../src/auth.js");
    const { Store } = await import("../src/store.js");
    const auth = createAuth({ offline: false, log: () => {}, store: new Store(":memory:") });
    const express = (await import("express")).default;
    const app = express().use(auth.router);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/auth/viewer`, { method: "POST" })).status).toBe(404);
    } finally { server.close(); }
  });

  /** Reads an event stream for a moment, then hangs up. */
  const streamText = async (url: string, headers: Record<string, string>) => {
    const ac = new AbortController();
    const res = await fetch(url, { headers, signal: ac.signal });
    setTimeout(() => ac.abort(), 250);
    let text = "";
    try { for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) text += new TextDecoder().decode(c); } catch { /* aborted */ }
    return text;
  };

  it("the event stream sends a viewer no private events and no bank numbers", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      emit("observe", "secret sign-in link zzz", undefined, undefined, { private: true });
      emit("observe", "public finding zzz", { citations: ["pay DE89 3704 0044 0532 0130 00 today"] });
      const login = await fetch(`${base}/auth/viewer`, { method: "POST" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const theirs = await streamText(`${base}/ops/events`, { cookie });
      expect(theirs).toContain("public finding zzz");
      expect(theirs).not.toContain("secret sign-in link zzz");
      expect(theirs).not.toContain("DE89 3704");
      expect(theirs).toContain("••••");
    } finally {
      server.close();
    }
  });

  it("the event stream still sends the owner everything", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      emit("observe", "secret sign-in link yyy", { citations: ["DE89 3704 0044 0532 0130 00"] }, undefined, { private: true });
      const mine = await streamText(`${base}/ops/events`, { authorization: `Bearer ${cs.ownerToken}` });
      expect(mine).toContain("secret sign-in link yyy");
      expect(mine).toContain("DE89 3704");
    } finally {
      server.close();
    }
  });

  it("viewers get no sim penny link", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = { authorization: `Bearer ${cs.ownerToken}`, "content-type": "application/json" };
    const post = async (path: string, body?: unknown) => (await fetch(base + path, { method: "POST", headers: owner, body: body ? JSON.stringify(body) : undefined })).json() as Promise<Record<string, any>>;
    const forward = (e: typeof studioInvoice) => post("/v1/inbox", { message_id: e.messageId, from: e.from, subject: e.subject, body: e.body });
    try {
      const first = await forward(studioInvoice);
      await post(`/v1/inbox/${encodeURIComponent(first.id)}/approve`, { approver: "will" });
      for (let i = 0; i < 2; i++) await cs.svc.follow();
      const held = await forward(studioBankChange);
      const check = await post(`/v1/inbox/${encodeURIComponent(held.id)}/penny`);
      expect(check.simStatementReference).toMatch(/SAYSO CODE/);

      const mine = await (await fetch(`${base}/v1/inbox`, { headers: owner })).text();
      expect(mine).toContain("simStatementReference");
      const login = await fetch(`${base}/auth/viewer`, { method: "POST" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const theirs = await (await fetch(`${base}/v1/inbox`, { headers: { cookie } })).text();
      expect(theirs).not.toContain("simLink");
      expect(theirs).not.toContain("simStatementReference");
      expect(theirs).not.toContain("SAYSO CODE");
    } finally {
      server.close();
    }
  });

  it("a viewer filing a dispute gets read-only, not signed-out", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const login = await fetch(`${base}/auth/viewer`, { method: "POST" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const r = await fetch(`${base}/v1/payouts/00000000-0000-4000-8000-000000000000/disputes`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ claim: "not_delivered" }) });
      expect(r.status).toBe(403);
      expect((await r.json()).read_only).toBe(true);
    } finally {
      server.close();
    }
  });
});
