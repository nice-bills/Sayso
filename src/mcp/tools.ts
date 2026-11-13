// The invoice shape both MCP servers (local stdio and hosted) take, flattened so any model fills it easily.
//
// The descriptions are the agent's only instructions for a field: say whether it is required, what
// currency it is in, and what Airwallex expects. Amounts stay decimal strings because money must not
// lose precision; a JSON number is accepted too, because models often send one.
import { z } from "zod";

const amountPattern = /^\d+(\.\d{1,2})?$/;

/** A decimal money amount: a string keeps precision, a number is what a model often emits anyway. */
const money = (what: string) =>
  z.union([
    z.string().regex(amountPattern, "major units with at most 2 decimals, e.g. \"480.00\""),
    z.number().finite().nonnegative(),
  ]).describe(what);

const country = (what: string) =>
  z.string().regex(/^[A-Za-z]{2}$/, "a two-letter ISO country code, e.g. DE").describe(what);

const requiredText = (what: string, max?: number) => {
  const s = z.string().trim().min(1, "required");
  return (max ? s.max(max) : s).describe(what);
};

export const invoiceShape = {
  amount: money("Required. What the payee is owed, in the invoice's own currency (not USDZ): major units such as \"480.00\". A JSON number is also accepted."),
  currency: z.string().regex(/^[A-Za-z]{3}$/, "a three-letter ISO 4217 currency code, e.g. EUR").describe("Required. Currency of the invoice and the payout, e.g. EUR, GBP or USD. This is the payee's currency, never USDZ."),
  method: z.enum(["LOCAL", "SWIFT"]).optional().describe("Optional. LOCAL (default, cheaper and usual) or SWIFT for a cross-border transfer."),
  payee_name: requiredText("Required. The payee's legal name, as it appears on their bank account (max 140 characters).", 140),
  payee_type: z.enum(["COMPANY", "PERSONAL"]).optional().describe("Optional. COMPANY (default) or PERSONAL: whether the payee is a business or an individual."),
  payee_country: country("Required. Two-letter country code of the payee's address, e.g. DE."),
  payee_city: requiredText("Required. City of the payee's address."),
  payee_street: requiredText("Required. Street address of the payee, including the number, e.g. \"Hafenstr. 2\"."),
  payee_postcode: requiredText("Required. Postal code of the payee's address, as the payee writes it."),
  payee_state: z.string().trim().min(1).max(50).optional().describe("Required for US and Canadian payees: two-letter state or province code, e.g. CA or ON. Leave it out for other countries."),
  bank_country: country("Required. Two-letter country code of the payee's bank, e.g. DE."),
  bank: z.record(z.string(), z.string()).refine((b) => Object.keys(b).length > 0, "bank details are required").describe(
    "Required. The payee's bank account as Airwallex bank_details fields: {\"iban\": \"DE89...\"} in Europe, or {\"account_number\": \"...\", \"account_routing_type1\": \"sort_code\", \"account_routing_value1\": \"...\"} in the UK. US ACH also needs bank_account_category (Checking or Savings).",
  ),
  reference: z.string().trim().min(1, "required").max(35).describe("Required. What the payee sees on their bank statement: at most 35 characters."),
  invoice_text: z.string().max(20_000).optional().describe("Optional. The invoice or email that asked for this payment. Sayso reads it and holds anything suspicious; it can only make Sayso more careful."),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional().describe("Optional. When the invoice is due, as YYYY-MM-DD. Sayso may wait for a better rate until a day before it."),
  part_payment: z.boolean().optional().describe("Optional. Set true only if the payee accepts part payments; a short budget can then pay part now and the rest later."),
};

/** A cap in USDZ (the agent's money), not in the payee's currency. */
export const usdzLimit = (what: string) =>
  z.union([
    z.string().regex(amountPattern, "a USDZ amount with at most 2 decimals, e.g. \"250.00\""),
    z.number().finite().nonnegative(),
  ]).describe(`${what}, e.g. "250.00".`);

export type Invoice = { [K in keyof typeof invoiceShape]: z.infer<(typeof invoiceShape)[K]> };

export const toRequest = (i: Invoice) => ({
  amount: String(i.amount), currency: i.currency.toUpperCase(), method: i.method, reference: i.reference, invoice_text: i.invoice_text,
  due_date: i.due_date, part_payment: i.part_payment,
  payee: { name: i.payee_name, entity_type: i.payee_type, bank: i.bank, bank_country_code: i.bank_country.toUpperCase(), address: { country_code: i.payee_country.toUpperCase(), city: i.payee_city, street_address: i.payee_street, postcode: i.payee_postcode, ...(i.payee_state ? { state: i.payee_state } : {}) } },
});
