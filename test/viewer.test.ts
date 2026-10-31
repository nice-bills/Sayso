import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";

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
});
