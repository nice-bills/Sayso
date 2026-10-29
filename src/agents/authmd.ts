// auth.md (https://github.com/workos/auth.md): how an agent signs itself up to Sayso for its user,
// without the owner copying a key around. The agent reads /auth.md, registers with the owner's
// email (service_auth) and gets a six-digit code to show them. The owner opens the link, signs in,
// types the code and confirms with their passkey (Face ID or a fingerprint). Then the agent gets
// a short-lived access token for /mcp and the agent REST routes, and a Sayso-signed assertion to
// mint the next one. A connected agent still can't pay: approving stays with the owner's passkey.
//
// Sayso accepts service_auth only. identity_assertion (ID-JAG from a trusted agent provider) and
// anonymous registration answer with the spec's *_not_enabled errors.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Auth } from "../auth.js";
import type { Store } from "../store.js";
import { emit } from "../events.js";
import type { AgentKeys } from "./keys.js";
import { OAUTH_SCOPES, oauthMetadata, oauthRouter } from "./oauth.js";

const CLAIM_WINDOW_MS = 24 * 3_600_000;
const CODE_SECONDS = 600;
const ACCESS_SECONDS = 3600;
const ASSERTION_SECONDS = 30 * 24 * 3600;
const SCOPES = ["invoices.forward", "invoices.read", "payouts.quote", "payouts.read"];
const CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

interface Registration {
  id: string; agent_name: string; login_hint: string; status: "pending" | "claimed" | "issued";
  user_code: string; attempt_token: string; code_expires: number; expires: number; tries: number; agent_id: string | null;
}

export function authMdRouter(d: { store: Store; keys: AgentKeys; auth: Auth }): express.Router {
  const db = d.store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_registrations (
    id TEXT PRIMARY KEY, claim_token_hash TEXT NOT NULL UNIQUE, agent_name TEXT NOT NULL, login_hint TEXT NOT NULL,
    status TEXT NOT NULL, user_code TEXT NOT NULL, attempt_token TEXT NOT NULL UNIQUE, code_expires INTEGER NOT NULL,
    expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, agent_id TEXT, created_at TEXT NOT NULL
  )`);
  const key = createHmac("sha256", process.env.SESSION_SECRET ?? randomBytes(32)).update("sayso-agent-assertion").digest();
  const byClaim = (t: unknown) => (typeof t === "string" ? db.prepare("SELECT * FROM agent_registrations WHERE claim_token_hash = ?").get(sha(t)) : undefined) as Registration | undefined;
  const byAttempt = (t: unknown) => (typeof t === "string" ? db.prepare("SELECT * FROM agent_registrations WHERE attempt_token = ?").get(t) : undefined) as Registration | undefined;
  const code = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

  const sign = (claims: Record<string, unknown>) => {
    const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
  };
  const verifyJwt = (jwt: string, iss: string) => {
    const [h, p, s] = jwt.split(".");
    if (!h || !p || !s) return undefined;
    const want = createHmac("sha256", key).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const c = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss?: string; sub?: string; exp?: number };
    return c.iss === iss && c.sub && (c.exp ?? 0) * 1000 > Date.now() ? c : undefined;
  };
  const assertionFor = (base: string, agentId: string) => {
    const exp = Math.floor(Date.now() / 1000) + ASSERTION_SECONDS;
    return { identity_assertion: sign({ iss: base, sub: agentId, aud: `${base}/`, iat: Math.floor(Date.now() / 1000), exp, jti: randomUUID(), scope: SCOPES.join(" ") }), assertion_expires: new Date(exp * 1000).toISOString() };
  };
  const tokenResponse = (base: string, agentId: string, withAssertion: boolean) => ({
    access_token: d.keys.issueToken(agentId, ACCESS_SECONDS), token_type: "Bearer", expires_in: ACCESS_SECONDS, scope: SCOPES.join(" "),
    ...(withAssertion ? assertionFor(base, agentId) : {}),
  });

  const ceremony = (base: string, r: Pick<Registration, "user_code" | "attempt_token" | "code_expires">) => ({
    user_code: r.user_code,
    expires_in: Math.max(0, Math.round((r.code_expires - Date.now()) / 1000)),
    verification_uri: `${base}/c/${r.attempt_token}`,
    interval: 5,
  });
  const err = (res: Response, status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });

  const r = express.Router();
  // Chat apps (Claude, ChatGPT) sign in with the standard authorization code flow instead.
  const oauth = oauthRouter(d);
  r.use(oauth.router);

  // ---------- discovery ----------
  const prm = (base: string) => ({
    resource: `${base}/`, resource_name: "Sayso", resource_logo_uri: `${base}/logo.svg`, authorization_servers: [base],
    scopes_supported: [...new Set([...SCOPES, ...OAUTH_SCOPES])], bearer_methods_supported: ["header"],
  });
  r.get("/.well-known/oauth-protected-resource", (req, res) => res.json(prm(d.auth.base(req))));
  r.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = d.auth.base(req);
    res.json({
      ...prm(base), issuer: base, token_endpoint: `${base}/oauth2/token`, revocation_endpoint: `${base}/oauth2/revoke`, ...oauthMetadata(base),
      grant_types_supported: ["authorization_code", "refresh_token", JWT_BEARER, CLAIM_GRANT],
      agent_auth: {
        skill: `${base}/auth.md`, identity_endpoint: `${base}/agent/identity`, claim_endpoint: `${base}/agent/identity/claim`,
        identity_types_supported: ["service_auth"], identity_assertion: { assertion_types_supported: [] }, events_supported: [],
      },
    });
  });
  r.get("/auth.md", (req, res) => res.type("text/markdown").send(skill(d.auth.base(req))));

  // ---------- Step 3: register ----------
  r.post("/agent/identity", express.json(), (req, res) => {
    const base = d.auth.base(req);
    const type = req.body?.type;
    if (type === "anonymous") return void err(res, 400, "anonymous_not_enabled", "Sayso needs to know whose agent you are. Register with service_auth and the user's email.");
    if (type === "identity_assertion") return void err(res, 400, "issuer_not_enabled", "Sayso trusts no ID-JAG providers yet. Use service_auth.");
    if (type !== "service_auth") return void err(res, 400, "invalid_request", "type must be service_auth");
    const hint = String(req.body?.login_hint ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(hint)) return void err(res, 400, "invalid_request", "login_hint must be the user's email");
    const name = String(req.body?.agent_name ?? req.header("user-agent")?.split(/[\s/]/)[0] ?? "").trim().slice(0, 60) || "An agent";
    const claimToken = `clm_${randomBytes(24).toString("base64url")}`;
    const reg: Registration = {
      id: `reg_${randomUUID()}`, agent_name: name, login_hint: hint, status: "pending", user_code: code(), attempt_token: randomBytes(18).toString("base64url"),
      code_expires: Date.now() + CODE_SECONDS * 1000, expires: Date.now() + CLAIM_WINDOW_MS, tries: 0, agent_id: null,
    };
    db.prepare("INSERT INTO agent_registrations (id, claim_token_hash, agent_name, login_hint, status, user_code, attempt_token, code_expires, expires, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(reg.id, sha(claimToken), reg.agent_name, reg.login_hint, reg.status, reg.user_code, reg.attempt_token, reg.code_expires, reg.expires, new Date().toISOString());
    emit("observe", `${name} asked to connect to Sayso`);
    res.json({
      registration_id: reg.id, registration_type: "service_auth", claim_url: `${base}/agent/identity/claim`, claim_token: claimToken,
      claim_token_expires: new Date(reg.expires).toISOString(), post_claim_scopes: SCOPES, claim: ceremony(base, reg),
    });
  });

  // ---------- Step 4a: a fresh code when the last one ran out ----------
  r.post("/agent/identity/claim", express.json(), (req, res) => {
    const reg = byClaim(req.body?.claim_token);
    if (!reg) return void err(res, 400, "invalid_claim_token", "Unknown claim_token. Restart at Step 3.");
    if (reg.status !== "pending") return void err(res, 400, "claimed_or_in_flight", "Already claimed. Poll the token endpoint.");
    if (reg.expires < Date.now()) return void err(res, 410, "claim_expired", "The registration expired. Restart at Step 3.");
    const fresh = { user_code: code(), attempt_token: randomBytes(18).toString("base64url"), code_expires: Date.now() + CODE_SECONDS * 1000 };
    db.prepare("UPDATE agent_registrations SET user_code = ?, attempt_token = ?, code_expires = ?, tries = 0 WHERE id = ?").run(fresh.user_code, fresh.attempt_token, fresh.code_expires, reg.id);
    res.json({ registration_id: reg.id, claim_attempt_id: `cla_${fresh.attempt_token.slice(0, 12)}`, status: "initiated", expires_at: new Date(fresh.code_expires).toISOString(), claim_attempt: ceremony(d.auth.base(req), fresh) });
  });

  // ---------- the owner's side of the ceremony (the /claim page in the app) ----------
  r.get("/agent/identity/claim/attempt", d.auth.requireOwner, (req, res) => {
    const reg = byAttempt(req.query.t);
    if (!reg || reg.expires < Date.now()) return void res.status(404).json({ error: "This link has expired. Ask your agent to start again." });
    res.json({ agent_name: reg.agent_name, login_hint: reg.login_hint, status: reg.status, code_expired: reg.code_expires < Date.now(), subject: reg.id });
  });
  r.post("/agent/identity/claim/complete", d.auth.requireOwner, express.json({ limit: "64kb" }), async (req, res) => {
    const reg = byAttempt(req.body?.attempt_token);
    if (!reg || reg.expires < Date.now()) return void res.status(404).json({ error: "This link has expired. Ask your agent to start again." });
    if (reg.status !== "pending") return void res.json({ ok: true, agent_name: reg.agent_name });
    if (reg.code_expires < Date.now()) return void res.status(410).json({ error: "The code ran out. Your agent can get a new one." });
    if (reg.tries >= 5) return void res.status(429).json({ error: "Too many wrong codes. Ask your agent for a new one." });
    const given = String(req.body?.user_code ?? "").replace(/\D/g, "");
    if (given !== reg.user_code) {
      db.prepare("UPDATE agent_registrations SET tries = tries + 1 WHERE id = ?").run(reg.id);
      return void res.status(400).json({ error: "That code doesn't match. Check what your agent showed you." });
    }
    if (!(await d.auth.confirmed(req, req.body?.confirmation, "claim", reg.id))) return void res.status(401).json({ error: "Confirm with your passkey to connect it.", need: "passkey" });
    const { agent } = d.keys.create(reg.agent_name, null);
    db.prepare("UPDATE agent_registrations SET status = 'claimed', agent_id = ? WHERE id = ? AND status = 'pending'").run(agent.id, reg.id);
    emit("decide", `You connected ${reg.agent_name} to Sayso`);
    res.json({ ok: true, agent_name: reg.agent_name });
  });

  // ---------- Steps 4c and 5: the token endpoint ----------
  r.post("/oauth2/token", express.urlencoded({ extended: false }), express.json(), (req, res) => {
    const base = d.auth.base(req);
    const grant = req.body?.grant_type;
    if (oauth.token((req.body ?? {}) as Record<string, unknown>, res)) return;
    if (grant === CLAIM_GRANT) {
      const reg = byClaim(req.body?.claim_token);
      if (!reg) return void err(res, 400, "invalid_grant", "Unknown claim_token.");
      if (reg.status === "issued") return void err(res, 400, "invalid_grant", "This claim_token was already exchanged. Use your identity_assertion.");
      if (reg.status === "pending") {
        if (reg.code_expires < Date.now() || reg.expires < Date.now()) return void err(res, 400, "expired_token", "The code ran out. Call /agent/identity/claim for a new one.");
        return void err(res, 400, "authorization_pending", "Waiting for the user to sign in and enter the code.");
      }
      db.prepare("UPDATE agent_registrations SET status = 'issued' WHERE id = ?").run(reg.id);
      return void res.json(tokenResponse(base, reg.agent_id!, true));
    }
    if (grant === JWT_BEARER) {
      const c = verifyJwt(String(req.body?.assertion ?? ""), base);
      if (!c || !d.keys.get(c.sub!) || d.keys.get(c.sub!)!.revokedAt) return void err(res, 400, "invalid_grant", "The assertion is expired or revoked. Restart at Step 3.");
      return void res.json(tokenResponse(base, c.sub!, false));
    }
    err(res, 400, "unsupported_grant_type", `grant_type must be authorization_code, refresh_token, ${JWT_BEARER} or ${CLAIM_GRANT}`);
  });
  r.post("/oauth2/revoke", express.urlencoded({ extended: false }), express.json(), (req, res) => {
    if (typeof req.body?.token === "string") d.keys.revokeToken(req.body.token);
    res.status(200).end();
  });

  return r;
}

/** Where a 401 points an agent: the PRM, per RFC 9728. */
export const resourceMetadataHeader = (req: Request, base: (req: Request) => string) => `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`;

function skill(base: string): string {
  return `# auth.md

You are an agent. Sayso pays real invoices in local currency through Airwallex, on behalf of its owner. You can forward invoices, check them, and quote payouts. You can never approve a payment: the owner does that with their passkey.

This service supports **agentic registration** per https://github.com/workos/auth.md: discover, register, claim, exchange for an access_token, call the API.

## Step 1: Discover

- Protected Resource Metadata: \`GET ${base}/.well-known/oauth-protected-resource\`
- Authorization Server metadata: \`GET ${base}/.well-known/oauth-authorization-server\` (read the \`agent_auth\` block)

## Step 2: Pick a method

Sayso accepts **service_auth** only. You need the user's email. \`anonymous\` answers \`anonymous_not_enabled\` and \`identity_assertion\` answers \`issuer_not_enabled\`.

## Step 3: Register

First tell the user you are connecting to **Sayso** to forward and check their invoices, and get their OK.

\`\`\`http
POST ${base}/agent/identity
Content-Type: application/json

{ "type": "service_auth", "login_hint": "owner@example.com", "agent_name": "Claude" }
\`\`\`

\`agent_name\` is a Sayso extension: the name the owner sees when they confirm. The response carries \`claim_token\` (returned once; keep it in memory) and a \`claim\` block with \`user_code\`, \`verification_uri\`, \`expires_in\` (600) and \`interval\` (5).

## Step 4: Claim ceremony

Show the user, in one message:

> Open this link, sign in to Sayso, and enter this code: **123456**
> ${base}/c/...

The user signs in, types the code, and confirms with Face ID, a fingerprint or their security key. Meanwhile poll:

\`\`\`http
POST ${base}/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=${CLAIM_GRANT}&claim_token=clm_...
\`\`\`

\`authorization_pending\` means keep polling every \`interval\` seconds. \`expired_token\` means the code ran out: \`POST ${base}/agent/identity/claim\` with \`{ "claim_token": "clm_..." }\` for a fresh \`claim_attempt\`, and show the user the new code. \`claim_expired\` (410) means start again at Step 3.

Success returns \`access_token\` (an hour), \`identity_assertion\` (30 days) and \`assertion_expires\`.

## Step 5: Exchange the assertion

When the access_token expires:

\`\`\`http
POST ${base}/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=${JWT_BEARER}&assertion=<identity_assertion>&resource=${base}/
\`\`\`

\`invalid_grant\` means the owner disconnected you or the assertion expired. Restart at Step 3.

## Step 6: Use the access_token

Send \`Authorization: Bearer <access_token>\` to:

- \`POST ${base}/mcp\`: the MCP server (Streamable HTTP). Tools: \`forward_invoice\`, \`list_invoices\`, \`quote_payout\`, \`payout_status\`.
- \`POST ${base}/v1/agent/invoices\` with \`{ "text": "<the whole invoice or email>", "from": "...", "subject": "..." }\`: forward an invoice.
- \`GET ${base}/v1/agent/invoices\`: what's waiting and why.

Forwarding never pays anything. Each invoice comes back with an \`approval_url\`: give it to the owner, who approves with their passkey. Never tell the owner a payment went through until \`payout_status\` says \`paid\`.

## Errors

\`anonymous_not_enabled\`, \`issuer_not_enabled\` and \`invalid_request\` at \`/agent/identity\`; \`invalid_claim_token\`, \`claimed_or_in_flight\` and \`claim_expired\` at \`/agent/identity/claim\`; \`authorization_pending\`, \`expired_token\`, \`invalid_grant\` and \`unsupported_grant_type\` at \`/oauth2/token\`. On a 401 from the API, try Step 5 once; if that fails, restart at Step 1.

## Revocation

\`POST ${base}/oauth2/revoke\` with \`token=<access_token>\` ends one access_token. When the owner disconnects you in the app, every token and the assertion stop working, and you'll see \`invalid_grant\`.
`;
}
