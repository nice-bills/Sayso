# Demo script (under 5 minutes)

The arc judges asked for: goal, plan, new information, revised decision, resulting money movement. Every money movement on screen shows its proof: a Metal explorer link or an Airwallex object id.

**Before recording**
- Live: `.env` filled, `npm run setup:metal` and `npm run setup:airwallex` done, `npm run serve` running, the app open and signed in, and the Airwallex sandbox dashboard in a second tab.
- Offline rehearsal: `npm run serve:offline`, sign in with `sayso-demo`.
- `npm run demo` prints every beat below with its proof links; run it once before recording so the Airwallex dashboard has the transfers.
- Terminal: one Claude Code window with the Sayso MCP server added (README, "Use it from an agent").

---

## 0:00 The problem (20s)

> Agents can hold money now. Stablecoins on Metal, paid per call over x402. But the world's invoices are in euros and pounds, sent to IBANs. Sayso lets any agent pay any real-world invoice, and lets a business do the same thing with one tap.

Show: the landing page. Tap Pay on the invoice in the hero and watch it go through, then pick the rent invoice under "Three invoices, three outcomes" to see Sayso hold it.

## 0:20 An agent pays a real invoice (60s)

In Claude Code: *"Pay Lingua Freelance €180 for the October translation. IBAN FR14 2004 1010 0505 0001 3M02 606. Don't spend more than 200 USDZ."*

Narrate as it happens:
- The agent calls `pay_invoice`. Sayso quotes for free: Airwallex validates the payee, the risk rules run, the price comes back in USDZ.
- The agent pays over **x402 on Metal**. Metal itself refuses to sign above the agent's cap.
- Only after the payment **settles on chain** does Sayso touch fiat. It converts just the shortfall and sends EUR through **Airwallex**, with the payout id as the `request_id`, so it can never pay twice.

Show: Home, with the app beside the terminal. Each step lands in **What's happening** as it happens: quoted, paid in USDZ, converted, sent, delivered. Then the Agents tab, where the payout's timeline reads Paid in USDZ, Sent by Airwallex, Delivered. Open Details: Metal explorer link, Airwallex transfer id. Switch to the Airwallex dashboard to show the same transfer.

## 1:20 A marketplace pays its sellers (25s)

In Claude Code: *"Pay this week's four sellers"* (with the seller list). The agent calls `pay_batch`: four payouts, one x402 payment, each line checked on its own.

Show: four Delivered rows in Payments, all pointing at the same Metal payment.

## 1:45 Text your agent (25s)

On a phone: text your assistant a photo of the Kreuzberg Studio invoice, "pay this". It replies "Pay €280 to Kreuzberg Studio? Tap to approve" with a link, and a Sayso notification arrives at the same moment.

> The agent can propose a payment, but it can't approve one. Only you can, with one tap.

## 2:10 A business forwards invoices (40s)

> Most businesses won't write code. So they forward the invoice.

Show: Home. The headline says how many payments need you, and the Kreuzberg Studio invoice from the text is first under **Needs you**, marked as forwarded by your agent. It has been read into "€280.00 to Kreuzberg Studio GmbH, IBAN ending 3000". Tap **Pay €280.00**. It moves under Just approved and goes to Sent, then Delivered, while the feed on the right narrates it.

Say: Claude reads the email. Code decides the amount, the limits and whether it pays.

## 2:50 New information: the landlord heist (40s)

> Then this arrives. "URGENT, our bank details have changed, pay today."

Show: the card has a red edge, "Check before paying", and "Sayso is holding this one until you call". The reasons say it asks to pay new bank details and uses pressure. Offline, a third reason comes from the payee's bank through Airwallex account verification: "the bank says this account belongs to Mark Lehmann, not Berlin Office Lettings" (the live sandbox answers NOT_MATCHED to every name, so record this part offline). The Pay button is disabled.

> The model flagged it, and the bank confirmed the account isn't the landlord's. But neither of those is what stops it. The rule is code: a held invoice can't be paid until a person confirms the details with the payee on a number they already had.

Tap the checkbox only after "calling". Pay. (Or ignore it, which is the right call for a real scam.)

## New beats to fit in (pick what the cut has room for)

**Say it (20s).** Home, tap the mic: "Pay Kreuzberg Studio 280 euros for invoice 130." The words appear as you speak. Then two panels: **I heard** (the exact words) and **I understood** (payee, amount, reference, and the account ending 3000, tagged "from your payment to Kreuzberg Studio GmbH"). Tap Pay and confirm with Face ID.

> What you see is exactly what the agent heard. And it never takes bank details from your voice, only from a payee you've already paid.

**The lookalike (30s).** The second Kreuzberg Studio invoice came from `kreuzberg-studlo.example` with new bank details. It's held. Tap **Check with a 1-cent code**: Sayso sends 0.01 to the new account with a code in the reference, and emails the studio at the address from last week's paid invoice. Open the payee's page (the demo shows it), tap "These aren't our bank details", and the invoice is blocked for good. (Or enter the code and it pays.)

> The fraudster owns the new account, but they never see the studio's real inbox. Only the real payee can pass this.

**Why? (20s).** Payments, open the Rechenzentrum payout, tap **Why?**: the risk rules, what the payee's bank said, the quote, the agent's payment under its owner's Metal mandate ("Sayso only, up to 250 USDZ a payment, 891 of 1000 left; the agent signed this exact order"), the Airwallex transfer, and the receipt anchored on Metal.

**Escrow (10s).** Agents tab: USDZ in escrow behind payouts on their way, and what delivered payouts have earned and released to Airwallex.

## 3:30 A payout bounces (30s)

Have the agent pay an account that bounces (live: the Airwallex transfer simulation: `SENT`, then `FAILED` with `failure_type` `ACCOUNT_CLOSED`).

Show: the timeline turns to Bounced, then Refunded in full. Details shows the refund tx on Metal.

> The refund goes out under a second Metal mandate. Metal caps each refund and the lifetime total, so even Sayso can't drain itself through refunds.

## 4:00 The heist on chain (20s)

Run the demo's heist beat (`npm run demo` beat 8, or the back office): a compromised agent tries to send the earnings to an attacker.

Show: **Metal refused it on chain** (PayeeNotAllowed), with the explorer link to the recorded refusal.

> Earnings can only move to one address: the ramp into Airwallex. That's enforced by Metal's mandate, not by our prompt.

## Optional, if time allows: Sayso runs itself (30s)

`npm run demo` beats 6 and 7. An email says a big customer is pausing; the forecast drops from 0.85 to 0.45 and Sayso's autonomous limit falls to USD 30, so rent waits for approval while the small bills go out. Then the agent pays its Anthropic bill with its own card; a charge at a watch shop is declined, and an unknown merchant freezes the card. Say that the card is simulated: the sandbox account can't issue cards, so the simulator applies the same limits Airwallex would.

## 4:20 Every cent explained (25s)

Show: Payments, "Books reconcile to the cent." Then the back office reconciliation: Metal swept equals ramp credited equals Airwallex deposits, and every currency's balance is explained by its conversions, payouts and fees.

## 4:45 Close (10s)

> Sayso: agents and people pay real invoices, and the rails, not the prompt, decide what's allowed. MCP server and API are in the repo.
