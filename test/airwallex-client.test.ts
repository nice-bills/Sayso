import { afterEach, describe, expect, it, vi } from "vitest";
import { Airwallex, AirwallexError, fxRatePerSell, globalAccountCurrencies } from "../src/airwallex/client.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function stubFetch(handler: (url: string) => Response) {
  const sent: Array<{ url: string; auth?: string; body?: string }> = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization, body: typeof init?.body === "string" ? init.body : undefined });
    return handler(url);
  });
  return sent;
}

const client = () => new Airwallex({ clientId: "id", apiKey: "key", baseUrl: "https://awx.test" });

afterEach(() => vi.unstubAllGlobals());

describe("Airwallex client conventions", () => {
  it("turns a pair-convention rate into buy units per sell unit", () => {
    // Live sandbox answer to sell USD, buy EUR: currency_pair EURUSD, rate 1.138648 (USD per EUR).
    expect(fxRatePerSell(1.138648, "EURUSD", "USD", "EUR")).toBeCloseTo(0.8782, 4);
    expect(fxRatePerSell(0.88, "USDEUR", "USD", "EUR")).toBe(0.88);
    expect(() => fxRatePerSell(1.35, "GBPUSD", "USD", "EUR")).toThrow();
  });

  it("reads a global account's currencies from required_features", () => {
    expect(globalAccountCurrencies({ id: "ga", required_features: [{ currency: "USD", transfer_method: "LOCAL" }] })).toEqual(["USD"]);
    expect(globalAccountCurrencies({ id: "ga" })).toEqual([]);
  });
});

describe("Airwallex token expiry", () => {
  it("logs in once more and resends the same call, body and request_id", async () => {
    let logins = 0, calls = 0;
    const sent = stubFetch((url) => {
      if (url.endsWith("/authentication/login")) return json(200, { token: `t${++logins}` });
      return ++calls === 1 ? json(401, { code: "unauthorized" }) : json(200, { id: "ben_1" });
    });

    const body = { request_id: "beneficiary-payout-1", beneficiary: { company_name: "Kreuzberg Studio" }, transfer_methods: ["LOCAL"] };
    expect(await client().createBeneficiary(body)).toEqual({ id: "ben_1" });
    expect(logins).toBe(2);
    expect(calls).toBe(2);

    const posts = sent.filter((s) => s.url.endsWith("/beneficiaries/create"));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body!).request_id).toBe("beneficiary-payout-1");
    expect(posts[1]!.body).toBe(posts[0]!.body);
    expect(posts[1]!.auth).toBe("Bearer t2");
  });

  it("fails after one retry when the second call is also a 401, without looping", async () => {
    let logins = 0, calls = 0;
    stubFetch((url) => {
      if (url.endsWith("/authentication/login")) return json(200, { token: `t${++logins}` });
      calls++;
      return json(401, { code: "unauthorized" });
    });

    await expect(client().currentBalances()).rejects.toMatchObject({ status: 401 });
    expect(logins).toBe(2);
    expect(calls).toBe(2);
  });

  it("never retries a 401 from the login call itself", async () => {
    let logins = 0;
    const sent = stubFetch(() => {
      logins++;
      return json(401, { code: "unauthorized" });
    });

    await expect(client().currentBalances()).rejects.toBeInstanceOf(AirwallexError);
    expect(logins).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
