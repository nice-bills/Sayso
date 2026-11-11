// The OpenAPI spec a builder imports to give an app (a Base44 app, or any backend) the ability to pay people.
// In Base44 it becomes a workspace custom integration, called as base44.integrations.custom.call("sayso", "post:/v1/platform/payouts", { payload }).

import { APP_PAYOUT } from "./platform.js";

const state = { type: "string", enum: Object.keys(APP_PAYOUT.states) };

export function openApiSpec(server: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "Sayso Payouts",
      version: "1.0.0",
      description: "Pay people from your app. Sayso checks the payee with their bank, applies your app's rules and its own risk rules, and delivers the money in the payee's currency. The owner approves each payout with a passkey; the app can never approve its own.",
    },
    servers: [{ url: server }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "The app key the owner made in Sayso" } },
      schemas: {
        PayoutRequest: {
          type: "object", required: ["ref", "payee_name", "amount", "currency", "bank"],
          properties: {
            ref: { type: "string", description: "Your id for this payout. Sending the same ref and body again is a safe retry; the same ref with a different body is refused." },
            payee_name: { type: "string" },
            amount: { type: "string", description: "Major units, e.g. \"480.00\"" },
            currency: { type: "string", description: "ISO code, e.g. EUR" },
            reference: { type: "string", maxLength: 35 },
            due_date: { type: "string", format: "date" },
            bank: { type: "object", properties: { country: { type: "string" }, iban: { type: "string" }, account_number: { type: "string" }, sort_code: { type: "string" }, routing_number: { type: "string" } } },
            address: { type: "object", properties: { country: { type: "string" }, city: { type: "string" }, street: { type: "string" }, postcode: { type: "string" } } },
            context: { type: "string", description: "Why you are paying (an invoice, a milestone, a message). Sayso reads it for pressure and bank-detail changes; it can only make Sayso more careful." },
          },
        },
        Payout: {
          type: "object",
          properties: {
            ref: { type: "string" }, state, state_means: { type: "string", nullable: true }, waiting_on: { type: "string", nullable: true }, final: { type: "boolean" }, payout_id: { type: "string", nullable: true }, payee: { type: "string" }, amount: { type: "string" }, currency: { type: "string" },
            reasons: { type: "array", items: { type: "string" } }, missing: { type: "array", items: { type: "string" } }, failure: { type: "string", nullable: true },
            approval_url: { type: "string", nullable: true, description: "Where the owner approves. Show it as 'waiting for approval'." }, transfer_id: { type: "string", nullable: true },
          },
        },
      },
    },
    paths: {
      "/v1/platform/payouts": {
        post: {
          operationId: "createPayout", summary: "Ask Sayso to pay someone",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutRequest" } } } },
          responses: { 201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Payout" } } } }, 200: { description: "Same ref and body: the existing payout" }, 409: { description: "ref reused with a different body" }, 422: { description: "Refused by the app's rules" } },
        },
        get: { operationId: "listPayouts", summary: "This app's recent payouts", responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Payout" } } } } } } },
      },
      "/v1/platform/payouts/{ref}": {
        get: { operationId: "getPayout", summary: "Where a payout is", parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Payout" } } } }, 404: { description: "No such payout" } } },
      },
      "/v1/platform/rules": {
        get: { operationId: "getRules", summary: "The plain-English rules Sayso enforces for this app", responses: { 200: { description: "OK" } } },
      },
    },
    "x-webhooks": {
      "payout.<state>": {
        description: "POSTed to the app's webhook_url on every state change, signed `Sayso-Signature: t=<unix>,v1=<hmac_sha256(webhook_secret, t + '.' + rawBody)>`. Body: { id, type, created, app_id, sequence, data: Payout }. Retried with backoff until a 2xx. Dedupe on id; ignore events whose sequence is lower than one already applied for that ref.",
      },
    },
  };
}
