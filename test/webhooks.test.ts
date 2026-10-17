import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { sign, verifyWebhook, webhookRouter, type AirwallexEvent } from "../src/airwallex/webhooks.js";
import { Store } from "../src/store.js";

const SECRET = "whsec_test";
const body = (id: string, created = "2026-11-01T00:00:00Z") => Buffer.from(JSON.stringify({ id, name: "payout.transfer.paid", created_at: created, data: { object: { id: "tfr_1" } } }));

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    const ts = String(Date.now());
    const raw = body("evt_1");
    expect(verifyWebhook(SECRET, { timestamp: ts, signature: sign(SECRET, ts, raw) }, raw).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and a stale timestamp", () => {
    const ts = String(Date.now());
    const raw = body("evt_1");
    const sig = sign(SECRET, ts, raw);
    expect(verifyWebhook(SECRET, { timestamp: ts, signature: sig }, body("evt_2"))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhook("other", { timestamp: ts, signature: sig }, raw)).toEqual({ ok: false, reason: "bad_signature" });
    const old = String(Date.now() - 10 * 60_000);
    expect(verifyWebhook(SECRET, { timestamp: old, signature: sign(SECRET, old, raw) }, raw)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("webhookRouter", () => {
  it("processes each event id once even when Airwallex redelivers it", async () => {
    const seen: AirwallexEvent[] = [];
    const app = express().use("/hook", webhookRouter(SECRET, new Store(":memory:"), (e) => { seen.push(e); }));
    const server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const post = (raw: Buffer, sig?: string) => {
      const ts = String(Date.now());
      return fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig ?? sign(SECRET, ts, raw) }, body: new Uint8Array(raw) });
    };
    try {
      expect((await post(body("evt_1"))).status).toBe(200);
      expect((await post(body("evt_1"))).status).toBe(200);
      expect((await post(body("evt_2"), "00")).status).toBe(401);
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.map((e) => e.id)).toEqual(["evt_1"]);
    } finally {
      server.close();
    }
  });
});
