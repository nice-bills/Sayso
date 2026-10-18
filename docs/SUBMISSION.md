# Coin Slot: submission write-up

**Tagline:** Any AI agent can pay any real-world invoice. Any business can too, with one tap.

**Prizes entered:** Judges' Choice, Founder's Choice, Metal (Metal + Airwallex).

## What it does

Coin Slot is a payout rail between agent money and the real economy.

- **For agents.** An agent holding USDZ on Metal asks Coin Slot, over MCP or plain HTTP, to pay "€180 to this IBAN". Coin Slot quotes for free, the agent pays the quote over **x402 on Metal**, and Coin Slot delivers the money in local currency through **Airwallex**. If the bank bounces it, the agent gets every cent back.
- **For businesses.** Forward an invoice email. Coin Slot reads it, checks the payee with Airwallex, and asks one question: "Pay €280 to Kreuzberg Studio?" One tap pays it. An invoice that changes bank details or pushes urgency is held until a person confirms the details with the payee directly.

- **For marketplaces.** One agent call pays up to 100 sellers or contractors with a single x402 payment. Each line is checked on its own, and a bounced line is refunded on its own.
- **From anywhere.** Any agent connects by URL with its own key: Claude Code (plugin included), claude.ai, ChatGPT, Cursor, OpenClaw, or the assistant someone texts from iMessage. Text it a photo of an invoice and get back "Pay €280 to Kreuzberg Studio? [tap]". Agents can propose payments but never approve them. Invoices can also be emailed to an AgentMail address.

## Why it matters

Agents can now earn and hold money, but they can't pay a freelancer in Lyon or a print shop in London. Businesses lose real money to invoice fraud ("our bank details have changed"). Coin Slot answers both with the same idea: **a prompt is not a financial control.** The model reads emails. Code and on-chain mandates decide what moves.

## How the money is kept safe

| Rule | Where it's enforced |
| --- | --- |
| Fiat moves only after the agent's payment settles on chain | x402 settle hook. A failed settlement releases the quote. |
| No payout is ever sent twice | The payout id is Airwallex's `request_id`; every state change is compare-and-set. |
| The payee is real before anyone pays | Airwallex beneficiary validation at quote time. |
| Caps, velocity, blocked countries, large first payments | Risk rules in code, not in the prompt. |
| "New bank details" invoices wait for a human phone check | The inbox refuses to pay a held invoice without an explicit confirmation. |
| A bounced payout is refunded in full | A Metal refund mandate, capped per refund and in total. |
| Earnings can only leave to Airwallex | A Metal sweep mandate whose only payee is the ramp. Anything else is refused on chain, and the refusal is recorded. |
| The books close | Reconciliation: Metal swept = ramp credited = Airwallex deposits, and every currency balance explained, to the cent. |

## How we built it

- **Airwallex:** FX rates and conversions (only the shortfall is converted), beneficiary validation and creation, transfers with `request_id` idempotency, signed webhooks for transfer status, balances, and deposit simulation for the off-ramp.
- **Metal:** x402 payments with `@metalntwx/metal-pay` on Metal testnet (USDZ), and two mandates through the official `metal-agent` CLI: a ramp-only sweep mandate and a capped refund mandate. On-chain refusals are recorded for the heist.
- **Claude:** reads invoice emails into structured fields with a strict schema (Claude Opus 5.5 with structured outputs). A pattern extractor takes over with no key; neither one decides money.
- **MCP, two ways.** A local server for agents with their own Metal wallet (`pay_invoice`, `pay_batch`, `pay_quote`, `quote_payout`, `payout_status`, `batch_status`). A hosted endpoint for any agent, with per-agent keys and caps (`forward_invoice`, `list_invoices`, `quote_payout`, `payout_status`). Approving is deliberately not a tool.
- **Everywhere else:** a Claude Code plugin with a skill that teaches the approval flow, a skill for OpenClaw-style agents, AgentMail email intake (Svix-signed webhooks), and ntfy phone notifications that open the approval page.
- **App:** a phone-friendly inbox, payments with live progress, an agents page, and a back office feed. Owner sign-in, strict CSP, invoice text always rendered as text.
- **Quality:** TypeScript, SQLite, 68 unit and integration tests, 5 browser end-to-end tests, and a full offline mode with simulators that follow the same rules as the real services.

## What's simulated, honestly

- There is no sandbox bridge from Metal to Airwallex. The off-ramp is a Metal mandate sweep followed by Airwallex's deposit simulation, behind one interface. Every simulated proof starts with `sim:` in offline mode.
- Bounces in the live sandbox use Airwallex's transfer simulation.

## Tracks

| Track | How Coin Slot covers it |
| --- | --- |
| 1 Adaptive Treasury | Converts only the shortfall, sweeps earnings into the float, reconciles to the cent. |
| 2 Intent-Bound Purchase | Agents pay only at or below `max_usdz`; Metal won't sign above the agent's cap. |
| 3 Payment Ops Incident | Bounced payouts are refunded automatically; ambiguous transfers are looked up before any retry. |
| 8 Marketplace Settlement | Batch payouts: many sellers, one x402 payment, per-line refunds. |
| 9 Approval-Bound | Agents propose; the owner approves each payment from a link bound to its amount and payee. |
| 10 Agentic Checkout | Coin Slot's own checkout is x402: the 402 response is the price, and the agent pays it. |

## Challenges

- x402's Express middleware settles only after the handler answers. So the handler only locks the quote, and fiat moves in the after-settle hook.
- Refunds can't come from the ramp-only mandate by design, so refunds needed their own capped mandate.
- `@metalntwx/metal-pay` 0.2.0 needs `@x402/*` 2.21.0 exactly.

## What's next

- Real inbound email addresses per business, and approvals by push notification.
- A Visa card path for merchants that only take cards.

## Links

- Repo: (add after the repo is created)
- Video: (add after recording)
