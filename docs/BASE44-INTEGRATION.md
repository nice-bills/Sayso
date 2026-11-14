# Base44 integration: write-up for the accelerator application

## What we built
Sayso is a payouts layer that any Base44 app can call. A Base44 app's backend asks Sayso to pay someone. Sayso applies the app's plain-English rules and its own risk checks, and the account owner approves each payout with a passkey. Base44 never holds payment credentials, and the app's key cannot approve a payout.

Flagship app: **Freelance Hub**, a marketplace where buyers post jobs and release payment on delivery. Its payouts go through Sayso.

## Why it is a deep integration
- **Base44 server functions** call Sayso and receive its signed events. The app uses Base44's current TanStack Start layout, so the calls live in server functions in `src/lib/hub.js` and the events arrive at a server route, `src/routes/api/sayso-webhook.js`. Secrets are read with `secrets.get`.
- **The webhook route** checks the `Sayso-Signature` HMAC and timestamp, and applies an event only if its `sequence` is higher than the last one applied.
- **Base44 entities** hold the job, freelancer and payout state: `Freelancer`, `Job` and `SaysoPayout`. `SaysoPayout` updates live from Sayso's events, and the page polls every 4 seconds. Row-level security keeps `Freelancer` bank details readable by admins and the server only, and a buyer reads only their own jobs and payouts.
- **Base44 auth** decides who may request or release a payout. Each server function needs a signed-in Base44 user. `listFreelancers`, `myJobs`, `postJob`, `markDelivered` and `releasePayment` cover the job flow, `addFreelancer` is admins only, and only the buyer who posted a job can release it, and only when it is `delivered`.
- **The job keeps its proof.** When a payout is paid (or refunded), Freelance Hub looks up the receipt once, saves the explorer link on its `SaysoPayout` row (`metal_url`), and shows a "Receipt on Metal" link on the job. The buyer can check the payout on chain without trusting the app or Sayso.
- **Every state explains itself.** Sayso declares eight state machines as tables and serves them at `GET /v1/machines`. Each payout reply to an app also carries `state_means`, `waiting_on` and `final`, so the app can show what a state means and stop polling when the payout is final.
- **Base44 custom OpenAPI integration** is the second route: any app in a workspace can import Sayso's spec and call it with `base44.integrations.custom.call`.

## What Sayso adds to Base44
Base44 has no payout feature in its SDK, and it has no per-app payment rules. Sayso adds:
- payouts in the payee's own currency through Airwallex, with the payee's bank checked first;
- rules written in plain English and enforced as code, shown back as what will be enforced;
- a passkey approval by the owner for every payout, and a hold on changed bank details;
- signed, ordered, idempotent events, so a retried or late event never moves a payout backwards.

## Status, stated plainly
- Sayso side: built, tested (45 test files, 304 tests passing), and deployed at https://sayso-mp5d.onrender.com on the Airwallex sandbox and Metal testnet.
- Base44 side: live. Freelance Hub is published at https://freelance-hub-6ea1cb4e.base44.app and connected in Sayso as "Freelance Hub" with the rules "No more than 2000 EUR per payout. Only pay EUR and GBP." Sayso reports them as enforced: "Refuse any payout above 2000.00 EUR" and "Pay only in EUR, GBP".
- Checked end to end: a 12.00 EUR payout request sent with the app's key returned 201 `awaiting_approval` with an approval URL. Sayso delivered the signed `payout.awaiting_approval` event to the Base44 webhook (1 event, 1 delivered, 0 gave up), and the `SaysoPayout` row appeared in Base44 with `last_sequence` 1. A USD request was refused with 422 by the app's rules. An unsigned or badly signed POST to the webhook returns 401.
- Checked end to end, by a person: a signed-in person used Freelance Hub to post a job, confirm delivery and release payment. Sayso showed the payout in the owner's inbox. The owner approved it with a passkey on their phone. Airwallex sandbox transfer `fda1f9b7-8c89-417f-b63a-9ed7ed31db7b` paid 20.00 EUR, and Freelance Hub turned the job to "Paid" by itself from Sayso's signed webhook.
- Checked end to end, the receipt: payout `0bd3394c-06d7-42fa-90d2-cae2048a9a01` has a receipt whose hash `0x69de5a298f6a22cdb0e453fe0c634d3b5fb6a450eb958f4689c33da970839970` is anchored on Metal testnet in transaction [0x33a638c3…adc0](https://testnet.metalntwx.com/tx/0x33a638c371b2c7788be9f2a34326612e142eed5b8111b333214a1dd57007adc0). Anyone can read it at `GET /v1/payouts/<id>/receipt` with no key. So every payout a Base44 app asks for ends with a proof on Metal.
- Built and deployed, not yet seen in a browser: Freelance Hub stores the `payout_id` from Sayso's webhook, looks the receipt up once when the payout is paid or refunded, saves the explorer link on `SaysoPayout.metal_url`, and shows a "Receipt on Metal" link on the job.
- Checked end to end, a refusal: a job posted in USD was refused by the app's rules with "refused by this app's rules: USD isn't an allowed currency (EUR, GBP)". The buyer sees that message in Freelance Hub.
- The live app's server code is in this repo: `integrations/base44/freelance-hub/src/lib/hub.js` and `integrations/base44/freelance-hub/src/routes/api/sayso-webhook.js` are copies of what runs in Base44. The rest of the app, its UI components and auth pages, lives in Base44. The older Deno-function files under `integrations/base44/functions/` and `integrations/base44/marketplace/functions/` are an earlier version and were never run on a live app.

## What is not done
- It is sandbox and testnet only. No real money has moved.
- Freelancers in Freelance Hub have no login. The buyer confirms delivery and releases the payment.

## Links
- Sayso: https://sayso-mp5d.onrender.com
- Freelance Hub: https://freelance-hub-6ea1cb4e.base44.app
- Setup: `docs/BASE44.md`
- Live app's server code: `integrations/base44/freelance-hub/`
- Flagship app: `integrations/base44/marketplace/`
- OpenAPI spec: `/v1/platform/openapi.json` on a running Sayso
