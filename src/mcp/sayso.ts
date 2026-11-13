// Talking to a Sayso host from an MCP tool, where the caller is a language model and cannot see a
// stack trace.
//
// Every request has a deadline. A host that is restarting often answers with an HTML error page
// from whatever proxy sits in front of it; an HTML body, a non-JSON body and a dead connection all
// become a short sentence an agent can act on ("Sayso is restarting; retry in a minute"), never a
// parser error and never raw HTML. A payment that times out is looked up before the tool answers:
// the quote may already be paid, and a quote can be paid only once.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Failure {
  ok: false;
  /** Sayso's HTTP status when it answered at all. */
  http_status?: number;
  error: string;
  /** Whether trying again later is safe. A business refusal (bad details, a hold) is not. */
  retryable: boolean;
  /** What the agent should do next, in plain words. */
  next?: string;
}

export type Reply<T> = { ok: true; http_status: number; data: T } | Failure;

/** What Sayso publishes for agents to check signed offers against. */
export interface Published {
  quote_signer: `0x${string}`;
  pay_to: string;
}

export interface PayOutcome {
  http_status: number;
  [key: string]: unknown;
  /** The pay call got no usable answer and the lookup below could not settle it either. */
  unconfirmed?: boolean;
  /** The pay call got no usable answer, but the payout shows the payment arrived. */
  unconfirmed_then_found?: boolean;
  retryable?: boolean;
  next?: string;
}

/** Statuses that mean no money was taken. Anything else (accepted, funded, submitted, paid, failed, refunded) means it was. */
const UNPAID = new Set(["quoted", "expired", "rejected", "needs_review"]);

export const failed = (error: string, opts: { http_status?: number; retryable?: boolean; next?: string } = {}): Failure => ({
  ok: false, error, retryable: opts.retryable ?? false, ...(opts.http_status !== undefined ? { http_status: opts.http_status } : {}), ...(opts.next ? { next: opts.next } : {}),
});

const say = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160);
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
const isTimeout = (err: unknown) =>
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) || /timed? ?out|aborted?/i.test(String(err));

/** A page from a proxy or a login wall, not Sayso's JSON. */
export const isHtml = (body: string, contentType: string | null) =>
  /^\s*(?:<!doctype\s+html|<html|<head|<body|<\?xml)/i.test(body) || /text\/html/i.test(contentType ?? "");

/** The `error` Sayso itself put in a JSON body, if it did. Never returns HTML. */
function jsonError(body: string): string | undefined {
  try {
    const j: unknown = JSON.parse(body);
    if (j && typeof j === "object") {
      const e = (j as { error?: unknown; message?: unknown }).error ?? (j as { message?: unknown }).message;
      if (typeof e === "string" && e.trim()) return e.trim();
    }
  } catch {
    // Not JSON: the caller reports that separately.
  }
  return undefined;
}

/** A short, agent-safe message for any HTTP answer. */
function statusFailure(status: number, body: string, type: string | null, what: string): Failure {
  const detail = isHtml(body, type) ? undefined : jsonError(body);
  if (status >= 500) {
    return failed(
      `${what}: Sayso is restarting or briefly unavailable (HTTP ${status})${detail ? `: ${detail}` : ""}. Retry in about a minute.`,
      { http_status: status, retryable: true },
    );
  }
  if (isHtml(body, type)) {
    return failed(
      `${what}: Sayso answered with a web page instead of data (HTTP ${status}). It is probably restarting or behind a proxy. Retry in about a minute.`,
      { http_status: status, retryable: true },
    );
  }
  return failed(`${what}: ${detail ?? `Sayso refused it (HTTP ${status})`}${detail ? ` (HTTP ${status})` : ""}`, {
    http_status: status, retryable: status === 429, ...(status === 429 ? { next: "Wait a moment, then retry the same call." } : {}),
  });
}

/**
 * One JSON request with a deadline and an agent-facing result. Never throws for an HTTP or network
 * problem, and never parses an HTML page as if it were JSON.
 */
export async function requestJson<T>(f: FetchLike, url: string, init: RequestInit, opts: { what: string; timeoutMs: number; base?: string }): Promise<Reply<T>> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    return failed(
      isTimeout(err)
        ? `${opts.what}: Sayso did not answer within ${seconds(opts.timeoutMs)}. It is probably restarting or unreachable; retry in about a minute.`
        : `${opts.what}: couldn't reach Sayso${opts.base ? ` at ${opts.base}` : ""} (${say(err)}). It may be restarting; retry in about a minute.`,
      { retryable: true },
    );
  }
  const body = await res.text().catch(() => "");
  const type = res.headers.get("content-type");
  if (res.status >= 500 || !res.ok) return statusFailure(res.status, body, type, opts.what);
  if (isHtml(body, type)) return statusFailure(res.status, body, type, opts.what);
  if (!body.trim()) return { ok: true, http_status: res.status, data: {} as T };
  try {
    return { ok: true, http_status: res.status, data: JSON.parse(body) as T };
  } catch {
    // A 200 that isn't JSON is usually a proxy or a half-written restart, not an answer Sayso meant.
    return failed(`${opts.what}: Sayso answered with something that isn't JSON (HTTP ${res.status}). It may be restarting; retry in about a minute.`, { http_status: res.status, retryable: true });
  }
}

/** Reads a payment endpoint's body. HTML, or anything unparseable, is "no usable answer", not a result. */
async function paymentAnswer(res: Response): Promise<{ data: Record<string, unknown>; why?: string }> {
  const body = await res.text().catch(() => "");
  const type = res.headers.get("content-type");
  if (isHtml(body, type)) return { data: {}, why: `HTML (HTTP ${res.status})` };
  if (!body.trim()) return { data: {} };
  try {
    const j: unknown = JSON.parse(body);
    return { data: j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : { value: j } };
  } catch {
    return { data: {}, why: `not JSON (HTTP ${res.status})` };
  }
}

export interface SaysoClientOptions {
  base: string;
  /** Read-only requests. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** The client that pays over x402. Called only when paying, and may throw if its key is missing. */
  payingFetch?: () => FetchLike;
  /** Deadline for a quote, status or proof read. 20s by default. */
  timeoutMs?: number;
  /** Deadline for a payment, which waits on Metal settlement. 90s by default. */
  payTimeoutMs?: number;
}

export class SaysoClient {
  readonly base: string;
  private readonly f: FetchLike;
  private readonly timeoutMs: number;
  private readonly payTimeoutMs: number;
  private published?: Published;
  private pending?: Promise<Reply<Published>>;

  constructor(private readonly opts: SaysoClientOptions) {
    this.base = opts.base;
    this.f = opts.fetch ?? (fetch as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.payTimeoutMs = opts.payTimeoutMs ?? 90_000;
  }

  request<T>(path: string, init: RequestInit, what: string): Promise<Reply<T>> {
    return requestJson<T>(this.f, `${this.base}${path}`, init, { what, timeoutMs: this.timeoutMs, base: this.base });
  }

  get<T>(path: string, what: string): Promise<Reply<T>> {
    return this.request<T>(path, { method: "GET" }, what);
  }

  post<T>(path: string, body: unknown, what: string, headers: Record<string, string> = {}): Promise<Reply<T>> {
    return this.request<T>(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, what);
  }

  /**
   * Sayso's offer key and payee address. A successful read is reused; a failure is not remembered,
   * so one restart cannot poison every later check.
   */
  healthz(): Promise<Reply<Published>> {
    if (this.published) return Promise.resolve({ ok: true, http_status: 200, data: this.published });
    this.pending ??= this.get<Published>("/healthz", "checking Sayso's signing key")
      .then((r) => {
        if (r.ok) this.published = r.data;
        return r;
      })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /**
   * Pays one quote. If the call times out or answers with something unreadable, the payout is looked
   * up before answering: an agent that reads "unconfirmed" knows to check status instead of paying again,
   * and a payment that did land is reported as such. Never retries the pay call itself.
   */
  async pay(id: string, body?: string): Promise<PayOutcome> {
    return this.payAt(`/v1/payouts/${encodeURIComponent(id)}/pay`, `/v1/payouts/${encodeURIComponent(id)}`, body, `payout_status for ${id}`, "quote");
  }

  /** Pays a batch. Same rule as a single payout: look the batch up before telling the agent it failed. */
  async payBatch(id: string, payPath = `/v1/batches/${encodeURIComponent(id)}/pay`): Promise<PayOutcome> {
    return this.payAt(payPath, `/v1/batches/${encodeURIComponent(id)}`, undefined, `batch_status for ${id}`, "batch");
  }

  private async payAt(payPath: string, lookupPath: string, body: string | undefined, statusTool: string, kind: "quote" | "batch"): Promise<PayOutcome> {
    let f: FetchLike;
    try {
      f = this.opts.payingFetch?.() ?? this.f;
    } catch (err) {
      return { http_status: 500, error: `Could not set up the payment: ${say(err)}`, retryable: false };
    }
    const init: RequestInit = {
      method: "POST",
      signal: AbortSignal.timeout(this.payTimeoutMs),
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
    };
    let res: Response;
    try {
      res = await f(`${this.base}${payPath}`, init);
    } catch (err) {
      return this.unanswered(kind, lookupPath, statusTool, isTimeout(err) ? "the request timed out" : say(err));
    }
    const { data, why } = await paymentAnswer(res);
    // A 5xx or an unreadable body may be a restart after the payment settled; treat it as unconfirmed.
    if (res.status >= 500 || why) return this.unanswered(kind, lookupPath, statusTool, why ?? `HTTP ${res.status}`);
    // 409 means this quote was already being paid or is finished. Point at status rather than inviting a new quote.
    const next = res.status === 409 ? `Call ${statusTool} before paying again; a ${kind} can't be paid twice.` : undefined;
    return { http_status: res.status, ...data, ...(next ? { next } : {}) };
  }

  /** Asks Sayso what actually happened, then answers the agent with either the found payment or an explicit "unconfirmed". */
  private async unanswered(kind: "quote" | "batch", lookupPath: string, statusTool: string, why: unknown): Promise<PayOutcome> {
    const found = await this.get<{ status?: string; funding_tx?: string | null }>(lookupPath, "checking whether the payment went through");
    const after = found.ok ? found.data : undefined;
    const status = after?.status;
    if (status && (kind === "batch" ? status === "accepted" || status === "funded" : !UNPAID.has(status))) {
      return {
        http_status: 200, unconfirmed_then_found: true, status, ...(kind === "quote" ? { funding_tx: after?.funding_tx ?? null } : {}),
        next: `The payment reached Sayso. Follow it with ${statusTool}; do not pay it again.`,
      };
    }
    return {
      http_status: 504, unconfirmed: true, retryable: true,
      error: `The payment is unconfirmed, not failed: Sayso gave no usable answer while paying (${say(why)}).`,
      next: kind === "quote"
        ? `Call ${statusTool} before trying again. If it is still quoted, pay that same quote with pay_quote; otherwise the payment already went through. A quote can't be paid twice.`
        : `Call ${statusTool} before doing anything else. If the batch is still quoted, its payment did not confirm: do not create the batch again (a second payment could pay twice), and check batch_status again in a minute. If it is accepted or funded, it went through.`,
    };
  }
}
