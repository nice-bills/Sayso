// Per-client request limits for routes anyone can call. Quotes, batches, disputes and the hosted MCP
// each fan out to Airwallex, Metal RPC or Claude, so an unthrottled loop burns credit and sandbox quota
// and can take the demo down. Fixed windows, in memory: one Sayso process serves the whole site.

import type { NextFunction, Request, Response } from "express";

export interface Limit { /** Requests allowed per window. */ max: number; windowMs: number }

/**
 * Who is calling. Render sits behind Cloudflare, which overwrites CF-Connecting-IP with the real client, so
 * render.yaml sets SAYSO_TRUST_CF=on. Anywhere else a caller could write that header, so it is ignored.
 * Otherwise the last X-Forwarded-For hop is the one our own proxy appended; earlier hops are whatever the
 * caller wrote, so they are never trusted. With no proxy at all, the socket address.
 */
export function clientOf(req: Request): string {
  const cf = process.env.SAYSO_TRUST_CF === "on" ? req.header("cf-connecting-ip")?.trim() : undefined;
  if (cf) return cf;
  const fwd = req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return fwd || req.socket.remoteAddress || "unknown";
}

export function rateLimit(name: string, limit: Limit, opts: { now?: () => number; key?: (req: Request) => string } = {}) {
  const now = opts.now ?? Date.now;
  const keyOf = opts.key ?? clientOf;
  const hits = new Map<string, { count: number; resetAt: number }>();
  let sweptAt = now();
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.SAYSO_RATE_LIMIT === "off") return next();
    const t = now();
    // Forget finished windows now and then, so the map stays the size of the current crowd.
    if (t - sweptAt > limit.windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      sweptAt = t;
    }
    const k = keyOf(req);
    let h = hits.get(k);
    if (!h || h.resetAt <= t) hits.set(k, (h = { count: 0, resetAt: t + limit.windowMs }));
    h.count++;
    res.setHeader("RateLimit-Limit", String(limit.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit.max - h.count)));
    if (h.count > limit.max) {
      const retry = Math.ceil((h.resetAt - t) / 1000);
      res.setHeader("Retry-After", String(retry));
      return void res.status(429).json({ error: `Too many ${name} requests. Try again in ${retry}s.` });
    }
    next();
  };
}

/** The limits Sayso applies, per client. Generous for a person or one agent, tight for a script. */
export const LIMITS = {
  quotes: { max: 30, windowMs: 60_000 },
  batches: { max: 10, windowMs: 60_000 },
  pay: { max: 30, windowMs: 60_000 },
  disputes: { max: 10, windowMs: 60_000 },
  preview: { max: 60, windowMs: 60_000 },
  auth: { max: 20, windowMs: 60_000 },
  mcp: { max: 120, windowMs: 60_000 },
  links: { max: 30, windowMs: 60_000 },
} satisfies Record<string, Limit>;
