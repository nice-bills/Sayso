import { describe, expect, it } from "vitest";
import express from "express";
import { clientOf, rateLimit } from "../src/ratelimit.js";

async function hit(app: express.Express, n: number, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await fetch(`http://127.0.0.1:${port}/x`, { method: "POST", headers })).status);
  server.close();
  return codes;
}

describe("rate limits", () => {
  it("lets a client through up to the limit, then answers 429 until the window ends", async () => {
    let t = 0;
    const app = express();
    app.post("/x", rateLimit("test", { max: 3, windowMs: 1000 }, { now: () => t }), (_req, res) => res.json({ ok: true }));
    expect(await hit(app, 5)).toEqual([200, 200, 200, 429, 429]);
    t = 1001;
    expect(await hit(app, 1)).toEqual([200]);
  });

  it("counts clients apart, and a caller cannot pick its own address with X-Forwarded-For", async () => {
    const app = express();
    app.post("/x", rateLimit("test", { max: 1, windowMs: 60_000 }), (_req, res) => res.json({ ok: true }));
    expect(await hit(app, 1, { "cf-connecting-ip": "1.1.1.1" })).toEqual([200]);
    expect(await hit(app, 1, { "cf-connecting-ip": "2.2.2.2" })).toEqual([200]);
    expect(await hit(app, 1, { "cf-connecting-ip": "1.1.1.1" })).toEqual([429]);
    const req = { header: (h: string) => (h === "x-forwarded-for" ? "6.6.6.6, 10.0.0.9" : undefined), socket: {} } as unknown as express.Request;
    expect(clientOf(req)).toBe("10.0.0.9");
  });
});
