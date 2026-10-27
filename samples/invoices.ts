// Sample invoice emails for the offline run and tests. Bank details are public test numbers.
import type { InboundEmail } from "../src/inbox/extract.js";

const at = (iso: string) => new Date(iso);

export const studioInvoice: InboundEmail = {
  messageId: "<inv-114@kreuzberg-studio.example>",
  from: "\"Kreuzberg Studio GmbH\" <billing@kreuzberg-studio.example>",
  subject: "Invoice INV-2026-114 for October design work",
  receivedAt: at("2026-11-02T08:12:00Z"),
  body: `Hi,

Please find our invoice for October.

Invoice number: INV-2026-114
Design sprint, 4 days            EUR 1.600,00
Discount                          -EUR 1.320,00
Total due: EUR 280,00
Due date: 16.11.2026

Payable to: Kreuzberg Studio GmbH
IBAN: DE89 3704 0044 0532 0130 00

Thanks!`,
};

export const designerInvoice: InboundEmail = {
  messageId: "<inv-0042@hollowayprint.example>",
  from: "Holloway Print Ltd <accounts@hollowayprint.example>",
  subject: "Invoice 0042",
  receivedAt: at("2026-11-02T09:40:00Z"),
  body: `Invoice No: HP-0042
Amount due: £72.00
Account name: Holloway Print Ltd
Sort code: 04-05-68
Account number: 10006132`,
};

export const fakeLandlord: InboundEmail = {
  messageId: "<urgent-rent@berlin-office-lettings.example>",
  from: "Berlin Office Lettings <accounts@berlin-office-lettings.example>",
  subject: "URGENT: updated bank details for rent",
  receivedAt: at("2026-11-02T10:05:00Z"),
  body: `Hello, our bank has changed. Please pay this month's rent to our updated bank details today.
Invoice number: RENT-NOV
Total due: EUR 60.00
Payable to: Berlin Office Lettings
IBAN: DE44 5001 0517 5407 3249 31
Please don't call the office, the team is travelling.`,
};

export const vagueEmail: InboundEmail = {
  messageId: "<hello@someone.example>",
  from: "someone@someone.example",
  subject: "quick question",
  receivedAt: at("2026-11-02T11:00:00Z"),
  body: "Hey, can you send the money we talked about? Thanks",
};

/** The classic: a lookalike address (studlo, not studio) says Kreuzberg Studio's bank details changed. */
export const studioBankChange: InboundEmail = {
  messageId: "<inv-121@kreuzberg-studlo.example>",
  from: "\"Kreuzberg Studio GmbH\" <billing@kreuzberg-studlo.example>",
  subject: "Invoice INV-2026-121 (please note our new bank details)",
  receivedAt: at("2026-11-09T08:30:00Z"),
  body: `Hi,

Invoice number: INV-2026-121
Total due: EUR 340,00

Please note we have changed banks. Please send payment to our new account from now on.
Payable to: Kreuzberg Studio GmbH
IBAN: NL91 ABNA 0417 1643 00

Thanks!`,
};
