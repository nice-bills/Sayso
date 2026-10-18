// The owner's sign-in. One owner token (OWNER_TOKEN) unlocks the app; the browser keeps a signed,
// httpOnly, SameSite=Strict session cookie, and scripts can send the token as a Bearer header.
// Everything that can move the business's money or show its payees sits behind this.
// Agents never need it: they pay per call over x402, and a payout id is unguessable.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

const COOKIE = "cs_session";
/** A week, so the approval links on the owner's phone open signed in. */
const SESSION_MS = 7 * 24 * 3_600_000;

export interface Auth {
  ownerToken: string;
  router: express.Router;
  requireOwner: (req: Request, res: Response, next: NextFunction) => void;
  isOwner: (req: Request) => boolean;
  /** For the inbox forwarding endpoint: owner, or a mail hook holding INBOX_SECRET. */
  requireOwnerOrInboxSecret: (req: Request, res: Response, next: NextFunction) => void;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((kv) => kv.length === 2).map(([k, v]) => [k!, decodeURIComponent(v!)]));
}

export function createAuth(opts: { offline: boolean; log: (line: string) => void }): Auth {
  let ownerToken = process.env.OWNER_TOKEN ?? "";
  if (!ownerToken) {
    ownerToken = opts.offline ? "sayso-demo" : randomBytes(18).toString("base64url");
    opts.log(`Owner token (set OWNER_TOKEN to choose your own): ${ownerToken}`);
  }
  const key = process.env.SESSION_SECRET ? Buffer.from(process.env.SESSION_SECRET) : randomBytes(32);
  const sign = (expires: number) => createHmac("sha256", key).update(String(expires)).digest("base64url");

  const isOwner = (req: Request) => {
    const bearer = req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) return same(bearer, ownerToken);
    const [exp, sig] = (cookies(req)[COOKIE] ?? "").split(".");
    return Boolean(exp && sig && Number(exp) > Date.now() && same(sig, sign(Number(exp))));
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

  const router = express.Router();
  router.post("/auth/login", express.json(), (req, res) => {
    if (!same(String(req.body?.token ?? ""), ownerToken)) return void res.status(401).json({ error: "wrong token" });
    const expires = Date.now() + SESSION_MS;
    const secure = req.secure || req.header("x-forwarded-proto") === "https";
    res.setHeader("set-cookie", `${COOKIE}=${expires}.${sign(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`);
    res.json({ ok: true });
  });
  router.post("/auth/logout", (_req, res) => {
    res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });
  router.get("/auth/me", (req, res) => res.json({ owner: isOwner(req) }));

  return { ownerToken, router, requireOwner, isOwner, requireOwnerOrInboxSecret };
}
