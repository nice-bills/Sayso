// The owner's sign-in. Sayso has one owner, and they can get in four ways:
//   a passkey (Face ID, Touch ID, a fingerprint or a security key), the everyday way;
//   a one-time link emailed to OWNER_EMAIL through AgentMail, for a new device;
//   Google, when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set and the account is OWNER_EMAIL;
//   the owner token (OWNER_TOKEN), for scripts and the offline demo.
// The browser keeps a signed, httpOnly, SameSite=Lax session cookie (Lax so an emailed link or a
// phone notification opens signed in; writes still need JSON, which no cross-site form can send). Once a passkey exists,
// approving a payment also needs a fresh passkey check bound to that payment, so a stolen session
// (or an agent driving the browser) can look but not pay.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Store } from "./store.js";

const COOKIE = "cs_session";
/** A week, so the approval links on the owner's phone open signed in. */
const SESSION_MS = 7 * 24 * 3_600_000;
const CHALLENGE_MS = 5 * 60_000;
const EMAIL_LINK_MS = 15 * 60_000;

export type SendEmail = (to: string, subject: string, text: string) => Promise<void>;

export interface Auth {
  ownerToken: string;
  router: express.Router;
  requireOwner: (req: Request, res: Response, next: NextFunction) => void;
  isOwner: (req: Request) => boolean;
  /** For the inbox forwarding endpoint: owner, or a mail hook holding INBOX_SECRET. */
  requireOwnerOrInboxSecret: (req: Request, res: Response, next: NextFunction) => void;
  /** Whether the owner has set up a passkey (then approvals need one). */
  hasPasskey: () => boolean;
  /**
   * True when `confirmation` is a fresh passkey check for this purpose and subject, or when no
   * passkey exists yet (the offline demo, or before the owner sets one up).
   */
  confirmed: (req: Request, confirmation: unknown, purpose: string, subject: string) => Promise<boolean>;
  /** Where people reach this server: PUBLIC_URL, or the host they called. */
  base: (req: Request) => string;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((kv) => kv.length === 2).map(([k, v]) => [k!, decodeURIComponent(v!)]));
}

export const baseUrl = (req: Request) => (process.env.PUBLIC_URL ?? `${req.header("x-forwarded-proto") ?? req.protocol}://${req.header("host")}`).replace(/\/$/, "");

interface Challenge { challenge: string; purpose: string; subject: string; expires: number }

export function createAuth(opts: { offline: boolean; log: (line: string) => void; store: Store; send?: SendEmail }): Auth {
  let ownerToken = process.env.OWNER_TOKEN ?? "";
  if (!ownerToken) {
    ownerToken = opts.offline ? "sayso-demo" : randomBytes(18).toString("base64url");
    opts.log(`Owner token (set OWNER_TOKEN to choose your own): ${ownerToken}`);
  }
  const ownerEmail = (process.env.OWNER_EMAIL ?? (opts.offline ? "owner@sayso.example" : "")).trim().toLowerCase();
  const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET } : undefined;
  const key = process.env.SESSION_SECRET ? Buffer.from(process.env.SESSION_SECRET) : randomBytes(32);
  const sign = (expires: number) => createHmac("sha256", key).update(String(expires)).digest("base64url");

  const db = opts.store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS owner_passkeys (
      id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_email_links (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`);
  const passkeys = () => db.prepare("SELECT id, public_key, counter, transports FROM owner_passkeys").all() as Array<{ id: string; public_key: Uint8Array; counter: number; transports: string | null }>;
  const hasPasskey = () => (db.prepare("SELECT COUNT(*) AS n FROM owner_passkeys").get() as { n: number }).n > 0;

  // Challenges live a few minutes in memory; a restart just means trying again.
  const challenges = new Map<string, Challenge>();
  const keep = (c: Omit<Challenge, "expires">) => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
    const id = randomBytes(16).toString("base64url");
    challenges.set(id, { ...c, expires: now + CHALLENGE_MS });
    return id;
  };
  const take = (id: unknown, purpose: string, subject: string) => {
    const c = typeof id === "string" ? challenges.get(id) : undefined;
    if (!c) return undefined;
    challenges.delete(id as string);
    return c.purpose === purpose && c.subject === subject && c.expires > Date.now() ? c : undefined;
  };

  const rp = (req: Request) => {
    const url = new URL(baseUrl(req));
    return { rpID: url.hostname, origin: url.origin };
  };

  const isOwner = (req: Request) => {
    const bearer = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) return same(bearer, ownerToken);
    const [exp, sig] = (cookies(req)[COOKIE] ?? "").split(".");
    return Boolean(exp && sig && Number(exp) > Date.now() && same(sig, sign(Number(exp))));
  };

  const startSession = (req: Request, res: Response) => {
    const expires = Date.now() + SESSION_MS;
    const secure = req.secure || req.header("x-forwarded-proto") === "https";
    res.setHeader("set-cookie", `${COOKIE}=${expires}.${sign(expires)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`);
  };

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (!isOwner(req)) return void res.status(401).json({ error: "sign in first" });
    // A cross-site form can't send JSON without a CORS preflight we never answer.
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json") && !req.header("authorization")) return void res.status(415).json({ error: "send JSON" });
    next();
  };

  const requireOwnerOrInboxSecret = (req: Request, res: Response, next: NextFunction) => {
    const secret = process.env.INBOX_SECRET;
    if (secret && same(req.header("x-inbox-secret") ?? "", secret)) return next();
    requireOwner(req, res, next);
  };

  /** Checks a passkey assertion against the stored credentials and bumps its counter. */
  async function checkAssertion(req: Request, response: AuthenticationResponseJSON, challenge: string): Promise<boolean> {
    const stored = passkeys().find((p) => p.id === response?.id);
    if (!stored) return false;
    const { rpID, origin } = rp(req);
    try {
      const r = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: stored.id, publicKey: new Uint8Array(stored.public_key), counter: stored.counter, transports: stored.transports ? (JSON.parse(stored.transports) as AuthenticatorTransportFuture[]) : undefined },
      });
      if (!r.verified) return false;
      db.prepare("UPDATE owner_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(r.authenticationInfo.newCounter, new Date().toISOString(), stored.id);
      return true;
    } catch {
      return false;
    }
  }

  const confirmed = async (req: Request, confirmation: unknown, purpose: string, subject: string) => {
    if (!hasPasskey()) return true;
    const c = confirmation as { challenge_id?: unknown; response?: AuthenticationResponseJSON } | undefined;
    const ch = take(c?.challenge_id, purpose, subject);
    return Boolean(ch && c?.response && (await checkAssertion(req, c.response, ch.challenge)));
  };

  const router = express.Router();
  router.post("/auth/login", express.json(), (req, res) => {
    if (!same(String(req.body?.token ?? ""), ownerToken)) return void res.status(401).json({ error: "wrong token" });
    startSession(req, res);
    res.json({ ok: true });
  });
  router.post("/auth/logout", (_req, res) => {
    res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  router.get("/auth/me", (req, res) => res.json({
    owner: isOwner(req),
    passkeys: hasPasskey(),
    methods: { passkey: hasPasskey(), email: Boolean(ownerEmail && (opts.send || opts.offline)), google: Boolean(google && ownerEmail), demo: opts.offline },
  }));

  // ---------- passkeys ----------
  router.post("/auth/passkey/register/options", requireOwner, async (req, res) => {
    const { rpID } = rp(req);
    const options = await generateRegistrationOptions({
      rpName: "Sayso", rpID, userName: ownerEmail || "owner", userDisplayName: "Sayso owner", attestationType: "none",
      userID: new Uint8Array(createHash("sha256").update(`sayso-owner:${rpID}`).digest().subarray(0, 16)),
      excludeCredentials: passkeys().map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    res.json({ challenge_id: keep({ challenge: options.challenge, purpose: "register", subject: "owner" }), options });
  });
  router.post("/auth/passkey/register", requireOwner, express.json({ limit: "64kb" }), async (req, res) => {
    const ch = take(req.body?.challenge_id, "register", "owner");
    if (!ch) return void res.status(400).json({ error: "That took too long. Try again." });
    const { rpID, origin } = rp(req);
    try {
      const r = await verifyRegistrationResponse({ response: req.body.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!r.verified) return void res.status(400).json({ error: "The passkey didn't check out." });
      const c = r.registrationInfo.credential;
      db.prepare("INSERT OR REPLACE INTO owner_passkeys (id, public_key, counter, transports, created_at) VALUES (?,?,?,?,?)").run(c.id, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, new Date().toISOString());
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: `The passkey didn't check out: ${String((err as Error).message).slice(0, 120)}` });
    }
  });
  router.post("/auth/passkey/login/options", async (req, res) => {
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    res.json({ challenge_id: keep({ challenge: options.challenge, purpose: "login", subject: "owner" }), options });
  });
  router.post("/auth/passkey/login", express.json({ limit: "64kb" }), async (req, res) => {
    const ch = take(req.body?.challenge_id, "login", "owner");
    if (!ch || !(await checkAssertion(req, req.body?.response as AuthenticationResponseJSON, ch.challenge))) return void res.status(401).json({ error: "That passkey isn't one Sayso knows." });
    startSession(req, res);
    res.json({ ok: true });
  });
  // A check bound to one action (approving this payment, connecting that agent), not a sign-in.
  router.post("/auth/passkey/confirm/options", requireOwner, express.json(), async (req, res) => {
    const purpose = String(req.body?.purpose ?? ""), subject = String(req.body?.subject ?? "");
    if (!/^(approve|review|claim|connect)$/.test(purpose) || !subject) return void res.status(400).json({ error: "purpose and subject are required" });
    const { rpID } = rp(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: passkeys().map((p) => ({ id: p.id, transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[]) : undefined })) });
    res.json({ challenge_id: keep({ challenge: options.challenge, purpose, subject }), options });
  });

  // ---------- an emailed one-time link ----------
  const sent: number[] = [];
  router.post("/auth/email", express.json(), async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    // The same answer whoever asks, so the form can't be used to find the owner's address.
    const reply = () => res.json({ ok: true, message: "If that's the owner's address, a sign-in link is on its way. It works once, for 15 minutes." });
    const now = Date.now();
    while (sent.length && sent[0]! < now - EMAIL_LINK_MS) sent.shift();
    if (!ownerEmail || email !== ownerEmail || sent.length >= 5) return void reply();
    sent.push(now);
    const token = randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO owner_email_links (token_hash, expires) VALUES (?, ?)").run(sha(token), now + EMAIL_LINK_MS);
    const link = `${baseUrl(req)}/auth/email/verify?t=${token}`;
    if (opts.send) await opts.send(ownerEmail, "Your Sayso sign-in link", `Tap to sign in to Sayso:\n\n${link}\n\nIt works once, for 15 minutes. If you didn't ask for it, ignore this email.`).catch((e) => opts.log(`Sign-in email failed: ${String(e).slice(0, 160)}`));
    else opts.log(`Offline demo: the sign-in link for ${ownerEmail} is ${link}`);
    reply();
  });
  router.get("/auth/email/verify", (req, res) => {
    const t = String(req.query.t ?? "");
    const r = t ? db.prepare("UPDATE owner_email_links SET used = 1 WHERE token_hash = ? AND used = 0 AND expires > ?").run(sha(t), Date.now()) : undefined;
    if (!r || Number(r.changes) !== 1) return void res.redirect(303, "/?signin=expired");
    startSession(req, res);
    res.redirect(303, "/");
  });

  // ---------- Google ----------
  router.get("/auth/google", (req, res) => {
    if (!google || !ownerEmail) return void res.redirect(303, "/?signin=google-off");
    const state = randomBytes(16).toString("base64url");
    const secure = req.secure || req.header("x-forwarded-proto") === "https";
    res.setHeader("set-cookie", `cs_gstate=${state}; HttpOnly; SameSite=Lax; Path=/auth/google; Max-Age=600${secure ? "; Secure" : ""}`);
    const q = new URLSearchParams({ client_id: google.id, redirect_uri: `${baseUrl(req)}/auth/google/callback`, response_type: "code", scope: "openid email", state, login_hint: ownerEmail, prompt: "select_account" });
    res.redirect(303, `https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });
  router.get("/auth/google/callback", async (req, res) => {
    const state = cookies(req).cs_gstate;
    if (!google || !state || !same(String(req.query.state ?? ""), state) || !req.query.code) return void res.redirect(303, "/?signin=google-failed");
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: String(req.query.code), client_id: google.id, client_secret: google.secret, redirect_uri: `${baseUrl(req)}/auth/google/callback`, grant_type: "authorization_code" }),
      });
      const { id_token } = (await r.json()) as { id_token?: string };
      // Straight from Google's token endpoint over TLS, so the ID token's claims can be read as is (OIDC core 3.1.3.7).
      const claims = id_token ? (JSON.parse(Buffer.from(id_token.split(".")[1]!, "base64url").toString()) as { email?: string; email_verified?: boolean; aud?: string }) : {};
      if (claims.aud !== google.id || !claims.email_verified || claims.email?.toLowerCase() !== ownerEmail) return void res.redirect(303, "/?signin=google-not-owner");
      startSession(req, res);
      res.redirect(303, "/");
    } catch {
      res.redirect(303, "/?signin=google-failed");
    }
  });

  return { ownerToken, router, requireOwner, isOwner, requireOwnerOrInboxSecret, hasPasskey, confirmed, base: baseUrl };
}
