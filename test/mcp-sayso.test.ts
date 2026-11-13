import { describe, expect, it } from "vitest";
import { requestJson, SaysoClient, type FetchLike } from "../src/mcp/sayso.js";

const answer = (body: unknown, status = 200, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

type Call = { url: string; method: string; signal?: AbortSignal };
const recorder = (handle: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", ...(init?.signal instanceof AbortSignal ? { signal: init.signal } : {}) });
    return handle(url, init);
  };
  return { f, calls };
};

const html502 = () => answer("<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>", 502, "text/html");
const id = "00000000-0000-0000-0000-000000000001";

describe("a Sayso that is restarting reaches the agent as a sentence, not HTML", () => {
  it("turns an HTML 502 into 'restarting, retry in about a minute'", async () => {
    const { f, calls } = recorder(html502);
    const r = await requestJson(f, "http://sayso.test/v1/quotes", { method: "POST" }, { what: "quoting the payout", timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.http_status).toBe(502);
    expect(r.retryable).toBe(true);
    expect(r.error).toMatch(/restarting/i);
    expect(r.error).toMatch(/retry in about a minute/i);
    expect(r.error).not.toMatch(/<!doctype|<html|unexpected token/i);
    // Every call carries a deadline, so a silent host cannot hang the agent.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not parse a web page served with HTTP 200 as JSON", async () => {
    const { f } = recorder(() => answer("<html><body>Sign in</body></html>", 200, "text/html"));
    const r = await requestJson(f, "http://sayso.test/v1/payouts/x", {}, { what: "reading the payout", timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/web page instead of data/i);
    expect(r.error).toMatch(/retry/i);
    expect(r.error).not.toMatch(/<html|unexpected token/i);
  });

  it("reports a timeout in words an agent can act on", async () => {
    const { f } = recorder(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const r = await requestJson(f, "http://sayso.test/v1/quotes", {}, { what: "quoting the payout", timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/did not answer within/i);
    expect(r.retryable).toBe(true);
  });

  it("passes Sayso's own JSON error through, without making it look retryable", async () => {
    const { f } = recorder(() => answer({ error: "amount: major units, at most 2 decimals" }, 400));
    const r = await requestJson(f, "http://sayso.test/v1/quotes", { method: "POST" }, { what: "quoting the payout", timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("amount: major units, at most 2 decimals");
    expect(r.http_status).toBe(400);
    expect(r.retryable).toBe(false);
  });
});

describe("Sayso's published key is read again after a restart", () => {
  it("does not remember a failed healthz, so one restart does not poison every later check", async () => {
    let n = 0;
    const { f, calls } = recorder(() => (++n === 1 ? html502() : answer({ quote_signer: "0xabc", pay_to: "0xdef" })));
    const c = new SaysoClient({ base: "http://sayso.test", fetch: f, timeoutMs: 50, payTimeoutMs: 50 });
    expect((await c.healthz()).ok).toBe(false);
    const good = await c.healthz();
    expect(good.ok).toBe(true);
    expect((await c.healthz()).ok).toBe(true);
    expect(calls).toHaveLength(2); // the successful read is reused
  });
});

describe("a payment that gets no answer is looked up, never paid twice", () => {
  const client = (f: FetchLike) => new SaysoClient({ base: "http://sayso.test", fetch: f, payingFetch: () => f, timeoutMs: 50, payTimeoutMs: 50 });

  it("finds a payment that landed after the pay call timed out, and keeps one pay request", async () => {
    const { f, calls } = recorder((url) => {
      if (url.endsWith("/pay")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return answer({ status: "paid", funding_tx: "0xfeed" });
    });
    const r = await client(f).pay(id);
    expect(r.http_status).toBe(200);
    expect(r.unconfirmed_then_found).toBe(true);
    expect(r.status).toBe("paid");
    expect(r.funding_tx).toBe("0xfeed");
    expect(calls.filter((c) => c.url.endsWith("/pay"))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith("/pay"))?.signal).toBeInstanceOf(AbortSignal);
  });

  it("says the payment is unconfirmed, and to check payout_status, when the lookup still says quoted", async () => {
    const { f, calls } = recorder((url) => (url.endsWith("/pay") ? html502() : answer({ status: "quoted" })));
    const r = await client(f).pay(id);
    expect(r.http_status).toBe(504);
    expect(r.unconfirmed).toBe(true);
    expect(r.retryable).toBe(true);
    expect(String(r.error)).toMatch(/unconfirmed, not failed/i);
    expect(String(r.next)).toMatch(/payout_status/);
    expect(String(r.next)).toMatch(/can't be paid twice/);
    expect(calls.filter((c) => c.url.endsWith("/pay"))).toHaveLength(1);
  });

  it("treats a non-JSON 202 from the pay endpoint as unconfirmed and looks the payout up", async () => {
    const { f, calls } = recorder((url) => (url.endsWith("/pay") ? answer("accepted", 202, "text/plain") : answer({ status: "accepted", funding_tx: "0x1" })));
    const r = await client(f).pay(id);
    expect(r.unconfirmed_then_found).toBe(true);
    expect(r.http_status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("returns a normal 202 answer without a second request", async () => {
    const { f, calls } = recorder(() => answer({ status: "accepted", status_url: `/v1/payouts/${id}` }, 202));
    const r = await client(f).pay(id);
    expect(r).toMatchObject({ http_status: 202, status: "accepted" });
    expect(calls).toHaveLength(1);
  });

  it("looks a batch up when its payment timed out, and does not pay it again", async () => {
    const batch = "00000000-0000-0000-0000-000000000002";
    const { f, calls } = recorder((url) => {
      if (url.endsWith("/pay")) throw new DOMException("timed out", "TimeoutError");
      return answer({ id: batch, status: "funded", progress: { submitted: 2 } });
    });
    const r = await client(f).payBatch(batch);
    expect(r.http_status).toBe(200);
    expect(r.unconfirmed_then_found).toBe(true);
    expect(r.status).toBe("funded");
    expect(calls.filter((c) => c.url.endsWith("/pay"))).toHaveLength(1);
  });
});
