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
  -d '{"name":"Freelance Hub","webhook_url":"https://YOUR-APP.base44.app/api/sayso-webhook","rules":"No more than 500 EUR per payout. Only pay EUR and GBP."}'
```

You get `api_key` and `webhook_secret` once. Change rules any time: `PUT /v1/platform/apps/:id/rules {"rules":"..."}`. Disconnect: `POST /v1/platform/apps/:id/revoke`.

## Use it from Base44

1. **As server functions in your app (the full flow, and the one running live).** This is Base44's current TanStack Start layout: server functions in `src/lib/hub.js` plus a webhook server route at `src/routes/api/sayso-webhook.js`, with the secrets `SAYSO_URL`, `SAYSO_APP_KEY` and `SAYSO_WEBHOOK_SECRET` read with `secrets.get`. Point the app's `webhook_url` at `https://YOUR-APP.base44.app/api/sayso-webhook`. This is what Freelance Hub runs at https://freelance-hub-6ea1cb4e.base44.app.
2. **As a Deno backend function (the full flow, not run live yet).** Copy `integrations/base44/` into your app's `base44/` folder (`entities/SaysoPayout.json`, `functions/sayso-pay`, `functions/sayso-webhook`), set the same three secrets, and deploy with `npx base44 deploy`. Call `base44.functions.invoke("sayso-pay", {...})`; show `SaysoPayout` rows with `entities.SaysoPayout.subscribe`.
3. **As a workspace custom integration.** Import `$SAYSO_URL/v1/platform/openapi.json` as a custom OpenAPI integration (Base44 requires a Builder plan), then call `base44.integrations.custom.call("sayso", "post:/v1/platform/payouts", { payload })` from any app in the workspace.

Backend functions need a Base44 Builder plan. The Deno function files in `integrations/base44/` follow Base44's documented function format but have not been run against a live Base44 app. The TanStack Start route is the one running live, in Freelance Hub.

## States an app sees

`awaiting_approval` and `needs_verification` (waiting for the owner; `approval_url` is where), `paying`, `paid`, `failed`, `refunded`, `rejected`, `needs_details`, `duplicate`, `ignored`.

A payout an app asks for is paid from the owner's Airwallex balance. If the bank bounces it, it ends as `failed`, also after `paid`, and the money is still in the owner's balance. It never becomes `refunded`: that state is reserved and is not sent to apps today.

The receipt for a paid payout is at `GET /v1/payouts/{payout_id}/receipt`, with no key.

Every state, what it means, who it is waiting on and whether it is final is listed at GET /v1/machines. Each payout reply carries the same three answers for its own state, so stop polling when "final" is true.
