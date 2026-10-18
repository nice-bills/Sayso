import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { toInboundEmail, verifySvix } from "../src/inbox/agentmail.js";
import { studioInvoice } from "../samples/invoices.js";

const secret = `whsec_${Buffer.from("sayso-test-secret-32-bytes!!!").toString("base64")}`;
const sign = (id: string, ts: string, body: string) => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

describe("AgentMail", () => {
  afterEach(() => { delete process.env.AGENTMAIL_WEBHOOK_SECRET; });

  it("verifies Svix signatures and rejects stale or forged ones", () => {
    const now = 1_760_000_000;
    const body = '{"a":1}';
    const sig = sign("msg_1", String(now), body);
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(now), signature: `v1,bogus ${sig}` }, body, now)).toBe(true);
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(now), signature: sig }, '{"a":2}', now)).toBe(false);
    expect(verifySvix(secret, { id: "msg_1", timestamp: String(now), signature: sig }, body, now + 600)).toBe(false);
  });

  it("reads HTML-only mail and both shapes of the sender", async () => {
    const e = await toInboundEmail({ message_id: "<m1@x>", from_: ["Billing <b@x.com>"], subject: "Inv", html: "<p>Total due: EUR 10,00</p><p>IBAN: DE89&nbsp;3704</p>" });
    expect(e).toMatchObject({ from: "Billing <b@x.com>", body: "Total due: EUR 10,00\nIBAN: DE89 3704" });
  });

  it("turns a signed webhook into an invoice waiting for approval, once", async () => {
    process.env.AGENTMAIL_WEBHOOK_SECRET = secret;
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ type: "event", event_type: "message.received", event_id: "evt_1", message: { inbox_id: "inb_1", message_id: studioInvoice.messageId, from: studioInvoice.from, subject: studioInvoice.subject, text: studioInvoice.body, timestamp: new Date().toISOString() } });
      const ts = String(Math.floor(Date.now() / 1000));
      const post = (signature: string) => fetch(`${base}/webhooks/agentmail`, { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": signature }, body });
      expect((await post("v1,forged")).status).toBe(401);
      expect((await post(sign("msg_1", ts, body))).status).toBe(204);
      expect((await post(sign("msg_1", ts, body))).status).toBe(204); // a retry
      expect(cs.inbox.list().map((i) => i.status)).toEqual(["awaiting_approval"]);
    } finally {
      server.close();
    }
  });
});
