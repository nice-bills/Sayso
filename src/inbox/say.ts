// "Pay Acme 480 euros for invoice 1042." The owner says a payment, and Sayso shows two things side by
// side: the words it heard, and what it understood, each field marked with where it came from (your
// words, or an earlier payment to the same payee). Bank details are never taken from speech: they come
// from a payee Sayso has already paid, or an invoice already in the inbox. Nothing pays until the owner
// checks both and confirms, with their passkey, exactly as for a forwarded invoice.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Inbox, InboxItem } from "./inbox.js";

export const Intent = z.object({
  action: z.enum(["pay", "other"]),
  payee: z.string().nullable().describe("Who to pay, as said"),
  amount: z.string().nullable().describe("Major units with two decimals, e.g. \"480.00\""),
  currency: z.string().nullable().describe("ISO code, e.g. EUR"),
  reference: z.string().nullable().describe("Invoice number or reference, as said"),
});
export type Intent = z.infer<typeof Intent>;

const WORDS: Record<string, string> = { euro: "EUR", euros: "EUR", eur: "EUR", "€": "EUR", pound: "GBP", pounds: "GBP", quid: "GBP", gbp: "GBP", "£": "GBP", dollar: "USD", dollars: "USD", usd: "USD", bucks: "USD", $: "USD" };

/** A conservative reading of a spoken payment. Leaves out anything it isn't sure of. */
export function parseSpoken(transcript: string): Intent {
  const t = transcript.trim().replace(/\s+/g, " ");
  const amountRe = /([€£$])\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(euros?|eur|pounds?|quid|gbp|dollars?|usd|bucks)\b/i;
  const m = t.match(amountRe);
  const amount = m ? Number((m[2] ?? m[3])!.replace(/,/g, "")).toFixed(2) : null;
  const currency = m ? WORDS[(m[1] ?? m[4])!.toLowerCase()] ?? null : null;
  const reference = t.match(/\b(?:invoice|reference|ref)\s*(?:number|no\.?|#)?\s*([A-Z0-9][A-Z0-9-]{1,30})/i)?.[1]?.toUpperCase() ?? null;
  // "pay Acme GmbH 480 euros", "send 200 pounds to the plumber", "pay the Kreuzberg Studio invoice"
  const stop = /\s+(?:\d|[€£$]|for\b|invoice\b|ref\b|reference\b|euros?\b|pounds?\b|dollars?\b|now\b|today\b|please\b)/i;
  const after = (re: RegExp) => { const x = t.match(re)?.[1]; return x ? x.split(stop)[0]!.replace(/^(?:the|my|our)\s+/i, "").replace(/['’]s$/i, "").trim() : null; };
  const payee = after(/\bto\s+([^,.]+)/i) ?? after(/\b(?:pay|send|transfer)\s+(?!\d|[€£$])([^,.]+)/i);
  const isPay = /\b(pay|send|transfer|settle)\b/i.test(t);
  return { action: isPay ? "pay" : "other", payee: payee || null, amount, currency, reference };
}

const SYSTEM = `You turn one spoken sentence into a payment intent for a payments app.
The sentence was transcribed from speech; report only what was said. Use null for anything not said.
Never invent bank details, amounts or payees. action is "pay" only when the speaker asks to pay or send money.`;

export async function readSpoken(transcript: string): Promise<Intent & { reader: "claude" | "patterns" }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ...parseSpoken(transcript), reader: "patterns" };
  const response = await new Anthropic().beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(Intent) },
    system: SYSTEM,
    messages: [{ role: "user", content: `<said>${transcript}</said>` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return { ...parseSpoken(transcript), reader: "patterns" };
  return { ...response.parsed_output, reader: "claude" };
}

export type Source = "you said" | string;
export interface Understood {
  field: "payee" | "amount" | "currency" | "reference" | "bank";
  value: string | null;
  /** "you said", or which earlier payment or invoice it came from. */
  source: Source;
}

export interface SayResult {
  heard: string;
  reader: "claude" | "patterns";
  understood: Understood[];
  /** The invoice to approve: an existing one the words point at, or a new one made from them. */
  item: InboxItem | null;
  /** Said plainly when Sayso could not act on it. */
  problem: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameName = (a: string, b: string) => { const x = norm(a), y = norm(b); return x.length > 1 && y.length > 1 && (x === y || x.includes(y) || y.includes(x)); };
// Speech-to-text spells names it doesn't know by ear ("Cruzeburg" for "Kreuzberg"). A rough sound key
// (consonants, with letters that sound alike merged) matches those, and the owner sees both spellings.
const LEGAL = new Set(["gmbh", "ltd", "limited", "inc", "llc", "bv", "sa", "sarl", "ag", "plc", "co", "company", "the"]);
const soundKey = (w: string) => w.replace(/ph/g, "f").replace(/[cq]/g, "k").replace(/[zx]/g, "s").replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1");
const soundsLike = (full: string, said: string) => {
  const keys = norm(full).split(" ").filter((w) => !LEGAL.has(w)).map(soundKey);
  const words = norm(said).split(" ").filter((w) => !LEGAL.has(w));
  return words.length > 0 && words.every((w) => soundKey(w).length >= 2 && keys.includes(soundKey(w)));
};
const mask = (f: { iban?: string | null; accountNumber?: string | null }) => { const n = f.iban ?? f.accountNumber; return n ? `•••• ${n.slice(-4)}` : null; };
const addressOf = (from: string) => from.match(/<([^>]+)>/)?.[1] ?? from;
/** The payee as matched, noting the words said when they only sound alike ("Cruzeburg Studio" for "Kreuzberg Studio GmbH"). */
const named = (u: Understood, full: string | null, said: string) => Object.assign(u, { value: full, source: full && !sameName(full, said) ? `you said “${said}”` : "you said" });
const SAID_FROM = "You (said)";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** The item for the payee said: by name, else by sound, but only when exactly one payee sounds like it. */
function pick<T extends InboxItem>(items: T[], said: string): T | undefined {
  const named = items.filter((i) => i.fields.payeeName);
  const exact = named.find((i) => sameName(i.fields.payeeName!, said));
  if (exact) return exact;
  const alike = named.filter((i) => soundsLike(i.fields.payeeName!, said));
  return new Set(alike.map((i) => norm(i.fields.payeeName!))).size === 1 ? alike[0] : undefined;
}

export async function say(inbox: Inbox, transcript: string, now = new Date()): Promise<SayResult> {
  const heard = transcript.trim().slice(0, 500);
  const intent = await readSpoken(heard);
  const said = (field: Understood["field"], value: string | null): Understood => ({ field, value, source: "you said" });
  const understood: Understood[] = [said("payee", intent.payee), said("amount", intent.amount), said("currency", intent.currency), said("reference", intent.reference)];
  const out = (problem: string | null, item: InboxItem | null = null): SayResult => ({ heard, reader: intent.reader, understood, item, problem });
  if (intent.action !== "pay") return out("I only make payments for now. Try \"Pay Kreuzberg Studio 480 euros\".");
  if (!intent.payee) return out("I didn't catch who to pay.");

  const items = inbox.list();
  // An invoice already waiting for this payee: the words just point at it.
  const waiting = pick(items.filter((i) => (i.status === "awaiting_approval" || i.status === "needs_verification") && (!intent.amount || Number(i.fields.amount) === Number(intent.amount))), intent.payee);
  if (waiting) {
    const from = waiting.from === SAID_FROM ? "what you said earlier" : `the invoice from ${addressOf(waiting.from)}`;
    for (const [field, v] of [["amount", waiting.fields.amount], ["currency", waiting.fields.currency], ["reference", waiting.fields.reference]] as const) {
      const u = understood.find((x) => x.field === field)!;
      if (!u.value) Object.assign(u, { value: v, source: from });
    }
    named(understood.find((x) => x.field === "payee")!, waiting.fields.payeeName, intent.payee);
    understood.push({ field: "bank", value: mask(waiting.fields), source: waiting.from === SAID_FROM ? `your earlier payment to ${waiting.fields.payeeName}` : from });
    return out(null, waiting);
  }

  if (!intent.amount) return out(`How much should I pay ${intent.payee}?`);
  // Bank details only from a payee already paid; never from speech.
  const known = pick(items.filter((i) => i.payout?.status === "paid"), intent.payee);
  if (!known) return out(`I haven't paid ${intent.payee} before, so I don't have their bank details. Forward me their invoice instead.`);
  const currency = intent.currency ?? known.fields.currency;
  if (!intent.currency) Object.assign(understood.find((x) => x.field === "currency")!, { value: currency, source: `your last payment to ${known.fields.payeeName}` });
  named(understood.find((x) => x.field === "payee")!, known.fields.payeeName, intent.payee);
  understood.push({ field: "bank", value: mask(known.fields), source: `your payment to ${known.fields.payeeName} on ${day(known.receivedAt)}` });

  const reference = intent.reference ?? `Said ${now.toISOString().slice(0, 10)}`;
  if (!intent.reference) Object.assign(understood.find((x) => x.field === "reference")!, { value: reference, source: "Sayso, since you named none" });
  const item = await inbox.receiveFields({
    messageId: `said-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, from: SAID_FROM, subject: `Said: ${heard.slice(0, 60)}`, body: heard, receivedAt: now,
  }, { ...known.fields, amount: intent.amount, currency, reference, dueDate: null });
  return out(null, item);
}
