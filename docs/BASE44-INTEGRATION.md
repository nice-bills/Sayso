# Base44 integration: write-up for the accelerator application

## What we built
Sayso is a payouts layer that any Base44 app can call. A Base44 app's backend asks Sayso to pay someone. Sayso applies the app's plain-English rules and its own risk checks, and the account owner approves each payout with a passkey. Base44 never holds payment credentials, and the app's key cannot approve a payout.

Flagship app: **Freelance Hub**, a marketplace where buyers post jobs and release payment on delivery. Its payouts go through Sayso.

## Why it is a deep integration
- **Base44 server functions** call Sayso and receive its signed events. The app uses Base44's current TanStack Start layout, so the calls live in server functions in `src/lib/hub.js` and the events arrive at a server route, `src/routes/api/sayso-webhook.js`. Secrets are read with `secrets.get`.
- **The webhook route** checks the `Sayso-Signature` HMAC and timestamp, and applies an event only if its `sequence` is higher than the last one applied.
- **Base44 entities** hold the job, freelancer and payout state: `Freelancer`, `Job` and `SaysoPayout`. `SaysoPayout` updates live from Sayso's events, and the page polls every 4 seconds. Row-level security keeps `Freelancer` bank details readable by admins and the server only, and a buyer reads only their own jobs and payouts.
- **Base44 auth** decides who may request or release a payout. Each server function needs a signed-in Base44 user. `listFreelancers`, `myJobs`, `postJob`, `markDelivered` and `releasePayment` cover the job flow, `addFreelancer` is admins only, and only the buyer who posted a job can release it, and only when it is `delivered`.
- **Base44 custom OpenAPI integration** is the second route: any app in a workspace can import Sayso's spec and call it with `base44.integrations.custom.call`.

## What Sayso adds to Base44
Base44 has no payout feature in its SDK, and it has no per-app payment rules. Sayso adds:
- payouts in the payee's own currency through Airwallex, with the payee's bank checked first;
- rules written in plain English and enforced as code, shown back as what will be enforced;
- a passkey approval by the owner for every payout, and a hold on changed bank details;
- signed, ordered, idempotent events, so a retried or late event never moves a payout backwards.

## Status, stated plainly
- Sayso side: built, unit tested (182 tests passing), and deployed at https://sayso-mp5d.onrender.com on the Airwallex sandbox and Metal testnet.
- Base44 side: live. Freelance Hub is published at https://freelance-hub-6ea1cb4e.base44.app and connected in Sayso as "Freelance Hub" with the rules "No more than 2000 EUR per payout. Only pay EUR and GBP." Sayso reports them as enforced: "Refuse any payout above 2000.00 EUR" and "Pay only in EUR, GBP".
- Checked end to end: a 12.00 EUR payout request sent with the app's key returned 201 `awaiting_approval` with an approval URL. Sayso delivered the signed `payout.awaiting_approval` event to the Base44 webhook (1 event, 1 delivered, 0 gave up), and the `SaysoPayout` row appeared in Base44 with `last_sequence` 1. A USD request was refused with 422 by the app's rules. An unsigned or badly signed POST to the webhook returns 401.
- Not yet checked: the browser flow in Freelance Hub by a signed-in person (post a job, confirm delivery, release payment), and a payout carried through owner approval to `paid`.
- The files under `integrations/base44/functions/` and `integrations/base44/marketplace/functions/` are the older Deno-function versions. They have not been run on a live app. The live app's source lives in the Base44 app and is not yet copied into this repo.

## Links
- Sayso: https://sayso-mp5d.onrender.com
- Freelance Hub: https://freelance-hub-6ea1cb4e.base44.app
- Setup: `docs/BASE44.md`
- Flagship app: `integrations/base44/marketplace/`
- OpenAPI spec: `/v1/platform/openapi.json` on a running Sayso
