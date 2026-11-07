# Freelance Hub on Base44, paying through Sayso

A flagship marketplace: buyers post jobs, freelancers deliver, and the buyer releases payment. Every payout goes through Sayso, so the app's rules (set in Sayso, in plain English) and the owner's passkey approval stand between a release and the money.

## Files
- `entities/Job.json`, `entities/Freelancer.json`: the data. Add `SaysoPayout` from `../entities/SaysoPayout.json`.
- `functions/release-payment`: the buyer releases a delivered job. Only the buyer can call it, and the job must be `delivered`.
- `../functions/sayso-pay`, `../functions/sayso-webhook`: shared with the payouts layer (see `docs/BASE44.md` in the Sayso repo).

## Setup
1. Connect the app in Sayso (owner): `POST /v1/platform/apps` with rules such as `No more than 2000 EUR per payout. Only pay EUR and GBP.`
2. In the Base44 app, set secrets `SAYSO_URL`, `SAYSO_APP_KEY`, `SAYSO_WEBHOOK_SECRET`.
3. Deploy with `npx base44 deploy`.
4. Point the Sayso webhook at `https://<your-app>.base44.app/functions/sayso-webhook`.

## Caveats
- Written against Base44's documented function format. Not yet run on a live Base44 app.
- Each release needs the owner's passkey tap in Sayso. That's deliberate.
- Bank details live on the `Freelancer` entity. Restrict its read access to admins in Base44 before real use.
