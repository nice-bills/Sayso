import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";

afterEach(() => { delete process.env.RECONCILE_EVERY_MS; });

describe("the service keeps its own books", () => {
  it("reconciles on its own schedule, without anyone running the demo", async () => {
    process.env.RECONCILE_EVERY_MS = "1";
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    try {
      const summary = async () => (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/summary`, { headers: { authorization: `Bearer ${cs.ownerToken}` } })).json();
      expect((await summary()).reconcile).toBeUndefined();
      await cs.tick();
      const r = (await summary()).reconcile;
      expect(r).toBeDefined();
      expect(r.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it("can be turned off", async () => {
    process.env.RECONCILE_EVERY_MS = "0";
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    try {
      await cs.tick();
      const s = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/summary`, { headers: { authorization: `Bearer ${cs.ownerToken}` } })).json();
      expect(s.reconcile).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
