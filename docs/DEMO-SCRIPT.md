# Demo script (under 5 minutes)

The arc judges asked for: goal, plan, new information, revised decision, resulting money movement. Every money movement on screen shows its proof: a Metal explorer link or an Airwallex object id.

**Before recording**
- Live: `.env` filled, `npm run setup:metal` and `npm run setup:airwallex` done, `npm run serve` running, the app open and signed in, and the Airwallex sandbox dashboard in a second tab.
- Offline rehearsal: `npm run serve:offline`, sign in with `sayso-demo`.
- Terminal: one Claude Code window with the Sayso MCP server added (README, "Use it from an agent").

---

## 0:00 The problem (20s)

> Agents can hold money now. Stablecoins on Metal, paid per call over x402. But the world's invoices are in euros and pounds, sent to IBANs. Sayso lets any agent pay any real-world invoice, and lets a business do the same thing with one tap.

Show: the landing page.

## 0:20 An agent pays a real invoice (60s)

In Claude Code: *"Pay Lingua Freelance €180 for the October translation. IBAN FR14 2004 1010 0505 0001 3M02 606. Don't spend more than 200 USDZ."*

Narrate as it happens:
- The agent calls `pay_invoice`. Sayso quotes for free: Airwallex validates the payee, the risk rules run, the price comes back in USDZ.
- The agent pays over **x402 on Metal**. Metal itself refuses to sign above the agent's cap.
- Only after the payment **settles on chain** does Sayso touch fiat. It converts just the shortfall and sends EUR through **Airwallex**, with the payout id as the `request_id`, so it can never pay twice.

Show: the Agents tab and the payout's timeline going Paid in USDZ, then Sent by Airwallex, then Delivered. Open Details: Metal explorer link, Airwallex transfer id. Switch to the Airwallex dashboard to show the same transfer.

## 1:20 A marketplace pays its sellers (25s)

In Claude Code: *"Pay this week's four sellers"* (with the seller list). The agent calls `pay_batch`: four payouts, one x402 payment, each line checked on its own.

Show: four Delivered rows in Payments, all pointing at the same Metal payment.

## 1:45 Text your agent (25s)

On a phone: text your assistant a photo of the Kreuzberg Studio invoice, "pay this". It replies "Pay €280 to Kreuzberg Studio? Tap to approve" with a link, and a Sayso notification arrives at the same moment.

> The agent can propose a payment, but it can't approve one. Only you can, with one tap.

## 2:10 A business forwards invoices (40s)

> Most businesses won't write code. So they forward the invoice.

Show: the Inbox, where the Kreuzberg Studio invoice from the text is waiting. It has been read into "€280.00 to Kreuzberg Studio GmbH, IBAN ending 3000". Tap **Pay €280.00**. It moves to Sent, then Delivered.

Say: Claude reads the email. Code decides the amount, the limits and whether it pays.

## 2:50 New information: the landlord heist (40s)

> Then this arrives. "URGENT, our bank details have changed, pay today."

Show: the card is red, "Check before paying". The reasons say it asks to pay new bank details and uses pressure, and the third one comes from the payee's own bank through Airwallex account verification: "the bank says this account belongs to Mark Lehmann, not Berlin Office Lettings". The Pay button is disabled.

> The model flagged it, and the bank confirmed the account isn't the landlord's. But neither of those is what stops it. The rule is code: a held invoice can't be paid until a person confirms the details with the payee on a number they already had.

Tap the checkbox only after "calling". Pay. (Or ignore it, which is the right call for a real scam.)

## 3:30 A payout bounces (30s)

Have the agent pay an account that bounces (live: the Airwallex transfer simulation: `SENT`, then `FAILED` with `failure_type` `ACCOUNT_CLOSED`).

Show: the timeline turns to Bounced, then Refunded in full. Details shows the refund tx on Metal.

> The refund goes out under a second Metal mandate. Metal caps each refund and the lifetime total, so even Sayso can't drain itself through refunds.

## 4:00 The heist on chain (20s)

Run the demo's heist beat (`npm run demo` beat 6, or the back office): a compromised agent tries to send the earnings to an attacker.

Show: **Metal refused it on chain** (PayeeNotAllowed), with the explorer link to the recorded refusal.

> Earnings can only move to one address: the ramp into Airwallex. That's enforced by Metal's mandate, not by our prompt.

## 4:20 Every cent explained (25s)

Show: Payments, "Books reconcile to the cent." Then the back office reconciliation: Metal swept equals ramp credited equals Airwallex deposits, and every currency's balance is explained by its conversions, payouts and fees.

## 4:45 Close (10s)

> Sayso: agents and people pay real invoices, and the rails, not the prompt, decide what's allowed. MCP server and API are in the repo.
