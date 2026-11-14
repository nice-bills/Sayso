// The emailed sign-in link is built from a public URL, never from the Host header a caller sent.
import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import { Store } from "../src/store.js";

describe("the emailed sign-in link", () => {
  it("is refused on a live server with no public URL, and uses the public URL when it has one", async () => {
    const saved = { PUBLIC_URL: process.env.PUBLIC_URL, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL, OWNER_EMAIL: process.env.OWNER_EMAIL };
    delete process.env.PUBLIC_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    process.env.OWNER_EMAIL = "owner@example.com";
    const log: string[] = [];
    const sent: string[] = [];
    const auth = createAuth({
      offline: false, log: (l) => log.push(l), store: new Store(":memory:"),
      send: async (_to, _subject, text) => { sent.push(text); },
    });
    const server = express().use(auth.router).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = () => fetch(`${base}/auth/email`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.com" }),
    });
    try {
      // Same answer as always, but nothing is sent and the reason is logged.
      const refused = await ask();
      expect(refused.status).toBe(200);
      expect((await refused.json()) as { ok: boolean }).toMatchObject({ ok: true });
      expect(sent).toEqual([]);
      expect(log.join("\n")).toMatch(/PUBLIC_URL/);

      // With a public URL the email goes out with a link from it.
      process.env.PUBLIC_URL = "https://sayso.example";
      expect((await ask()).status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("https://sayso.example/auth/email/verify?t=");
    } finally {
      server.close();
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

describe("owner sessions live on the server", () => {
  const setup = () => {
    process.env.OWNER_TOKEN = "t";
    const auth = createAuth({ offline: false, log: () => {}, store: new Store(":memory:") });
    delete process.env.OWNER_TOKEN;
    const server = express().use(auth.router).get("/x", auth.requireOwner, (_req, res) => void res.json({ ok: true })).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const signIn = async () => {
      const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "t" }) });
      expect(r.status).toBe(200);
      return r.headers.get("set-cookie")!.split(";")[0]!;
    };
    const status = async (cookie: string) => (await fetch(`${base}/x`, { headers: { cookie } })).status;
    return { server, base, signIn, status };
  };
  it("logout ends the session on the server", async () => {
    const { server, base, signIn, status } = setup();
    try {
      const cookie = await signIn();
      expect(await status(cookie)).toBe(200);
      await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie } });
      expect(await status(cookie)).toBe(401);
    } finally { server.close(); }
  });
  it("sign out everywhere ends every session", async () => {
    const { server, base, signIn, status } = setup();
    try {
      const a = await signIn(), b = await signIn();
      await fetch(`${base}/auth/logout/all`, { method: "POST", headers: { cookie: a, "content-type": "application/json" }, body: "{}" });
      expect(await status(a)).toBe(401);
      expect(await status(b)).toBe(401);
    } finally { server.close(); }
  });
});
