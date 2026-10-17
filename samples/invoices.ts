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
Sort code: 60-16-13
Account number: 31926819`,
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
IBAN: DE02 1001 0010 0930 7118 03
Please don't call the office, the team is travelling.`,
};

export const vagueEmail: InboundEmail = {
  messageId: "<hello@someone.example>",
  from: "someone@someone.example",
  subject: "quick question",
  receivedAt: at("2026-11-02T11:00:00Z"),
  body: "Hey, can you send the money we talked about? Thanks",
};
