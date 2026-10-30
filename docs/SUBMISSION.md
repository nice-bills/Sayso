# Sayso: submission write-up

**Tagline:** Any AI agent can pay any real-world invoice. Any business can too, with one tap.

**Prizes entered:** Judges' Choice, Founder's Choice, Metal (Metal + Airwallex).

## What it does

Sayso is a payout rail between agent money and the real economy.

- **For agents.** An agent holding USDZ on Metal asks Sayso, over MCP or plain HTTP, to pay "€180 to this IBAN". Sayso quotes for free, the agent pays the quote over **x402 on Metal**, and Sayso delivers the money in local currency through **Airwallex**. If the bank bounces it, the agent gets every cent back.
- **For businesses.** Forward an invoice email. Sayso reads it, checks the payee with Airwallex, and asks one question: "Pay €280 to Kreuzberg Studio?" One tap pays it. An invoice that changes bank details or pushes urgency is held until a person confirms the details with the payee directly.

- **For marketplaces.** One agent call pays up to 100 sellers or contractors with a single x402 payment. Each line is checked on its own, and a bounced line is refunded on its own.
- **From anywhere.** Any agent connects by URL with its own key: Claude Code (plugin included), claude.ai, ChatGPT, Cursor, OpenClaw, or the assistant someone texts from iMessage. Text it a photo of an invoice and get back "Pay €280 to Kreuzberg Studio? [tap]". Agents can propose payments but never approve them. Invoices can also be emailed to an AgentMail address.

## How the agent decides

Every payout goes through one pure function, `decide()` (`src/payouts/decide.ts`), which reads three inputs and the due date and returns a verdict, the input that decided it, and one sentence of reason. The rules run in order and the first match wins:

| Input changes | Verdict | What moves |
| --- | --- | --- |
| Risk: new bank details, pressure, a payee's bank that disagrees | **Hold** | A 0.01 transfer with a code to the new account on Airwallex; the agent's USDZ stays in escrow on Metal |
| Price: the rate is over 1.5% worse than the week's median, or the cost is above the agent's cap, and the bill isn't due for 2+ days | **Wait** | The agent pays now over x402 into escrow; Airwallex pays once the rate is back in band or a day before the due date |
| Price over the cap and due within 2 days | **Hold**, with the cap it needs | The owner approves with `metal-agent mandate replace` |
| Balance: the agent's budget (or Sayso's float, for the inbox) covers part of it and the payee takes part payments | **Split** | The covered part is paid now; the rest after the next earnings sweep |
| Balance short otherwise | **Wait** for funds | An earnings sweep under the ramp-only mandate, then the transfer |
| Everything clear | **Pay** | x402 on Metal, then the Airwallex transfer |

The app shows the verdict, the three inputs and the reason on every payout, and on the sandbox a "What if" row changes one input to show the flip (labelled: nothing moves). The model never sets a number; it can only add risk findings.

## Prove it: when an agent's purchase is questioned

Sayso is the seller here, so it has to show what it sold and who allowed it. `GET /v1/payouts/:id/proof` (and the `prove_payout` MCP tool) lists six pieces of evidence, each marked proven, missing or against: the order the agent placed (and whether its key signed that exact order), the owner's Metal mandate and its limits, the owner's approval if the payout was held, the agent's payment on Metal, the Airwallex transfer, and the receipt anchored on chain. No bank details are included.

A dispute (`POST /v1/payouts/:id/disputes`, or `dispute_payout`) names what went wrong: not authorized, wrong amount, not delivered, wrong account, or something else. `judge()` (`src/payouts/proof.ts`) settles it from the evidence, in code:

| The proof | Verdict | What moves |
| --- | --- | --- |
| Answers the claim (for example a verified mandate against "not authorized") | **Denied** | The proof's hash is anchored on Metal, so the answer can't be rewritten |
| Contradicts the payout (no mandate on record, or the transfer came back) | **Upheld** | The agent's USDZ is refunded on Metal by `mandate pull --payment-id` |
| Can't settle it | **Review** | The owner refunds it with their passkey, or keeps it |

In the seeded app, the Rechenzentrum Nord payout was made under an owner's mandate with a signed order, so "Wasn't allowed" is denied. The Lingua Freelance payout came from a bare key, so the same claim is upheld and refunded.

## Why it matters

Agents can now earn and hold money, but they can't pay a freelancer in Lyon or a print shop in London. Businesses lose real money to invoice fraud ("our bank details have changed"). Sayso answers both with the same idea: **a prompt is not a financial control.** The model reads emails. Code and on-chain mandates decide what moves.

## How the money is kept safe

| Rule | Where it's enforced |
| --- | --- |
| Fiat moves only after the agent's payment settles on chain | x402 settle hook. A failed settlement releases the quote. |
| No payout is ever sent twice | The payout id is Airwallex's `request_id`; every state change is compare-and-set. |
| The payee is real before anyone pays | Airwallex beneficiary validation and account verification at quote time. The payee's bank says whose account it is; a name mismatch waits for a person. |
| Caps, velocity, blocked countries, large first payments | Risk rules in code, not in the prompt. |
| "New bank details" invoices wait until the payee proves the account | Sayso sends 0.01 with a code to the new account and asks for it at the address on file from an earlier paid invoice. The right code, or a person's phone check, lifts the hold; "these aren't our details" blocks it. |
| An agent spends only what its owner allowed | A Metal mandate the owner binds: Sayso as the only payee, a cap, a budget, an expiry. The agent signs Sayso's exact offer, and Sayso verifies each payment on chain. `required` mode refuses anything else before it settles. |
| An agent's USDZ waits in escrow until its payout is delivered | Only delivered payouts are released to the ramp; money behind a payout on its way stays for a refund. |
| Anyone can check a payout happened | A receipt for each final payout, its hash anchored on Metal, verifiable without Sayso. |
| You see what Sayso heard | Say a payment: the words heard and what was understood, side by side, with each field's source. Whisper runs in the browser, so the voice never leaves the device. Bank details never come from speech. |
| A bounced payout is refunded in full | A Metal refund mandate, capped per refund and in total. |
| Earnings can only leave to Airwallex | A Metal sweep mandate whose only payee is the ramp. Anything else is refused on chain, and the refusal is recorded. |
| The books close | Reconciliation: Metal swept = ramp credited = Airwallex deposits, and every currency balance explained, to the cent. |

## How we built it

- **Airwallex:** FX rates and conversions (only the shortfall is converted), beneficiary validation, account verification with bank name matching (VoP/CoP) and creation, transfers with `request_id` idempotency and a purpose code, signed webhooks for transfer status (including bank returns after `PAID`), balances, and deposit simulation for the off-ramp.
- **Metal (the builder guide's Kit 11, from the payer's side):** signed orders required on the x402 route, an owner's mandate per agent, refusals that come back with a reason, limits raised by `mandate replace`, disputes settled from the proof (denied answers anchored on chain, upheld ones refunded by `mandate pull --payment-id`), earnings moved to Airwallex with the Metal hash as the deposit reference, and a timed-out payment looked up before anything is retried. x402 payments with `@metalntwx/metal-pay` 0.3.4 and `metal-agent` 0.3.3 on Metal testnet (USDZ), and two mandates through the official `metal-agent` CLI: a ramp-only sweep mandate and a capped refund mandate. On-chain refusals are recorded for the heist. Agents can pay under their owner's mandate (Verifiable Intent): Sayso asks for the agent's signed order with `requireSignedOffer`, runs `verifyMandatePayment`'s four steps on every such payment, and reads the remaining budget with `readMandateState`. Sweeps release only delivered payouts (escrow), and each final payout's receipt hash is anchored on chain through the MIP20 gas envelope (`@metalntwx/metal-ts`).
- **Claude:** reads invoice emails into structured fields with a strict schema (Claude Opus 5.5 with structured outputs). A pattern extractor takes over with no key; neither one decides money.
- **MCP, two ways.** A local server for agents with their own Metal wallet (`pay_invoice`, `pay_batch`, `pay_quote`, `quote_payout`, `payout_status`, `batch_status`). A hosted endpoint for any agent, with per-agent keys and caps (`forward_invoice`, `list_invoices`, `quote_payout`, `payout_status`). Approving is deliberately not a tool.
- **Everywhere else:** a Claude Code plugin with a skill that teaches the approval flow, a skill for OpenClaw-style agents, AgentMail email intake (Svix-signed webhooks), and ntfy phone notifications that open the approval page.
- **App:** built for people whose agents do the work, and kept quiet. Home leads with what needs your say and a plain timeline of what the agents are doing, each step with its proof. Then an inbox, payments with live progress, an agents page, and a bottom tab bar on phones. Owner sign-in, strict CSP, invoice text always rendered as text.
- **Its own card and its own treasury.** Sayso pays its compute bills with its own card, built on the Airwallex Issuing API (merchant-category and amount limits on the card; an unknown merchant freezes it). In the demo the card is simulated, because the sandbox account can't issue cards. It also runs its own bills through a treasury policy that decides hold, convert or pay, and an email that lowers the earnings forecast tightens what it may do without a person.
- **Quality:** TypeScript, SQLite, 142 unit and integration tests, 10 browser end-to-end tests, and a full offline mode with simulators that follow the same rules as the real services.

## Proven live

`npm run demo` runs end to end against the Airwallex sandbox and Metal testnet: x402 payments from three buyer agents, a batch payout, real Airwallex transfers, a bounce through Airwallex's transfer simulation refunded on chain, earnings swept under the ramp-only mandate and credited exactly once, the heist refused on chain (`mandate_payee_not_listed`), and the books reconciled to the cent (48 checks). Last run: 29 Oct 2026, on `metal-agent` 0.3.3 and `metal-pay` 0.3.4.

The live run found what offline tests couldn't: Airwallex quotes FX in market convention (EURUSD even when you sell USD, so rates had to be inverted or every EUR quote was 23% cheap), returns a new beneficiary as `id`, charges a fee on every LOCAL transfer and keeps it on a bounce, needs `address.state` for Spanish and US payees, and only fails a transfer from `SENT`. All of it is handled and tested.

## What's simulated, honestly

- There is no sandbox bridge from Metal to Airwallex. The off-ramp is a Metal mandate sweep followed by Airwallex's deposit simulation, behind one interface. Every simulated proof starts with `sim:` in offline mode.
- Bounces in the live sandbox use Airwallex's transfer simulation.
- The Airwallex sandbox answers `NOT_MATCHED` to every payee name, so the bank name check is off on the sandbox (account existence is still checked). The "the bank says this account belongs to Mark Lehmann" moment comes from the offline simulator.
- The agent card is simulated. Our sandbox account refuses to issue cards ("Invalid issuance details"), so the card's authorizations come from Sayso's simulator, which applies the same category and amount rules. The Airwallex Issuing code is written and unit tested, and it would run against a real card given `AWX_CARD_ID`.
- On live Metal the faucet grants each buyer agent 100 USDZ once, so the live demo pays a tenth of each invoice.

## Tracks

| Track | How Sayso covers it |
| --- | --- |
| 1 Adaptive Treasury | A policy plans hold / convert / pay across currencies and bills; an email that contradicts the forecast tightens autonomous limits and the plan changes. Converts only the shortfall, sweeps earnings, reconciles to the cent. Backtest over 44 months of ECB rates and 200 earnings paths: no missed bills and no reserve breaches; FX cost equal to converting each bill on its due date (USD 43.89 vs 43.86 per run), so the gain is safety, not FX. |
| 2 Intent-Bound Purchase | Agents pay only at or below `max_usdz`; Metal won't sign above the agent's cap. The agent's own card (simulated in the demo) is bound to compute merchants by category and amount. |
| 3 Payment Ops Incident | Bounced payouts are refunded automatically, even when the bank returns one after `PAID`; ambiguous transfers are looked up before any retry. |
| 8 Marketplace Settlement | Batch payouts: many sellers, one x402 payment, per-line refunds. |
| 9 Approval-Bound | Agents propose; the owner approves each payment from a link bound to its amount and payee. |
| 10 Agentic Checkout | Sayso's own checkout is x402: the 402 response is the price, and the agent pays it. |

## Challenges

- x402's Express middleware settles only after the handler answers. So the handler only locks the quote, and fiat moves in the after-settle hook.
- Refunds can't come from the ramp-only mandate by design, so refunds needed their own capped mandate.
- Metal's packages and `@x402/*` move together: metal-pay 0.3.4 needs `@x402/*` 2.28 or later, and mandates bound before metal-agent 0.3.3 could revert on testnet.

## What's next

- Real inbound email addresses per business, and approvals by push notification.
- A Visa card path for merchants that only take cards, building on the agent card.
- An FX policy that earns its keep: hold euros earned in euros (the natural hedge) once Sayso has non-USD income, which the backtest shows is where a policy beats converting on the due date.

## Links

- Repo: https://github.com/nice-bills/Sayso
- Video: (add after recording)
