# Freelance Hub's server code

Freelance Hub is the Base44 app running live at https://freelance-hub-6ea1cb4e.base44.app. These two files are copies of its server code, kept here so the integration can be read. The rest of the app, its UI components and auth pages, lives in Base44.

- `src/lib/hub.js`: the server functions the app calls. `listFreelancers`, `addFreelancer`, `myJobs`, `postJob`, `markDelivered` and `releasePayment`.
- `src/routes/api/sayso-webhook.js`: the route Sayso posts its signed payout events to. It checks the HMAC and the timestamp, and applies an event only if its `sequence` is higher than the last one applied.

The files read three Base44 secrets, by name only: `SAYSO_URL`, `SAYSO_APP_KEY` and `SAYSO_WEBHOOK_SECRET`. Never put a value in a file.

The app's Base44 project has three entities: `Freelancer` (name and bank details), `Job` (buyer, freelancer, amount, currency, status) and `SaysoPayout` (Sayso's state, approval link, receipt link).

## The flow

1. A signed-in buyer posts a job for a freelancer. The `Job` row starts as `in_progress`.
2. The buyer confirms delivery, because freelancers have no login here. The job moves to `delivered`.
3. The buyer releases payment. `releasePayment` asks Sayso for a payout, with the job's own `ref` so a double click cannot pay twice.
4. Sayso applies the app's plain-English rules and puts the payout in the owner's inbox. The owner approves with a passkey. Airwallex pays the freelancer.
5. Sayso sends a signed webhook. `SaysoPayout` takes the new state and the job turns "Paid". The app looks the receipt up once and the job shows "Receipt on Metal", the anchor on Metal testnet.
