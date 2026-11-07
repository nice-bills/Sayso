# Base44 integration: write-up for the accelerator application

## What we built
Sayso is a payouts layer that any Base44 app can call. A Base44 app's backend asks Sayso to pay someone. Sayso applies the app's plain-English rules and its own risk checks, and the account owner approves each payout with a passkey. Base44 never holds payment credentials, and the app's key cannot approve a payout.

Flagship app: **Freelance Hub**, a marketplace where buyers post jobs and release payment on delivery. Its payouts go through Sayso.

## Why it is a deep integration
- **Base44 backend functions** call Sayso (`sayso-pay`, `release-payment`) and receive its signed events (`sayso-webhook`).
- **Base44 entities** hold the job, freelancer and payout state. `SaysoPayout` updates live from Sayso's events.
- **Base44 auth** decides who may request or release a payout. Only the buyer can release, and only admins can request.
- **Base44 custom OpenAPI integration** is the second route: any app in a workspace can import Sayso's spec and call it with `base44.integrations.custom.call`.

## What Sayso adds to Base44
Base44 has no payout feature in its SDK, and it has no per-app payment rules. Sayso adds:
- payouts in the payee's own currency through Airwallex, with the payee's bank checked first;
- rules written in plain English and enforced as code, shown back as what will be enforced;
- a passkey approval by the owner for every payout, and a hold on changed bank details;
- signed, ordered, idempotent events, so a retried or late event never moves a payout backwards.

## Status, stated plainly
- Sayso side: built, unit tested (170 tests passing) and e2e tested for the platform API.
- Base44 side: written to Base44's documented format, not yet run on a live Base44 app.
- Not yet done: a public deployment of Sayso that Base44 can reach, and a recorded demo.

## Links
- Setup: `docs/BASE44.md`
- Flagship app: `integrations/base44/marketplace/`
- OpenAPI spec: `/v1/platform/openapi.json` on a running Sayso
