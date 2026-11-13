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
      for (const purpose of ["approve", "review", "claim", "connect", "dispute"]) {
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
});
