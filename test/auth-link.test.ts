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
