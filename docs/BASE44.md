# Sayso for Base44 apps: payouts from your app

Base44 apps can take money in. Sayso is how they send it out: pay a freelancer, a supplier or a seller in their own currency, with the app's rules and Sayso's risk checks in front of every payout.

Sayso's rules still have the final say. An app can only ask:

- **Per-app rules, in plain English.** `No more than €500 per payout. Only pay EUR and GBP. Max €5,000 a month. Never pay to RU.` Sayso turns each sentence into a limit and shows back exactly what the code will enforce. A sentence it can't enforce is refused, never dropped. Rules only ever refuse; they can't loosen Sayso's own risk rules.
- **Sayso's own checks still run:** the payee is verified with their bank, bank-detail changes are held, an account the owner hasn't paid before waits for their passkey, and nothing is paid until the owner approves. The app's key cannot approve a payout, and it doesn't open the agent MCP either.
- **Safe to retry.** `ref` is your id for the payout. The same ref and body returns the existing payout; the same ref with different bank details is refused.
- **Live status in your app.** Every state change is POSTed to your webhook, HMAC-signed with a timestamp, retried with backoff, numbered by `sequence` so a late event never moves a payout backwards. Bank details never go back out.

## Connect an app (the owner)

```
curl -X POST $SAYSO_URL/v1/platform/apps -H "Authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Freelance Hub","webhook_url":"https://YOUR-APP.base44.app/functions/sayso-webhook","rules":"No more than 500 EUR per payout. Only pay EUR and GBP."}'
```

You get `api_key` and `webhook_secret` once. Change rules any time: `PUT /v1/platform/apps/:id/rules {"rules":"..."}`. Disconnect: `POST /v1/platform/apps/:id/revoke`.

## Use it from Base44

1. **As a backend function (the full flow).** Copy `integrations/base44/` into your app's `base44/` folder (`entities/SaysoPayout.json`, `functions/sayso-pay`, `functions/sayso-webhook`), set the secrets `SAYSO_URL`, `SAYSO_APP_KEY`, `SAYSO_WEBHOOK_SECRET`, and deploy with `npx base44 deploy`. Call `base44.functions.invoke("sayso-pay", {...})`; show `SaysoPayout` rows with `entities.SaysoPayout.subscribe`.
2. **As a workspace custom integration.** Import `$SAYSO_URL/v1/platform/openapi.json` as a custom OpenAPI integration (Base44 requires a Builder plan), then call `base44.integrations.custom.call("sayso", "post:/v1/platform/payouts", { payload })` from any app in the workspace.

Backend functions need a Base44 Builder plan. These two function files follow Base44's documented function format but haven't been run against a live Base44 app yet.

## States an app sees

`awaiting_approval` and `needs_verification` (waiting for the owner; `approval_url` is where), `paying`, `paid`, `failed`, `refunded` (a bounced payout is refunded, even after `paid`), `rejected`, `needs_details`, `duplicate`, `ignored`.
