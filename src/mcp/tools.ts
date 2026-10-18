// The invoice shape both MCP servers (local stdio and hosted) take, flattened so any model fills it easily.
import { z } from "zod";

export const invoiceShape = {
  amount: z.string().describe("Amount in major units, e.g. \"480.00\""),
  currency: z.string().describe("ISO currency of the payout, e.g. EUR, GBP, USD"),
  method: z.enum(["LOCAL", "SWIFT"]).optional().describe("LOCAL (default, free) or SWIFT"),
  payee_name: z.string(),
  payee_type: z.enum(["COMPANY", "PERSONAL"]).optional(),
  payee_country: z.string().describe("Two-letter country of the payee's address"),
  payee_city: z.string(),
  payee_street: z.string(),
  payee_postcode: z.string(),
  bank_country: z.string().describe("Two-letter country of the bank"),
  bank: z.record(z.string(), z.string()).describe("Bank details as Airwallex bank_details fields, e.g. {\"iban\": \"DE89...\"} or {\"account_number\": \"...\", \"account_routing_type1\": \"sort_code\", \"account_routing_value1\": \"...\"}"),
  reference: z.string().describe("Payment reference shown to the payee, max 35 characters"),
  invoice_text: z.string().optional().describe("The invoice or email text that asked for this payment. Coin Slot reads it and holds anything suspicious."),
};

export type Invoice = { [K in keyof typeof invoiceShape]: z.infer<(typeof invoiceShape)[K]> };

export const toRequest = (i: Invoice) => ({
  amount: i.amount, currency: i.currency.toUpperCase(), method: i.method, reference: i.reference, invoice_text: i.invoice_text,
  payee: { name: i.payee_name, entity_type: i.payee_type, bank: i.bank, bank_country_code: i.bank_country.toUpperCase(), address: { country_code: i.payee_country.toUpperCase(), city: i.payee_city, street_address: i.payee_street, postcode: i.payee_postcode } },
});

