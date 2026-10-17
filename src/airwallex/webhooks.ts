// Airwallex webhook receiver. Airwallex signs `${x-timestamp}${raw body}` with HMAC-SHA256 using
// the endpoint's secret and sends the hex digest as `x-signature`. Delivery is at least once and
// not ordered, so: verify against the RAW body, dedupe on event id, ack fast, process after.

import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Router } from "express";
import { emit } from "../events.js";
import type { Store } from "../store.js";

export interface AirwallexEvent {
  id: string;
  name: string;
  created_at: string;
  data: { object: Record<string, unknown> };
}

const TOLERANCE_MS = 5 * 60_000;

export function sign(secret: string, timestamp: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
}

export type Verify = { ok: true; event: AirwallexEvent } | { ok: false; reason: "missing_headers" | "bad_signature" | "stale" | "bad_body" };

export function verifyWebhook(secret: string, headers: { timestamp?: string; signature?: string }, rawBody: Buffer, now = Date.now()): Verify {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  // x-timestamp is epoch milliseconds; reject replays of old deliveries.
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_MS) return { ok: false, reason: "stale" };
  try {
    const event = JSON.parse(rawBody.toString("utf8")) as AirwallexEvent;
    if (!event.id || !event.name) return { ok: false, reason: "bad_body" };
    return { ok: true, event };
  } catch {
    return { ok: false, reason: "bad_body" };
  }
}

/**
 * Mount at /webhooks/airwallex. `onEvent` runs after the 200 is sent, once per event id,
 * in created_at order within each flush.
 */
export function webhookRouter(secret: string, store: Store, onEvent: (e: AirwallexEvent) => Promise<void> | void): Router {
  const router = express.Router();
  let queue: AirwallexEvent[] = [];
  let draining = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const batch = queue.sort((a, b) => a.created_at.localeCompare(b.created_at));
      queue = [];
      for (const e of batch) {
        try {
          await onEvent(e);
        } catch (err) {
          emit("escalate", `Webhook ${e.name} handler failed`, { event_id: e.id, error: String(err) });
        }
      }
    }
    draining = false;
  };

  router.post("/", express.raw({ type: "*/*" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const v = verifyWebhook(secret, { timestamp: req.header("x-timestamp"), signature: req.header("x-signature") }, raw);
    if (!v.ok) {
      emit("refuse", `Rejected webhook: ${v.reason}`);
      res.status(v.reason === "bad_body" ? 400 : 401).end();
      return;
    }
    const fresh = store.recordEvent(v.event.id, v.event.name, v.event.created_at, raw.toString("utf8"));
    res.status(200).end();
    if (!fresh) return; // duplicate delivery: already handled
    queue.push(v.event);
    void drain();
  });
  return router;
}
