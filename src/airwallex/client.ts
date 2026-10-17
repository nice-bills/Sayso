// Typed Airwallex REST client for the calls Coin Slot makes. Paths and quirks follow the
// hackathon builder guide (airwallexdev.com/guide); check exact payload fields against the
// docs MCP (https://mcp.sandbox.airwallex.com/docs) before relying on a new call.
//
// Conventions enforced here so callers can't get them wrong:
// - amounts on the wire are major units (100 = one hundred dollars);
// - every mutating call takes a request_id, reused only to retry the same operation;
// - FX calls never send x-api-version;
// - the bearer token lasts 30 minutes and is refreshed before it expires.

import { randomUUID } from "node:crypto";

export interface AirwallexConfig {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
}

export class AirwallexError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, readonly body: unknown, path: string) {
    super(`Airwallex ${status} ${code ?? ""} on ${path}: ${JSON.stringify(body)}`);
  }
}

export type TransferStatus = "PROCESSING" | "SENT" | "PAID" | "CANCELLED" | (string & {});

export interface Transfer {
  id: string;
  request_id: string;
  status: TransferStatus;
  transfer_amount: number;
  transfer_currency: string;
  failure_reason?: string;
  failure_type?: string;
}

export class Airwallex {
  private token?: { value: string; expiresAt: number };
  private readonly baseUrl: string;

  constructor(private readonly cfg: AirwallexConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api.sandbox.airwallex.com";
  }

  static fromEnv(): Airwallex {
    const { AWX_CLIENT_ID, AWX_API_KEY, AWX_BASE_URL } = process.env;
    if (!AWX_CLIENT_ID || !AWX_API_KEY) throw new Error("Set AWX_CLIENT_ID and AWX_API_KEY (sandbox.airwallex.com > Account > Developer > API keys)");
    return new Airwallex({ clientId: AWX_CLIENT_ID, apiKey: AWX_API_KEY, baseUrl: AWX_BASE_URL });
  }

  static newRequestId = (): string => randomUUID();

  private async bearer(): Promise<string> {
    // Refresh a minute early so a long run never sends an expired token.
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.cfg.clientId, "x-api-key": this.cfg.apiKey },
    });
    const body = (await res.json()) as { token?: string };
    if (!res.ok || !body.token) throw new AirwallexError(res.status, undefined, body, "/authentication/login");
    this.token = { value: body.token, expiresAt: Date.now() + 30 * 60_000 };
    return body.token;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.bearer()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new AirwallexError(res.status, (parsed as { code?: string }).code, parsed, path);
    return parsed as T;
  }

  // --- Accounts and balances ---
  currentBalances = () => this.call<Array<{ currency: string; available_amount: number; total_amount: number }>>("GET", "/balances/current");
  globalAccounts = () => this.call<{ items: Array<{ id: string; currency?: string; country_code?: string }> }>("GET", "/global_accounts");
  createGlobalAccount = (countryCode: string, currency: string, requestId = Airwallex.newRequestId()) =>
    this.call<{ id: string }>("POST", "/global_accounts/create", {
      request_id: requestId,
      country_code: countryCode,
      required_features: [{ currency, transfer_method: "LOCAL" }],
    });

  // --- FX: a rate is indicative, a quote is single-use and locks the rate ---
  fxRate = (sellCurrency: string, buyCurrency: string) =>
    this.call<{ rate: number }>("GET", "/fx/rates/current", undefined, { sell_currency: sellCurrency, buy_currency: buyCurrency });
  fxQuote = (body: { sell_currency: string; buy_currency: string; buy_amount: string; validity: string }) =>
    this.call<{ quote_id: string; client_rate: number; sell_amount: number }>("POST", "/fx/quotes/create", body);
  fxConvert = (body: { request_id: string; sell_currency: string; buy_currency: string; buy_amount: string; quote_id?: string }) =>
    this.call<{ id: string; status: string; sell_amount: number; buy_amount: number }>("POST", "/fx/conversions/create", body);

  // --- Beneficiaries ---
  beneficiarySchema = (body: unknown) => this.call<unknown>("POST", "/beneficiaries/schema", body);
  validateBeneficiary = (beneficiary: unknown, transferMethods: Array<"LOCAL" | "SWIFT">) =>
    this.call<unknown>("POST", "/beneficiaries/validate", { beneficiary, transfer_methods: transferMethods });
  createBeneficiary = (body: unknown) => this.call<{ beneficiary_id: string }>("POST", "/beneficiaries/create", body);

  // --- Transfers (a failed transfer ends CANCELLED, never FAILED) ---
  createTransfer = (body: {
    request_id: string;
    beneficiary_id: string;
    transfer_amount: string;
    transfer_currency: string;
    transfer_method: "LOCAL" | "SWIFT";
    reference: string;
    reason: string;
    source_currency?: string;
  }) => this.call<Transfer>("POST", "/transfers/create", body);
  transfers = (query: Record<string, string> = {}) => this.call<{ items: Transfer[] }>("GET", "/transfers", undefined, query);

  /** Find a transfer by our request_id, so an ambiguous create is checked before any retry. */
  async transferByRequestId(requestId: string): Promise<Transfer | undefined> {
    const { items } = await this.transfers({ request_id: requestId });
    return items.find((t) => t.request_id === requestId);
  }

  // --- Issuing: the agent's own card for its compute bills ---
  createCardholder = (body: unknown) => this.call<{ cardholder_id: string }>("POST", "/issuing/cardholders/create", body);
  createCard = (body: unknown) => this.call<{ card_id: string }>("POST", "/issuing/cards/create", body);
  updateCard = (cardId: string, body: { card_status: "ACTIVE" | "INACTIVE" | "CLOSED" } & Record<string, unknown>) =>
    this.call<unknown>("POST", `/issuing/cards/${cardId}/update`, body);
  issuingTransactions = (query: Record<string, string> = {}) => this.call<{ items: unknown[] }>("GET", "/issuing/transactions", undefined, query);

  // --- Sandbox simulation (kept behind this client so live paths replace them one by one) ---
  simulateDeposit = (globalAccountId: string, amount: number, payerName: string) =>
    this.call<{ id: string; status: string }>("POST", "/simulation/deposit/create", { global_account_id: globalAccountId, amount, payer_name: payerName });
  simulateTransfer = (transferId: string, body: { next_status: string; failure_type?: string }) =>
    this.call<Transfer>("POST", `/simulation/transfers/${transferId}/transition`, body);
  simulateCardAuth = (body: unknown) => this.call<{ transaction_id: string }>("POST", "/simulation/issuing/create", body);
}
