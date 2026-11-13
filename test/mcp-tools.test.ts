import { describe, expect, it } from "vitest";
import { z } from "zod";
import { invoiceShape, toRequest, usdzLimit, type Invoice } from "../src/mcp/tools.js";

// A real invoice, with the two-letter codes a careful model sends.
const invoice = {
  amount: "480.00", currency: "EUR",
  payee_name: "Etiqueta SL", payee_country: "ES", payee_city: "Madrid", payee_street: "Calle de Alcala 1", payee_postcode: "28014",
  bank_country: "ES", bank: { iban: "ES9121000418450200051332" }, reference: "2026-311",
};

const parse = (patch: Record<string, unknown> = {}) => z.object(invoiceShape).safeParse({ ...invoice, ...patch });
const required = ["amount", "currency", "payee_name", "payee_country", "payee_city", "payee_street", "payee_postcode", "bank_country", "bank", "reference"];

describe("the invoice schema tells an agent which fields are required", () => {
  it("accepts a complete invoice and requires every address and bank field except payee_state", () => {
    expect(parse().success).toBe(true);
    for (const field of required) expect(parse({ [field]: undefined }).success, field).toBe(false);
    for (const optional of ["payee_state", "method", "payee_type", "invoice_text", "due_date", "part_payment"]) {
      expect(parse({ [optional]: undefined }).success, optional).toBe(true);
    }
  });

  it("says required, and says which currency each amount is in", () => {
    for (const field of required) expect(invoiceShape[field as keyof typeof invoiceShape].description, field).toMatch(/^Required\./);
    expect(invoiceShape.amount.description).toMatch(/not USDZ/);
    expect(invoiceShape.currency.description).toMatch(/never USDZ/);
    expect(invoiceShape.payee_state.description).toMatch(/US and Canadian/);
    expect(invoiceShape.reference.description).toMatch(/35/);
    expect(usdzLimit("The most this agent will pay, in USDZ").description).toMatch(/USDZ/);
  });

  it("points a model at the field the bank asked for, not a bare 'bank'", () => {
    expect(invoiceShape.bank.description).toMatch(/iban/);
    expect(invoiceShape.bank.description).toMatch(/sort_code/);
    expect(invoiceShape.bank.description).toMatch(/bank_account_category/);
  });

  it("accepts a JSON number for amount, and still sends a decimal string", () => {
    const parsed = parse({ amount: 480 });
    expect(parsed.success).toBe(true);
    const sent = toRequest({ ...invoice, ...(parsed.success ? parsed.data : {}), currency: "eur", payee_country: "es", bank_country: "es" } as Invoice);
    expect(sent.amount).toBe("480");
    expect(sent.currency).toBe("EUR");
    expect(sent.payee.address.country_code).toBe("ES");
    expect(sent.payee.bank_country_code).toBe("ES");
  });

  it("rejects an amount with too many decimals and a country that is not a code", () => {
    expect(parse({ amount: "480.123" }).success).toBe(false);
    expect(parse({ currency: "euros" }).success).toBe(false);
    expect(parse({ payee_country: "Germany" }).success).toBe(false);
    expect(parse({ bank: {} }).success).toBe(false);
    expect(parse({ reference: "x".repeat(36) }).success).toBe(false);
  });

  it("rejects a spend cap that is not a number, so it cannot turn into a NaN limit", () => {
    const cap = z.object({ max_usdz: usdzLimit("The most this agent will pay, in USDZ") });
    expect(cap.safeParse({ max_usdz: "250.00" }).success).toBe(true);
    expect(cap.safeParse({ max_usdz: 250 }).success).toBe(true);
    expect(cap.safeParse({ max_usdz: "lots" }).success).toBe(false);
    expect(cap.safeParse({ max_usdz: -1 }).success).toBe(false);
  });
});
