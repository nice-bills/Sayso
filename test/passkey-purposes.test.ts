import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import { Store } from "../src/store.js";

describe("passkey checks bound to one action", () => {
  // Every purpose a route passes to auth.confirmed() must be one the options endpoint will issue a challenge for,
  // or that route can never be confirmed once the owner has a passkey.
  it("issues a challenge for every action the app confirms, including refunding a dispute", async () => {
    process.env.OWNER_TOKEN = "t";
    const auth = createAuth({ offline: true, log: () => {}, store: new Store(":memory:") });
    delete process.env.OWNER_TOKEN;
    const server = express().use(auth.router).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const purpose of ["approve", "review", "claim", "connect", "dispute", "register"]) {
        const r = await fetch(`${base}/auth/passkey/confirm/options`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ purpose, subject: "x" }) });
        expect(r.status, purpose).toBe(200);
      }
      const bad = await fetch(`${base}/auth/passkey/confirm/options`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ purpose: "login", subject: "x" }) });
      expect(bad.status).toBe(400);
    } finally { server.close(); }
  });
  it("live, with no passkey enrolled, a signed-in session alone confirms nothing; offline (the demo) it still does", async () => {
    const req = {} as express.Request;
    const live = createAuth({ offline: false, log: () => {}, store: new Store(":memory:") });
    expect(await live.confirmed(req, undefined, "approve", "x")).toBe(false);
    const demo = createAuth({ offline: true, log: () => {}, store: new Store(":memory:") });
    expect(await demo.confirmed(req, undefined, "approve", "x")).toBe(true);
  });

  // Adding a passkey must not be possible with a session alone once one exists.
  const registerWithKeyEnrolled = async (recovery: boolean) => {
    process.env.OWNER_TOKEN = "t";
    const store = new Store(":memory:");
    const auth = createAuth({ offline: false, log: () => {}, store });
    delete process.env.OWNER_TOKEN;
    store.db.prepare("INSERT INTO owner_passkeys (id, public_key, counter, created_at) VALUES ('k1', x'00', 0, '2026-01-01')").run();
    if (recovery) process.env.SAYSO_PASSKEY_RECOVERY = "on";
    const server = express().use(auth.router).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const h = { authorization: "Bearer t", "content-type": "application/json" };
      const { challenge_id } = (await (await fetch(`${base}/auth/passkey/register/options`, { method: "POST", headers: h, body: "{}" })).json()) as { challenge_id: string };
      const r = await fetch(`${base}/auth/passkey/register`, { method: "POST", headers: h, body: JSON.stringify({ challenge_id, response: {} }) });
      return { status: r.status, body: (await r.json()) as { need?: string } };
    } finally { server.close(); delete process.env.SAYSO_PASSKEY_RECOVERY; }
  };
  it("a second passkey needs a passkey", async () => {
    const r = await registerWithKeyEnrolled(false);
    expect(r.status).toBe(401);
    expect(r.body.need).toBe("passkey");
  });
  it("the recovery switch lets it through to the WebAuthn check", async () => {
    expect((await registerWithKeyEnrolled(true)).status).toBe(400);
  });
});
