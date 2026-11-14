// Sayso as the payouts layer for Base44 apps (and any other app backend).
//
// A builder's app gets an API key. Its backend functions or agents POST payouts here; Sayso applies
// the app's plain-English rules, then hands the payout to the same inbox every other invoice goes
// through: Airwallex validates the payee, the risk rules read it, a bank-detail change is held, a new
// payee waits for the owner's passkey, and nothing is paid until the owner approves. The app can
// never approve its own payout. Every state change is sent back as a signed webhook, so the app's
// own UI (a Base44 entity, say) shows it live.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AgentKey, AgentKeys } from "../agents/keys.js";
import { emit } from "../events.js";
import type { Inbox, InboxItem } from "../inbox/inbox.js";
import type { InvoiceFields } from "../inbox/extract.js";
import { PayoutError } from "../payouts/service.js";
import type { Store } from "../store.js";
import { toMinor } from "../treasury/money.js";
import { checkRules, compileRules, describeRules, NO_RULES, Rules } from "./rules.js";
import { machine, register } from "../machine.js";

export const KEY_PREFIX = "Base44: ";

export interface PlatformApp {
  id: string; name: string; keyId: string; webhookUrl: string | null; rulesText: string; rules: Rules; createdAt: string; revokedAt: string | null;
}

/** What an app sends to pay someone. `ref` is the app's own id for the payout and makes the call idempotent. */
export const PlatformPayout = z.object({
  ref: z.string().min(1).max(100).regex(/^[\w.:-]+$/, "letters, digits and . _ : - only"),
  payee_name: z.string().min(1).max(140),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "major units, at most 2 decimals").refine((a) => Number(a) > 0, "amount must be above zero"),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  reference: z.string().max(35).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  bank: z.object({
    country: z.string().length(2).optional(),
    iban: z.string().max(40).optional(),
    account_number: z.string().max(34).optional(),
    sort_code: z.string().max(10).optional(),
    routing_number: z.string().max(9).optional(),
  }).refine((b) => b.iban || b.account_number, "bank.iban or bank.account_number is required"),
  address: z.object({ country: z.string().length(2).optional(), city: z.string().optional(), street: z.string().optional(), postcode: z.string().optional() }).optional(),
  /** Why the app is paying: an invoice, a milestone, a message. Read by the risk rules; it can only make Sayso more careful. */
  context: z.string().max(10_000).optional(),
});
export type PlatformPayout = z.infer<typeof PlatformPayout>;

// What a connected app sees: the invoice's state until it is approved, then the payout's outcome.
export const APP_PAYOUT = register(machine("app_payout", ["needs_details", "awaiting_approval", "needs_verification", "rejected", "duplicate"], {
  needs_details: { means: "Something needed to pay it is missing. The owner can add it in Sayso.", waitingOn: "owner", to: ["needs_details", "awaiting_approval", "needs_verification", "rejected", "duplicate", "ignored"] },
  awaiting_approval: { means: "Checked and ready. The owner approves it with a passkey at approval_url.", waitingOn: "owner", to: ["paying", "paid", "failed", "refunded", "ignored"] },
  needs_verification: { means: "Held. The owner has to confirm the bank details with the payee, then approve at approval_url.", waitingOn: "owner", to: ["paying", "paid", "failed", "refunded", "ignored"] },
  rejected: { means: "Sayso will not pay this one.", waitingOn: "nobody", to: [] },
  duplicate: { means: "It looks like a payout that is already here, so it was not queued again.", waitingOn: "nobody", to: [] },
  ignored: { means: "The owner set it aside. Nothing was paid.", waitingOn: "nobody", to: [] },
  paying: { means: "Approved and on its way to the bank.", waitingOn: "bank", to: ["paid", "failed", "refunded"] },
  // Not final: a bank can return a payout after it was paid.
  paid: { means: "Delivered to the payee. A bank can still return it later.", waitingOn: "nobody", to: ["failed", "refunded"] },
  failed: { means: "The bank or Airwallex refused it or returned it. The money is still in the owner's balance.", waitingOn: "nobody", to: [] },
  refunded: { means: "It failed and the money was returned.", waitingOn: "nobody", to: [] },
}));
export type AppPayoutState = keyof typeof APP_PAYOUT.states;

// "paid" is not final: a bank can return a payout later, and the app should hear about the refund.
const TERMINAL = new Set(["failed", "refunded", "rejected", "ignored", "duplicate"]);

/** The state an app hears about, from the inbox item and the payout behind it. */
export function stateOf(item: InboxItem & { payout: { status: string } | null }): string {
  const ps = item.payout?.status;
  if (ps === "paid" || ps === "failed" || ps === "refunded") return ps;
  if (item.status === "paying") return "paying";
  return item.status;
}

// ---------- webhook signing ----------

export const signWebhook = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

/** For receivers (and our tests): checks the signature and rejects anything older than the tolerance. */
export function verifyWebhook(secret: string, header: string, body: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const t = Number(header.match(/t=(\d+)/)?.[1]);
  const v1 = header.match(/v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1 || Math.abs(now - t) > toleranceSec) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const got = Buffer.from(v1);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A webhook must be https and must not point at the machine's own network (unless running offline). */
export function checkWebhookUrl(raw: string, offline: boolean): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new PayoutError(400, "webhook_url isn't a URL"); }
  if (offline) return u.toString();
  if (u.protocol !== "https:") throw new PayoutError(400, "webhook_url must be https");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":") || /^\d+$/.test(h)) throw new PayoutError(400, "webhook_url must be a public host");
  return u.toString();
}

export interface PlatformOpts { offline: boolean; baseUrl: () => string; approvalPath: (inboxId: string) => string; compile?: (text: string) => Promise<Rules>; fetch?: typeof fetch }

export class Platform {
  private readonly send: typeof fetch;
  /** Submits still queueing their payout, so a duplicate ref can wait for the first one. */
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly keys: AgentKeys, private readonly inbox: Inbox, private readonly o: PlatformOpts) {
    this.send = o.fetch ?? fetch;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key_id TEXT NOT NULL UNIQUE, webhook_url TEXT, webhook_secret TEXT NOT NULL,
        rules_text TEXT NOT NULL DEFAULT '', rules_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS platform_refs (
        app_id TEXT NOT NULL, ref TEXT NOT NULL, inbox_id TEXT NOT NULL, request_hash TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
        last_state TEXT, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (app_id, ref)
      );
      CREATE TABLE IF NOT EXISTS platform_events (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        delivered_at TEXT, last_error TEXT
      );`);
  }

  // ---------- apps (owner) ----------

  async createApp(name: string, webhookUrl: string | null, rulesText: string): Promise<{ app: PlatformApp; apiKey: string; webhookSecret: string; rules: string[] }> {
    const nm = name.trim().slice(0, 50);
    if (!nm) throw new PayoutError(400, "name the app");
    const url = webhookUrl ? checkWebhookUrl(webhookUrl, this.o.offline) : null;
    const rules = await this.compile(rulesText);
    const { key, agent } = this.keys.create(`${KEY_PREFIX}${nm}`, null);
    const id = `app_${randomUUID().slice(0, 12)}`;
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    this.store.db.prepare("INSERT INTO platform_apps (id, name, key_id, webhook_url, webhook_secret, rules_text, rules_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, nm, agent.id, url, secret, rulesText.trim(), JSON.stringify(rules), new Date().toISOString());
    emit("observe", `Connected the app "${nm}" as a payouts client`);
    return { app: this.app(id)!, apiKey: key, webhookSecret: secret, rules: describeRules(rules) };
  }

  /** Replaces an app's rules. Returns what the code will now enforce. */
  async setRules(id: string, text: string): Promise<string[]> {
    if (!this.app(id)) throw new PayoutError(404, "no such app");
    const rules = await this.compile(text);
    this.store.db.prepare("UPDATE platform_apps SET rules_text = ?, rules_json = ? WHERE id = ?").run(text.trim(), JSON.stringify(rules), id);
    return describeRules(rules);
  }

  setWebhook(id: string, url: string | null): void {
    if (!this.app(id)) throw new PayoutError(404, "no such app");
    this.store.db.prepare("UPDATE platform_apps SET webhook_url = ? WHERE id = ?").run(url ? checkWebhookUrl(url, this.o.offline) : null, id);
  }

  revokeApp(id: string): boolean {
    const a = this.app(id);
    if (!a || a.revokedAt) return false;
    this.keys.revoke(a.keyId);
    this.store.db.prepare("UPDATE platform_apps SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return true;
  }

  app(id: string): PlatformApp | undefined { return this.decodeApp(this.store.db.prepare("SELECT * FROM platform_apps WHERE id = ?").get(id)); }
  list(): Array<PlatformApp & { rulesDescribed: string[] }> {
    return this.store.db.prepare("SELECT * FROM platform_apps ORDER BY created_at DESC").all().map((r) => { const a = this.decodeApp(r)!; return { ...a, rulesDescribed: describeRules(a.rules) }; });
  }
  /** The live app behind an agent key, if the key was made for an app. */
  appOfKey(agent: AgentKey): PlatformApp | undefined {
    const a = this.decodeApp(this.store.db.prepare("SELECT * FROM platform_apps WHERE key_id = ?").get(agent.id));
    return a && !a.revokedAt ? a : undefined;
  }
  isPlatformKey = (agentId: string): boolean => !!this.store.db.prepare("SELECT 1 FROM platform_apps WHERE key_id = ?").get(agentId);

  private compile(text: string): Promise<Rules> { return (this.o.compile ?? compileRules)(text); }

  private decodeApp(r: unknown): PlatformApp | undefined {
    if (!r) return undefined;
    const x = r as Record<string, string | null>;
    return { id: x.id!, name: x.name!, keyId: x.key_id!, webhookUrl: x.webhook_url ?? null, rulesText: x.rules_text!, rules: Rules.parse(JSON.parse(x.rules_json!)), createdAt: x.created_at!, revokedAt: x.revoked_at ?? null };
  }

  // ---------- payouts (the app) ----------

  async submit(app: PlatformApp, input: unknown): Promise<{ created: boolean; payout: ReturnType<Platform["view"]> }> {
    const parsed = PlatformPayout.safeParse(input);
    if (!parsed.success) throw new PayoutError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    const p = parsed.data;
    const hash = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const inboxId = `b44:${app.id}:${p.ref}`;
    const prior = this.store.db.prepare("SELECT request_hash FROM platform_refs WHERE app_id = ? AND ref = ?").get(app.id, p.ref) as { request_hash: string } | undefined;
    if (prior) {
      // The same ref with the same body is a retry. A different body would let an app swap bank details after the fact.
      if (prior.request_hash !== hash) throw new PayoutError(409, "that ref was already used for a different payout; use a new ref");
      await this.running.get(`${app.id}:${p.ref}`); // the first submit may still be queueing it
      return { created: false, payout: this.view(app, p.ref)! };
    }

    const currency = p.currency.toUpperCase();
    const iban = p.bank.iban?.replace(/\s+/g, "").toUpperCase();
    const bankCountry = (p.bank.country ?? iban?.slice(0, 2) ?? "").toUpperCase();
    if (bankCountry.length !== 2) throw new PayoutError(400, "bank.country is required when paying by account number");
    const amountMinor = toMinor(Number(p.amount));

    const why = checkRules(app.rules, {
      amountMinor, currency, bankCountry, reference: p.reference ?? null,
      spentThisMonthMinor: (c) => this.spentThisMonth(app.id, c),
    });
    if (why.length) {
      emit("refuse", `${app.name} asked to pay ${p.amount} ${currency} to ${p.payee_name}; its own rules refused it`, { app: app.id, why });
      throw new PayoutError(422, `refused by this app's rules: ${why.join("; ")}`);
    }

    const fields: InvoiceFields & { extractor: string } = {
      payeeName: p.payee_name, amount: p.amount, currency, reference: p.reference ?? p.ref.slice(0, 35), bankCountry,
      iban: iban ?? null, accountNumber: iban ? null : p.bank.account_number ?? null, sortCode: p.bank.sort_code ?? null, routingNumber: p.bank.routing_number ?? null,
      addressCountry: p.address?.country?.toUpperCase() ?? bankCountry, city: p.address?.city ?? null, street: p.address?.street ?? null, postcode: p.address?.postcode ?? null,
      dueDate: p.due_date ?? null, extractor: `base44:${app.name}`,
    };
    const body = [
      `Payout requested by the app "${app.name}" (ref ${p.ref}).`,
      `Pay ${p.payee_name} ${p.amount} ${currency}. Reference: ${fields.reference}.`,
      iban ? `IBAN: ${iban}` : `Account number: ${p.bank.account_number}${p.bank.sort_code ? `, sort code ${p.bank.sort_code}` : ""}`,
      p.context ? `\nContext from the app:\n${p.context}` : "",
    ].join("\n");
    // The ref row is the claim: two submits of one ref can't both queue a payout.
    const claimed = this.store.db.prepare("INSERT OR IGNORE INTO platform_refs (app_id, ref, inbox_id, request_hash, amount_minor, currency, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(app.id, p.ref, inboxId, hash, amountMinor, currency, new Date().toISOString());
    if (!Number(claimed.changes)) {
      const row = this.store.db.prepare("SELECT request_hash FROM platform_refs WHERE app_id = ? AND ref = ?").get(app.id, p.ref) as { request_hash: string };
      if (row.request_hash !== hash) throw new PayoutError(409, "that ref was already used for a different payout; use a new ref");
      await this.running.get(`${app.id}:${p.ref}`); // the first submit may still be queueing it
      return { created: false, payout: this.view(app, p.ref)! };
    }
    const work = this.inbox.receiveFields({ messageId: inboxId, from: `${app.name} <app@platform.sayso>`, subject: `Base44 payout ${p.ref}`, body, receivedAt: new Date() }, fields)
      .then(() => this.tick()) // the first event goes out now, not at the next timer
      .catch((err) => {
        // Nothing was queued, so give the ref back and let the app try it again.
        this.store.db.prepare("DELETE FROM platform_refs WHERE app_id = ? AND ref = ? AND inbox_id = ?").run(app.id, p.ref, inboxId);
        throw err;
      });
    this.running.set(`${app.id}:${p.ref}`, work);
    try { await work; } finally { this.running.delete(`${app.id}:${p.ref}`); }
    return { created: true, payout: this.view(app, p.ref)! };
  }

  /** Spent this calendar month: payouts the app asked for that are still alive or delivered. */
  private spentThisMonth(appId: string, currency: string): number {
    const month = new Date().toISOString().slice(0, 7);
    const rows = this.store.db.prepare("SELECT amount_minor, last_state FROM platform_refs WHERE app_id = ? AND currency = ? AND created_at LIKE ?").all(appId, currency, `${month}%`) as Array<{ amount_minor: number; last_state: string | null }>;
    return rows.filter((r) => !["rejected", "ignored", "duplicate", "failed", "refunded", "needs_details"].includes(r.last_state ?? "")).reduce((s, r) => s + r.amount_minor, 0);
  }

  view(app: PlatformApp, ref: string) {
    const row = this.store.db.prepare("SELECT * FROM platform_refs WHERE app_id = ? AND ref = ?").get(app.id, ref) as { inbox_id: string } | undefined;
    if (!row) return undefined;
    const item = this.inbox.view(row.inbox_id);
    return item ? this.shape(ref, item) : undefined;
  }

  listFor(app: PlatformApp) {
    const refs = this.store.db.prepare("SELECT ref, inbox_id FROM platform_refs WHERE app_id = ? ORDER BY created_at DESC LIMIT 100").all(app.id) as Array<{ ref: string; inbox_id: string }>;
    return refs.flatMap((r) => { const i = this.inbox.view(r.inbox_id); return i ? [this.shape(r.ref, i)] : []; });
  }

  private shape(ref: string, item: ReturnType<Inbox["list"]>[number]) {
    const state = stateOf(item);
    const needsOwner = state === "awaiting_approval" || state === "needs_verification";
    return {
      ref, state, state_means: APP_PAYOUT.states[state as AppPayoutState]?.means ?? null, waiting_on: APP_PAYOUT.states[state as AppPayoutState]?.waitingOn ?? null, final: TERMINAL.has(state), payout_id: item.payoutId,
      payee: item.payout?.payee ?? item.fields.payeeName, amount: item.payout?.amount ?? item.fields.amount, currency: item.payout?.currency ?? item.fields.currency,
      reasons: item.payout?.reasons ?? [], missing: item.missing, failure: item.payout?.failure ?? null,
      // The owner's link, for showing "waiting for approval". The app can't approve: that takes the owner's passkey.
      approval_url: needsOwner ? `${this.o.baseUrl()}${this.o.approvalPath(item.id)}` : null,
      transfer_id: item.payout?.airwallex_transfer_id ?? null,
    };
  }

  // ---------- events back to the app ----------

  /** Queues an event for each payout whose state changed since the app last heard, then delivers what's due. */
  async tick(now = Date.now()): Promise<void> {
    const refs = this.store.db.prepare("SELECT r.*, a.revoked_at FROM platform_refs r JOIN platform_apps a ON a.id = r.app_id").all() as Array<{ app_id: string; ref: string; inbox_id: string; last_state: string | null; seq: number; revoked_at: string | null }>;
    const live = refs.filter((r) => !TERMINAL.has(r.last_state ?? ""));
    if (live.length) {
      for (const r of live) {
        const item = this.inbox.view(r.inbox_id);
        if (!item) continue;
        const state = stateOf(item);
        if (state === r.last_state) continue;
        // Logged, never thrown, outside tests: a move the table doesn't know must not stop an event going out.
        if (r.last_state) APP_PAYOUT.check([r.last_state as AppPayoutState], state as AppPayoutState);
        const seq = r.seq + 1;
        const data = this.shape(r.ref, item);
        const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: `payout.${state}`, created: new Date(now).toISOString(), app_id: r.app_id, sequence: seq, data });
        const id = JSON.parse(body).id as string;
        this.store.db.prepare("INSERT INTO platform_events (id, app_id, body, next_at) VALUES (?,?,?,?)").run(id, r.app_id, body, now);
        this.store.db.prepare("UPDATE platform_refs SET last_state = ?, seq = ? WHERE app_id = ? AND ref = ?").run(state, seq, r.app_id, r.ref);
      }
    }
    await this.deliver(now);
  }

  private async deliver(now: number): Promise<void> {
    const due = this.store.db.prepare("SELECT e.id, e.body, e.attempts, a.webhook_url, a.webhook_secret FROM platform_events e JOIN platform_apps a ON a.id = e.app_id WHERE e.delivered_at IS NULL AND e.attempts < 10 AND e.next_at <= ? ORDER BY e.rowid LIMIT 25").all(now) as Array<{ id: string; body: string; attempts: number; webhook_url: string | null; webhook_secret: string }>;
    for (const e of due) {
      if (!e.webhook_url) { this.store.db.prepare("UPDATE platform_events SET delivered_at = ?, last_error = 'no webhook configured' WHERE id = ?").run(new Date().toISOString(), e.id); continue; }
      try {
        const res = await this.send(e.webhook_url, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
          headers: { "content-type": "application/json", "sayso-signature": signWebhook(e.webhook_secret, e.body, Math.floor(now / 1000)), "sayso-event-id": e.id },
          body: e.body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.store.db.prepare("UPDATE platform_events SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?").run(new Date().toISOString(), e.id);
      } catch (err) {
        const wait = Math.min(3_600_000, 5000 * 2 ** e.attempts);
        this.store.db.prepare("UPDATE platform_events SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?").run(now + wait, String((err as Error).message).slice(0, 200), e.id);
      }
    }
  }

  /** For the owner: how events are going to an app. */
  eventStats(appId: string) {
    return this.store.db.prepare("SELECT COUNT(*) AS total, SUM(delivered_at IS NOT NULL) AS delivered, SUM(delivered_at IS NULL AND attempts >= 10) AS gave_up FROM platform_events WHERE app_id = ?").get(appId);
  }
}

export { NO_RULES };
