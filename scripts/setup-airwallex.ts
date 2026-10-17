// One-time sandbox setup: a USD global account for the ramp, an opening balance, and the four
// demo beneficiaries. Prints the env lines to paste into .env.
// Beneficiary payloads use sandbox test bank details and are validated before they are created;
// if validation fails, the error names the field to fix (check it with the docs MCP).

import { Airwallex } from "../src/airwallex/client.js";

const awx = Airwallex.fromEnv();
const env: string[] = [];

let ga = (await awx.globalAccounts()).items.find((a) => a.currency === "USD");
if (!ga) ga = { ...(await awx.createGlobalAccount("US", "USD")), currency: "USD" };
env.push(`AWX_GLOBAL_ACCOUNT_ID=${ga.id}`);

await awx.simulateDeposit(ga.id, 400, "Coin Slot opening balance");
console.log("deposited USD 400.00 opening balance (sandbox simulation)");

const address = (country: string, city: string, postcode: string) => ({ country_code: country, city, postcode, street_address: "1 Demo Street" });
const company = (name: string, addr: ReturnType<typeof address>, bank: Record<string, string>) => ({
  entity_type: "COMPANY", company_name: name, address: addr, bank_details: { account_name: name, ...bank },
});

const beneficiaries: Array<[string, string, Record<string, unknown>]> = [
  ["AWX_BEN_LANDLORD", "Berlin office lettings", company("Berlin Office Lettings GmbH", address("DE", "Berlin", "10115"), { account_currency: "EUR", bank_country_code: "DE", iban: "DE89370400440532013000" })],
  ["AWX_BEN_CONTRACTOR", "EU contractor", company("Contractor Studio BV", address("NL", "Amsterdam", "1011"), { account_currency: "EUR", bank_country_code: "NL", iban: "NL91ABNA0417164300" })],
  // VERIFY: GBP LOCAL routing field names (sort code) with the docs MCP.
  ["AWX_BEN_DESIGNER", "UK designer", company("Design Ltd", address("GB", "London", "EC1A 1BB"), { account_currency: "GBP", bank_country_code: "GB", account_number: "31926819", account_routing_type1: "sort_code", account_routing_value1: "601613" })],
  // VERIFY: USD LOCAL (ACH) routing field names with the docs MCP.
  ["AWX_BEN_VENDOR", "Data licence vendor", company("Data Vendor Inc", address("US", "San Francisco", "94105"), { account_currency: "USD", bank_country_code: "US", account_number: "123456789", account_routing_type1: "aba", account_routing_value1: "021000021" })],
];

for (const [key, nickname, beneficiary] of beneficiaries) {
  try {
    await awx.validateBeneficiary(beneficiary, ["LOCAL"]);
    const { beneficiary_id } = await awx.createBeneficiary({ beneficiary, transfer_methods: ["LOCAL"], nickname });
    env.push(`${key}=${beneficiary_id}`);
  } catch (err) {
    console.error(`${nickname}: ${String(err)}`);
  }
}

console.log("\nPaste into .env:\n" + env.join("\n"));
