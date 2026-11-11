# Freelance Hub on Base44, paying through Sayso

A flagship marketplace: buyers post jobs, freelancers deliver, and the buyer releases payment. Every payout goes through Sayso, so the app's rules (set in Sayso, in plain English) and the owner's passkey approval stand between a release and the money.

Live app: https://freelance-hub-6ea1cb4e.base44.app. It uses Base44's current TanStack Start layout, described in `docs/BASE44.md`: server functions in `src/lib/hub.js` and a webhook server route at `src/routes/api/sayso-webhook.js`. The files in this folder are the older Deno-function version, kept for that format.

## Files
- `entities/Job.json`, `entities/Freelancer.json`: the data. Add `SaysoPayout` from `../entities/SaysoPayout.json`.
- `functions/release-payment`: the buyer releases a delivered job. Only the buyer can call it, and the job must be `delivered`.
- `../functions/sayso-pay`, `../functions/sayso-webhook`: shared with the payouts layer (see `docs/BASE44.md` in the Sayso repo).

## Setup
1. Connect the app in Sayso (owner): `POST /v1/platform/apps` with rules such as `No more than 2000 EUR per payout. Only pay EUR and GBP.`
2. In the Base44 app, set secrets `SAYSO_URL`, `SAYSO_APP_KEY`, `SAYSO_WEBHOOK_SECRET`.
3. Deploy with `npx base44 deploy`.
4. Point the Sayso webhook at `https://<your-app>.base44.app/api/sayso-webhook` for the TanStack Start layout, or `https://<your-app>.base44.app/functions/sayso-webhook` for the Deno function format.

## Caveats
- The files in this folder are the older Deno function format. They have not been run on a live Base44 app. The live app uses the TanStack Start layout.
- Each release needs the owner's passkey tap in Sayso. That's deliberate.
- Bank details live on the `Freelancer` entity. Restrict its read access to admins in Base44 before real use.
