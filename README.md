# Sayso

**Any AI agent can pay any real-world invoice.** An agent holding USDZ on **Metal** asks Sayso to pay "€480 to this IBAN", pays the quoted price over x402, and Sayso delivers the money in local currency through **Airwallex**. Businesses get the same thing without writing code: forward an invoice to Sayso's inbox, tap once, and it's paid.

The rails decide what is allowed, not the prompt:
- **Fiat moves only after the agent's payment settles on Metal.** An unsettled or failed payment releases the quote, and nothing is paid.
- **Every quote is single-use.** Each payout id doubles as Airwallex's `request_id`, so nothing is paid twice.
- **Airwallex validates the payee before anyone pays, and asks the payee's bank whose account it is** (Verification of Payee in SEPA, Confirmation of Payee in the UK). A name mismatch waits for a person; a closed account is refused.
- **The risk rules are code.** They cover blocked countries, caps, velocity and large first payouts. An invoice that asks to pay new bank details is held until a person confirms with the payee.
- **A bounced payout is refunded in full**, even when the bank returns it after Airwallex said `PAID`, under a Metal **refund mandate**. Metal caps each refund and the lifetime total.
- **Earnings reach the Airwallex float only through a Metal sweep mandate whose only payee is the ramp.** A compromised agent trying to drain them is refused on chain.
- **An agent can spend only what its owner allowed, on chain.** The owner binds a Metal mandate whose only payee is Sayso, with a cap per payment, a total budget and an expiry. The agent pays from the owner's account and signs Sayso's exact offer. Sayso checks every such payment with Metal's four verification steps and keeps the proof. With `SAYSO_AGENT_MANDATES=required`, any other payment is refused before it settles.
- **An agent's USDZ stays in escrow until its payout is delivered.** Only delivered payouts are released to the ramp. Money behind a payout still on its way is never swept, so a bounce can always be refunded.
- **Every final payout gets a receipt anchored on Metal.** Anyone can hash the receipt and compare it with the anchor transaction, without trusting Sayso.
- **A changed bank account has to prove itself.** Sayso sends 0.01 with a 6-digit code to the new account and asks the payee for it at the address on file from an earlier paid invoice, not the address that sent the new one.
- **You see what Sayso heard.** Say a payment and the app shows the exact words heard next to what Sayso understood, with where each field came from. Whisper can transcribe on the device itself (the default where the browser has no speech recognition, like Firefox), so the voice is never sent anywhere. A name speech-to-text misspells ("Cruzeburg") is matched by sound to a payee already paid, and both spellings are shown. Bank details never come from speech.
- **Price, balance and risk decide what the agent does, in code.** Every quote comes back as pay, wait, split or hold, with the input that decided it and one sentence of reason (`src/payouts/decide.ts`). A rate more than 1.5% worse than the week's median waits, with the agent's USDZ in escrow, until it comes back or a day before the due date. A budget that covers part of an invoice that allows part payment splits it. A risk finding holds it. Each verdict ends in a real transaction: the x402 payment, the Airwallex transfer, the one-cent check, or the refund.
- **Reconciliation is arithmetic, to the cent.**

Built for the Airwallex Agentic Banking Hackathon (2026). Demo script: [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md). Write-up: [docs/SUBMISSION.md](docs/SUBMISSION.md).

![The inbox](docs/app-inbox.png)

## Try it now (no keys, no network)

```
npm install
npm run demo:offline     # agents pay over MCP, a batch payout, the inbox, a refund, the heist, reconciliation
npm run serve:offline    # or open the app on :4021 and sign in with sayso-demo
npm run test:e2e         # the app's flows in a real browser (needs Node 22.22.3+ or 24; `npx -y node@24` works)
```

Offline mode swaps Airwallex and Metal for simulators. They follow the rules our code depends on: `request_id` dedupe, a required transfer `reason`, `FAILED` as the failure state, and the mandate's payee checks. Every proof they produce starts with `sim:`.

## Use it from an agent (MCP)

Any agent can connect: Claude Code (also as a plugin), claude.ai, ChatGPT, Cursor, OpenClaw, or the assistant you text from iMessage. See [docs/CONNECT.md](docs/CONNECT.md). Agents forward invoices; only the owner approves, from a one-tap link.

For an agent with its own Metal wallet, run the local server:

```
claude mcp add sayso -e SAYSO_URL=http://127.0.0.1:4021 -e SAYSO_BUYER_KEY=0x... -- npx tsx src/mcp/server.ts
```

| Tool | What it does |
| --- | --- |
| `quote_payout` | Prices a payout, for free. |
| `pay_invoice` | Quotes, then pays only if the price is at most `max_usdz`. |
| `pay_batch` | Pays many people with one USDZ payment, if the batch costs at most `max_usdz`. |
| `pay_quote` | Pays an existing quote by id. |
| `payout_status` | Reports where a payout is. |
| `payout_receipt` | A final payout's receipt and the Metal transaction anchoring its hash. |
| `prove_payout` | Everything Sayso can prove about a payout, piece by piece. |
| `dispute_payout` | Dispute a delivered payout; the rules settle it from the proof. |

Metal itself refuses to sign above `SAYSO_MAX_USDZ`.

**Better: pay under the owner's budget.** The agent's owner (not Sayso, not the agent) binds a mandate on Metal, and the agent then pays from the owner's account:

```
SAYSO_PAY_TO=<pay_to from GET /healthz> npm run setup:agent-budget -- --cap 250 --budget 1000 --days 30
claude mcp add sayso -e SAYSO_URL=... -e SAYSO_MANDATE=.metal/agent-budget.json -- npx tsx src/mcp/server.ts
```

Metal refuses any payment above the cap, past the budget, after the expiry, or to anyone but Sayso. The owner can revoke it at any time with `metal-agent mandate revoke`.

## API

| Call | Price | What it does |
| --- | --- | --- |
| `POST /v1/quotes` | free | Price, payee check, risk. Returns a quote, `needs_review` or `rejected`, with reasons. |
| `POST /v1/payouts/:id/pay` | x402: the quote total | Locks the quote. The payout runs once the payment settles. |
| `GET /v1/payouts/:id` | free | Status, Airwallex transfer id, refund tx. Never returns bank details. |
| `GET /v1/payouts/:id/receipt` | free | The final payout's receipt, its hash, and the Metal anchor transaction. |
| `POST /v1/batches` | free | Up to 100 payouts quoted under one price. Lines it won't pay are set aside with reasons. |
| `POST /v1/batches/:id/pay` | x402: the batch total | One payment funds every line. A line that bounces is refunded on its own. |
| `POST /mcp` | agent key | The hosted MCP endpoint: `forward_invoice`, `list_invoices`, `quote_payout`, `payout_status`. |
| `POST /v1/agent/invoices` | agent key | The same forwarding as REST, for skill-based agents. |
| `POST /webhooks/agentmail` | Svix signature | Invoices emailed to your AgentMail address. |
| `POST /v1/inbox` | owner, or `x-inbox-secret` | Forward an invoice email (`from`, `subject`, `body`). |
| `POST /v1/inbox/:id/approve` | owner | The one tap. `verified_with_payee: true` is needed for held invoices. |
| `POST /v1/inbox/:id/details` | owner | Fill in what the extractor couldn't find; the invoice is checked again. |
| `GET /v1/payouts`, `POST /v1/payouts/:id/review` | owner | Every payout; allow or block a held agent payout. |
| `GET /v1/payouts/:id/proof` | free | What Sayso can prove about a payout: the order, the owner's mandate, the approval, the Metal payment, the transfer, the receipt. No bank details. |
| `POST /v1/payouts/:id/disputes` | payer only | `{ claim, note, issued_at, signature }`: a dispute settled from the proof. Only the owner (signed in) or the agent that paid can file one: the paying key signs `Sayso dispute\npayout: <id>\nclaim: <claim>\nissued_at: <iso>` (EIP-191, checked on chain, so smart accounts work too). Denied answers are anchored on Metal. Upheld ones are refunded, and only where Sayso's own record is at fault; a claim against a delivered payment goes to the owner. |
| `POST /v1/payouts/:id/dispute` | owner | Refund an agent's payout yourself (passkey): the agent is refunded in full under the refund mandate. |
| `POST /v1/payouts/:id/dispute/deny` | owner | Keep a payout whose dispute the proof couldn't settle. |
| `POST /v1/payouts/:id/what-if` | owner, sandbox only | Re-run the decision with one input changed (rate, budget, risk). Moves nothing. |
| `GET /v1/payouts/:id/why` | owner | Every step behind a payout, with its proof: what was said or read, the rules, the bank, the mandate, Airwallex, the receipt. |
| `POST /v1/say` | owner | `{ transcript }`: what you said becomes an invoice to approve, with what was heard, what was understood and where each field came from. |
| `POST /v1/inbox/:id/penny` | owner | Starts the one-cent code check on an invoice held for new bank details. The payee answers at `/v/:token`. |

"Owner" means the app's session cookie or `Authorization: Bearer <OWNER_TOKEN>`. The owner signs in with a passkey (Face ID, Touch ID, a fingerprint), an emailed one-time link to `OWNER_EMAIL`, Google (with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`), or the owner token. Once a passkey exists, every approval needs a fresh passkey check bound to that payment, so a stolen session or an agent driving the browser can't pay. With `SAYSO_VIEWER=on` (the Render blueprint sets it, and offline it is always on), "Look around, read-only" on the sign-in card opens every view the owner has, live data included, and every write answers 403: judges see the real sandbox without the owner's passkey.

Agents sign themselves up through [auth.md](https://github.com/workos/auth.md): Sayso serves `/auth.md`, the RFC 9728 metadata and `service_auth` registration. The agent shows the owner a six-digit code, the owner enters it at `/claim` and confirms with their passkey, and the agent gets an hour-long access token plus a 30-day assertion to renew it. Owner-made keys from the Agents tab still work too. Agents never get the owner's sign-in.

## The app

`/` is the app. Home is your balance, one card for whatever needs you, and an orb you hold to say a payment: the words appear as they're heard (Whisper on the device, or the browser's speech recognition; you can also type), and the card shows how Sayso read them. Behind one icon: an inbox of forwarded invoices with one-tap pay, the one-cent code check (or a phone call) for invoices that change bank details, a "Why?" view on every payment, escrow on the Agents tab, a form for missing details, every payment with its progress, and how to connect an agent. `/ops/` is the live back office feed. Both sit behind the owner's sign-in, and the page renders invoice text as text under a strict CSP.

## Live run (sandbox keys and Metal testnet)

```
cp .env.example .env            # AWX_CLIENT_ID, AWX_API_KEY, METAL_RPC_URL
npm run smoke:airwallex         # read-only check of the Airwallex keys
npm run setup:metal             # keys, owner account, sweep and refund mandates bound on chain, faucet funds
npm run setup:airwallex         # USD global account and opening float
# paste the printed lines into .env, then:
npm run demo                    # or: npm run serve
```

Network access needed: `api.sandbox.airwallex.com`, `*.metalntwx.com`, and optionally `api.frankfurter.dev` for the FX history.

Until Metal is set up (no `METAL_PRINCIPAL` in `.env`, or `npm run demo -- --sim-metal`), the demo runs on the live Airwallex sandbox with Metal simulated: real FX rates, beneficiaries, transfers, a real sandbox bounce and deposits, with Metal proofs marked `sim:`. `METAL_RPC_URL` must be an endpoint from console-testnet.metalntwx.com (chain 63825), not Metal L2. A variable set in the shell or the cloud environment beats `.env` (Node's `--env-file` never overrides), so fix it there.

With Metal live, the faucet grants each buyer key 100 USDZ once (`npm run setup:buyers` makes and funds three fresh buyer keys before a run), so the demo pays a tenth of each invoice and keeps a 20 USDZ refund reserve (`SAYSO_REFUND_RESERVE_USDZ`, default 200) so earnings still sweep. `setup:metal` funds the owner before binding, since binding a mandate pays gas in USDZ.

What the live sandbox taught us, now handled in code: FX rates come back in market convention (`EURUSD 1.14` for selling USD), so they are inverted; a new beneficiary's id is `id`; LOCAL transfers carry a payer fee (EUR 2.68, GBP 2.26) that is priced in and recorded from the transfer itself, and kept by Airwallex on a bounce; Spanish and US payees need `address.state`, US ACH needs `bank_account_category`; a transfer can only be failed from `SENT`; the sandbox answers `NOT_MATCHED` to every payee name, so the name check is off there (`AWX_NAME_CHECK=on` forces it).

## Host it (public URL)

Claude.ai, ChatGPT, approval links on a phone and Airwallex webhooks need Sayso on a public HTTPS address. It's one long-running Node service, so it fits Render, Fly or Railway (not serverless).

- **Render:** New > Blueprint > this repo. `render.yaml` builds the Dockerfile and asks for the secrets: your Airwallex keys and `AWX_GLOBAL_ACCOUNT_ID`, the Metal lines from `.env`, `METAL_BUNDLE` (the output of `npm run bundle:metal`, your `.metal` keys as one value), an `OWNER_TOKEN` you choose, and `PUBLIC_URL` (the `https://...onrender.com` address it gives you).
- **Anywhere with Docker:** `docker build -t sayso . && docker run -p 4021:4021 --env-file .env -e METAL_BUNDLE="$(npm run -s bundle:metal)" sayso`.
- Without Airwallex and Metal settings the container starts offline, which is handy for a first check. `GET /healthz` answers when it's up.

## Layout

| Path | What it does |
| --- | --- |
| `src/payouts/` | The product: pricing, risk, the payout book (compare-and-set states), the service, and the x402 API. |
| `src/inbox/` | Invoice extraction (Claude, or patterns with no key), the one-tap inbox, saying a payment, the one-cent code check, and IMAP polling. |
| `src/mcp/server.ts` | The MCP tools agents install. |
| `src/metal/` | Mandates through the official `metal-agent` CLI (sweep, refunds, on-chain refusals), agents' owner mandates verified on chain, escrow release, receipts anchored on chain, finality checks, and on-chain earnings. |
| `src/trail.ts` | Each payout's reasons, step by step (the "why" view). |
| `src/bridge/` | The off-ramp ledger: one Airwallex credit per finalized Metal event. |
| `src/airwallex/` | Typed REST client, signed and deduped webhooks, and the agent card. |
| `src/reconcile.ts` | Metal swept == ramp credited == Airwallex deposits, and every currency's balance explained. |
| `src/web/` | The app (no build step). `tests/app.e2e.ts` drives it in a browser. |
| `src/auth.ts`, `src/agents/` | The owner's sign-in, and agent keys. |
| `src/mcp/hosted.ts` | The hosted MCP endpoint and its REST twin. |
| `src/mcp/view.html` | The cards chat apps draw inline (an MCP App): swipe, tap to open, swipe to approve in Sayso. |
| `plugins/sayso/`, `integrations/` | The Claude Code plugin and the skill for OpenClaw-style agents. |
| `src/app.ts`, `src/serve.ts`, `src/demo.ts` | The service in one process, and the demo that drives it through MCP and the inbox. |
| `src/treasury/`, `src/agent/` | The treasury policy, bound approvals, the email reader and the executor. |
| `src/sim/offline.ts` | The offline simulators. |

## Notes

- Metal packages: `@metalntwx/metal-agent` 0.3.3 and `@metalntwx/metal-pay` 0.3.4, with `@x402/*` pinned to 2.28.0 (metal-pay 0.3.4 needs 2.28 or later). Mandates bound before metal-agent 0.3.3 could revert on testnet, so `.metal` accounts and mandates made with 0.2.x should be recreated (`npm run setup:metal`).
- Payload fields marked `VERIFY` follow the Airwallex docs as we understand them. They get checked against the docs MCP on the first live run.
- The x402 payment path (dynamic price per quote, settle hooks) has run end to end against Metal's facilitator on testnet (live demo run, 18 Oct 2026). Offline, the same routes run with simulated payments.
- Not yet run live on testnet: agents paying under an owner's mandate (`setup:agent-budget`, `SAYSO_MANDATE`, the on-chain verification and `SAYSO_AGENT_MANDATES=required`), and receipt anchors (`METAL_RECEIPT_KEY`, which `setup:metal` now creates and funds). Both use Metal's own SDK calls and are covered offline by the simulators and tests. Without `METAL_RECEIPT_KEY`, receipts are kept and anchored by the simulator (`sim:`).
- The one-cent check proves that whoever reads the payee's mail on file also sees the new account's statement. That stops lookalike senders, the common case. It does not stop a payee whose own mailbox is compromised. For that, call them.
