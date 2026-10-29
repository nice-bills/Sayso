// "Sign in with Sayso" for chat apps: the standard MCP authorization (OAuth 2.1, authorization code
// with PKCE, and dynamic client registration). The owner adds Sayso's /mcp URL as a connector in
// Claude or ChatGPT; the app registers itself, sends the owner to Sayso, the owner taps Allow (with
// Face ID when they have a passkey), and the app gets its own agent key as tokens. Nobody copies a key.
// A connected app still can't pay: approving stays with the owner's passkey in Sayso.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Response } from "express";
import type { Auth } from "../auth.js";
import type { Store } from "../store.js";
import { emit } from "../events.js";
import type { AgentKeys } from "./keys.js";

const REQUEST_SECONDS = 600;
const CODE_SECONDS = 120;
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 90;
export const OAUTH_SCOPES = ["invoices.forward", "invoices.read", "payouts.quote", "payouts.read", "mail.send"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const token = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

/** Where a chat app may send the owner back: https anywhere, or http on this machine. */
function redirectOk(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 500) return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}

interface Client { id: string; name: string; redirect_uris: string }
interface AuthRequest {
  id: string; client_id: string; redirect_uri: string; challenge: string; state: string | null; status: "pending" | "allowed" | "used" | "denied";
  code_hash: string | null; agent_id: string | null; expires: number;
}

/** The authorization server's endpoints, merged into /.well-known/oauth-authorization-server. */
export const oauthMetadata = (base: string) => ({
  authorization_endpoint: `${base}/oauth2/authorize`, registration_endpoint: `${base}/oauth2/register`,
  response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
});

export function oauthRouter(d: { store: Store; keys: AgentKeys; auth: Auth }): { router: express.Router; token: (body: Record<string, unknown>, res: Response) => boolean } {
  const db = d.store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT,
      status TEXT NOT NULL, code_hash TEXT UNIQUE, agent_id TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_refresh (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, client_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const client = (id: unknown) => (typeof id === "string" ? db.prepare("SELECT * FROM oauth_clients WHERE id = ?").get(id) : undefined) as Client | undefined;
  const request = (id: unknown) => (typeof id === "string" ? db.prepare("SELECT * FROM oauth_requests WHERE id = ?").get(id) : undefined) as AuthRequest | undefined;
  const err = (res: Response, status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });
  const back = (r: AuthRequest, params: Record<string, string>) => {
    const u = new URL(r.redirect_uri);
    for (const [k, v] of Object.entries({ ...params, ...(r.state ? { state: r.state } : {}) })) u.searchParams.set(k, v);
    return u.toString();
  };
  const tokens = (agentId: string, clientId: string) => {
    const refresh = token("rt");
    db.prepare("INSERT INTO oauth_refresh (hash, agent_id, client_id, expires) VALUES (?,?,?,?)").run(sha(refresh), agentId, clientId, Date.now() + REFRESH_DAYS * 86_400_000);
    return { access_token: d.keys.issueToken(agentId, ACCESS_SECONDS), token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: OAUTH_SCOPES.join(" ") };
  };

  const r = express.Router();

  // Dynamic client registration (RFC 7591): public clients only, PKCE does the proving.
  r.post("/oauth2/register", express.json({ limit: "16kb" }), (req, res) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) return void err(res, 400, "invalid_redirect_uri", "redirect_uris must be https URLs (or http on localhost)");
    const name = String(req.body?.client_name ?? "").trim().slice(0, 60) || new URL(String(uris[0])).hostname;
    const id = `sayso_${randomUUID()}`;
    db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)").run(id, name, JSON.stringify(uris), new Date().toISOString());
    res.status(201).json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
  });

  // The chat app sends the owner here; Sayso shows its own Allow screen at /connect/<id>.
  r.get("/oauth2/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const c = client(q.client_id);
    const page = (msg: string) => res.status(400).type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sayso</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 20px"><h1>Can't connect</h1><p>${msg}</p></body>`);
    if (!c) return void page("This app isn't registered with Sayso. Remove the connector and add it again.");
    if (!q.redirect_uri || !(JSON.parse(c.redirect_uris) as string[]).includes(q.redirect_uri)) return void page("This app asked to return somewhere it didn't register.");
    const r0 = { id: randomBytes(18).toString("base64url"), client_id: c.id, redirect_uri: q.redirect_uri, challenge: q.code_challenge ?? "", state: q.state ?? null, status: "pending", code_hash: null, agent_id: null, expires: Date.now() + REQUEST_SECONDS * 1000 } as AuthRequest;
    if (q.response_type !== "code") return void res.redirect(302, back(r0, { error: "unsupported_response_type" }));
    if (!q.code_challenge || q.code_challenge_method !== "S256") return void res.redirect(302, back(r0, { error: "invalid_request", error_description: "PKCE with S256 is required" }));
    db.prepare("INSERT INTO oauth_requests (id, client_id, redirect_uri, challenge, state, status, expires) VALUES (?,?,?,?,?,?,?)").run(r0.id, r0.client_id, r0.redirect_uri, r0.challenge, r0.state, r0.status, r0.expires);
    res.redirect(302, `/connect/${r0.id}`);
  });

  // The owner's side, from the app.
  const live = (id: unknown, res: Response) => {
    const q = request(id);
    if (!q || q.expires < Date.now() || q.status !== "pending") { res.status(404).json({ error: "This link has expired. Start connecting again from the app." }); return undefined; }
    return q;
  };
  r.get("/oauth2/requests/:id", d.auth.requireOwner, (req, res) => {
    const q = live(req.params.id, res);
    if (!q) return;
    res.json({ client_name: client(q.client_id)!.name, returns_to: new URL(q.redirect_uri).host, subject: q.id });
  });
  r.post("/oauth2/requests/:id/allow", d.auth.requireOwner, express.json({ limit: "64kb" }), async (req, res) => {
    const q = live(req.params.id, res);
    if (!q) return;
    if (!(await d.auth.confirmed(req, req.body?.confirmation, "connect", q.id))) return void res.status(401).json({ error: "Confirm with your passkey to connect it.", need: "passkey" });
    const name = client(q.client_id)!.name;
    const { agent } = d.keys.create(name, null);
    const code = token("ac");
    db.prepare("UPDATE oauth_requests SET status = 'allowed', code_hash = ?, agent_id = ?, expires = ? WHERE id = ? AND status = 'pending'").run(sha(code), agent.id, Date.now() + CODE_SECONDS * 1000, q.id);
    emit("decide", `You connected ${name} to Sayso`);
    res.json({ redirect: back(q, { code }), client_name: name });
  });
  r.post("/oauth2/requests/:id/deny", d.auth.requireOwner, (req, res) => {
    const q = live(req.params.id, res);
    if (!q) return;
    db.prepare("UPDATE oauth_requests SET status = 'denied' WHERE id = ?").run(q.id);
    res.json({ redirect: back(q, { error: "access_denied" }) });
  });

  /** The token endpoint's two grants for chat apps; false when the grant isn't one of these. */
  const tokenGrant = (b: Record<string, unknown>, res: Response): boolean => {
    if (b.grant_type === "authorization_code") {
      const q = typeof b.code === "string" ? (db.prepare("SELECT * FROM oauth_requests WHERE code_hash = ?").get(sha(b.code)) as AuthRequest | undefined) : undefined;
      if (!q || q.status !== "allowed" || q.expires < Date.now()) { err(res, 400, "invalid_grant", "The code is unknown, used or expired."); return true; }
      db.prepare("UPDATE oauth_requests SET status = 'used' WHERE id = ?").run(q.id);
      if (b.client_id !== q.client_id || b.redirect_uri !== q.redirect_uri) { err(res, 400, "invalid_grant", "client_id or redirect_uri doesn't match."); return true; }
      if (typeof b.code_verifier !== "string" || s256(b.code_verifier) !== q.challenge) { err(res, 400, "invalid_grant", "PKCE check failed."); return true; }
      res.json(tokens(q.agent_id!, q.client_id));
      return true;
    }
    if (b.grant_type === "refresh_token") {
      const h = typeof b.refresh_token === "string" ? sha(b.refresh_token) : "";
      const row = db.prepare("SELECT * FROM oauth_refresh WHERE hash = ?").get(h) as { agent_id: string; client_id: string; expires: number } | undefined;
      const agent = row ? d.keys.get(row.agent_id) : undefined;
      if (!row || row.expires < Date.now() || !agent || agent.revokedAt || (b.client_id && b.client_id !== row.client_id)) { err(res, 400, "invalid_grant", "Sign in again: this connection was ended or expired."); return true; }
      db.prepare("DELETE FROM oauth_refresh WHERE hash = ?").run(h); // one use each
      res.json(tokens(row.agent_id, row.client_id));
      return true;
    }
    return false;
  };

  return { router: r, token: tokenGrant };
}
