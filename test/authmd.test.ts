// The owner's passkey and an agent signing itself up through auth.md, end to end over HTTP,
// with a software authenticator standing in for Face ID.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { studioInvoice } from "../samples/invoices.js";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
/** Just enough CBOR for a "none" attestation: byte strings, short text, small maps and ints. */
const cborBytes = (b: Buffer) => Buffer.concat([b.length < 24 ? Buffer.from([0x40 + b.length]) : b.length < 256 ? Buffer.from([0x58, b.length]) : Buffer.from([0x59, b.length >> 8, b.length & 255]), b]);
const cborText = (s: string) => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);

/** A P-256 authenticator that always verifies the user, like a phone's Face ID. */
function softAuthenticator(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, "base64url")]);
  const id = randomBytes(16);
  const rpHash = sha(new URL(origin).hostname);
  let counter = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    register(options: { challenge: string }) {
      const authData = Buffer.concat([rpHash, Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
      const attestationObject = Buffer.concat([Buffer.from([0xa3]), cborText("fmt"), cborText("none"), cborText("attStmt"), Buffer.from([0xa0]), cborText("authData"), cborBytes(authData)]);
      return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData("webauthn.create", options.challenge)), attestationObject: b64u(attestationObject), transports: ["internal"] } };
    },
    assert(options: { challenge: string }) {
      counter++;
      const authData = Buffer.concat([rpHash, Buffer.from([0x05, counter >> 24, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255])]);
      const cd = clientData("webauthn.get", options.challenge);
      const signature = createSign("SHA256").update(Buffer.concat([authData, sha(cd)])).sign(privateKey);
      return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}

async function start() {
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const owner = { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}` };
  const call = async (path: string, body?: unknown, headers: Record<string, string> = owner) => {
    const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: (r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text()) as Record<string, any> };
  };
  return { cs, server, base, call, owner };
}

describe("passkeys and auth.md", () => {
  it("once the owner has a passkey, paying needs a fresh check bound to that invoice", async () => {
    const { cs, server, base, call } = await start();
    try {
      const fido = softAuthenticator(base);
      const reg = await call("/auth/passkey/register/options", {});
      expect((await call("/auth/passkey/register", { challenge_id: reg.body.challenge_id, response: fido.register(reg.body.options) })).status).toBe(200);
      expect((await call("/auth/me")).body.passkeys).toBe(true);

      const item = (await call("/v1/inbox", { message_id: studioInvoice.messageId, from: studioInvoice.from, subject: studioInvoice.subject, body: studioInvoice.body })).body;
      const id = encodeURIComponent(item.id);
      expect((await call(`/v1/inbox/${id}/approve`, {})).status).toBe(401);
      // A check made for another invoice doesn't carry over.
      const other = await call("/auth/passkey/confirm/options", { purpose: "approve", subject: "someone-else" });
      expect((await call(`/v1/inbox/${id}/approve`, { confirmation: { challenge_id: other.body.challenge_id, response: fido.assert(other.body.options) } })).status).toBe(401);
      const ok = await call("/auth/passkey/confirm/options", { purpose: "approve", subject: item.id });
      const paid = await call(`/v1/inbox/${id}/approve`, { confirmation: { challenge_id: ok.body.challenge_id, response: fido.assert(ok.body.options) } });
      expect(paid.status).toBe(200);
      expect(paid.body.status).toBe("paying");
      expect(cs.inbox.get(item.id)!.status).toBe("paying");

      // And the passkey signs the owner in on its own.
      const login = await call("/auth/passkey/login/options", {}, { "content-type": "application/json" });
      const r = await call("/auth/passkey/login", { challenge_id: login.body.challenge_id, response: fido.assert(login.body.options) }, { "content-type": "application/json" });
      expect(r.status).toBe(200);
      expect(r.headers.get("set-cookie")).toMatch(/^cs_session=/);
    } finally {
      server.close();
    }
  });

  it("an agent signs up with service_auth, the owner confirms the code with a passkey, and the token reaches /mcp", async () => {
    const { server, base, call } = await start();
    const anon = { "content-type": "application/json" };
    const form = { "content-type": "application/x-www-form-urlencoded" };
    try {
      const fido = softAuthenticator(base);
      const reg0 = await call("/auth/passkey/register/options", {});
      await call("/auth/passkey/register", { challenge_id: reg0.body.challenge_id, response: fido.register(reg0.body.options) });

      // Discovery starts from a 401.
      const denied = await call("/v1/agent/invoices", undefined, {});
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
      const as = (await call("/.well-known/oauth-authorization-server", undefined, {})).body;
      expect(as.agent_auth.identity_types_supported).toEqual(["service_auth"]);
      expect((await call("/auth.md", undefined, {})).body).toContain("service_auth");

      expect((await call("/agent/identity", { type: "anonymous" }, anon)).body.error).toBe("anonymous_not_enabled");
      const reg = (await call("/agent/identity", { type: "service_auth", login_hint: "owner@sayso.example", agent_name: "Claude" }, anon)).body;
      expect(reg.claim.user_code).toMatch(/^\d{6}$/);
      const poll = () => call("/oauth2/token", `grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=${reg.claim_token}`, form);
      expect((await poll()).body.error).toBe("authorization_pending");

      const attempt = new URL(reg.claim.verification_uri).searchParams.get("claim_attempt_token")!;
      const seen = (await call(`/agent/identity/claim/attempt?t=${attempt}`)).body;
      expect(seen.agent_name).toBe("Claude");
      expect((await call("/agent/identity/claim/complete", { attempt_token: attempt, user_code: "000000" === reg.claim.user_code ? "111111" : "000000" })).status).toBe(400);
      // The right code alone isn't enough: it needs the passkey.
      expect((await call("/agent/identity/claim/complete", { attempt_token: attempt, user_code: reg.claim.user_code })).status).toBe(401);
      const c = await call("/auth/passkey/confirm/options", { purpose: "claim", subject: seen.subject });
      expect((await call("/agent/identity/claim/complete", { attempt_token: attempt, user_code: reg.claim.user_code, confirmation: { challenge_id: c.body.challenge_id, response: fido.assert(c.body.options) } })).status).toBe(200);

      const tok = (await poll()).body;
      expect(tok.token_type).toBe("Bearer");
      expect(tok.identity_assertion).toBeTruthy();
      expect((await poll()).body.error).toBe("invalid_grant");
      const bearer = { authorization: `Bearer ${tok.access_token}` };
      expect((await call("/v1/agent/invoices", undefined, bearer)).status).toBe(200);
      expect((await call("/v1/agents")).body.map((a: { name: string }) => a.name)).toContain("Claude");

      const again = (await call("/oauth2/token", `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${tok.identity_assertion}`, form)).body;
      expect(again.access_token).toBeTruthy();
      await call("/oauth2/revoke", `token=${again.access_token}`, form);
      expect((await call("/v1/agent/invoices", undefined, { authorization: `Bearer ${again.access_token}` })).status).toBe(401);

      // Disconnecting the agent kills its tokens and its assertion.
      const agent = (await call("/v1/agents")).body.find((a: { name: string }) => a.name === "Claude");
      await call(`/v1/agents/${agent.id}/revoke`, {});
      expect((await call("/v1/agent/invoices", undefined, bearer)).status).toBe(401);
      expect((await call("/oauth2/token", `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${tok.identity_assertion}`, form)).body.error).toBe("invalid_grant");
    } finally {
      server.close();
    }
  });

  it("emails a one-time sign-in link only to the owner's address", async () => {
    const { server, base, call } = await start();
    const anon = { "content-type": "application/json" };
    try {
      const a = await call("/auth/email", { email: "stranger@example.org" }, anon);
      const b = await call("/auth/email", { email: "owner@sayso.example" }, anon);
      expect(a.body).toEqual(b.body);
      const bad = await fetch(`${base}/auth/email/verify?t=nope`, { redirect: "manual" });
      expect(bad.headers.get("location")).toBe("/?signin=expired");
      expect(bad.headers.get("set-cookie")).toBeNull();
    } finally {
      server.close();
    }
  });
});
