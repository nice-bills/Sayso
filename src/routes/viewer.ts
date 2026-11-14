// A viewer may look at every screen, but not the payee's bank identifiers: mask them to the last
// four wherever a response carries them. The owner's own session is untouched, and nothing stored changes.

import type express from "express";

export const BANK_ID = /^(iban|accountNumber|account_number|sortCode|sort_code|routingNumber|routing_number)$/;
export const lastFour = (s: string) => `••••${s.replace(/\s+/g, "").slice(-4)}`;
// Quotes from an email can hold a bank number in running text: keep the last four of any long digit run or IBAN.
export const maskQuote = (s: string) => s.replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}\b/g, lastFour).replace(/\d(?:\s?\d){5,}/g, lastFour);
export const forViewer = (v: unknown): unknown => Array.isArray(v) ? v.map(forViewer)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "simLink" && k !== "simStatementReference").map(([k, x]) => [k,
    BANK_ID.test(k) && typeof x === "string" ? lastFour(x) : k === "citations" && Array.isArray(x) ? x.map((q) => (typeof q === "string" ? maskQuote(q) : forViewer(q))) : forViewer(x)]))
  : v;

export function viewerMask(isViewer: (req: express.Request) => boolean): express.RequestHandler {
  return (req, res, next) => {
    if (!isViewer(req)) return next();
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => json(forViewer(body))) as express.Response["json"];
    next();
  };
}
