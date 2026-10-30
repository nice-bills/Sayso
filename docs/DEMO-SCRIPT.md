# Demo script (2 minutes 40 seconds)

The guide's arc: the goal, the agent's plan, new information, the revised decision, and the money that moved. The video follows one invoice, €280 to Kreuzberg Studio due in 9 days, and changes one input at a time. Every verdict on screen sits next to its proof: a Metal explorer link or an Airwallex object id.

**Before recording**
- `.env` filled, `npm run setup:metal` and `npm run setup:airwallex` done, `npm run serve` running, the app open and signed in, and the Airwallex sandbox dashboard in a second tab.
- Run `npm run demo` once so the dashboard has transfers and the explorer has the refund and the heist.
- One Claude Code window with the Sayso MCP server added (README, "Use it from an agent").
- Offline backup: `npm run serve:offline`, sign in with `sayso-demo`. The captioned clip of the flip is in the project files (`sayso-demo/decision-flip.mp4`).

---

## 0:00 The problem (15s)

Show the landing page, then Claude Code beside the app.

> Agents hold money now. Sayso lets them pay real invoices, and code, not the prompt, decides how.

## 0:15 Goal and plan: Pay (35s)

In Claude Code: *"Pay Kreuzberg Studio €280 for invoice 130, up to 350 USDZ."*

The decision card fills in: **Price** 309 USDZ, under the 350 cap. **Balance**: the budget left on the owner's Metal mandate. **Risk**: payee paid before. Verdict **Pay**.

> All three inputs are clear, so it pays.

Click the Metal payment hash, then show the same transfer id in the Airwallex dashboard.

## 0:50 New information: Hold (45s)

The same invoice arrives again from `kreuzberg-studlo.example`. Every field matches except the IBAN. The risk gauge turns red and the card flips to **Hold**: "invoice asks to pay new bank details". Price and balance stay clear.

> One field changed, and the decision changed.

Tap **Check with a 1-cent code**: Sayso sends 0.01 with a code to the new account (show it in Airwallex). The agent's USDZ stays in escrow on Metal.

> The agent's money is locked, not lost.

## 1:35 The other inputs: Wait and Split (30s)

On the original invoice, use the sandbox **What if** row (labelled "nothing moves"):
- **Rate 2% dearer**: **Wait**. "EUR is 2.1% dearer than this week's median, and it's due in 9 days." For real, a waiting payout keeps the agent's USDZ in escrow and Airwallex pays it once the rate is back within 1.5% or a day before the due date.
- **Budget 190 USDZ**: **Split** when the payee takes part payments, €170 now and the rest after the next earnings sweep; otherwise **Wait** for funds.

> Price and balance move it too.

## 2:05 Why it can't be talked out of it (20s)

Show `src/payouts/decide.ts` (the rules, in order) beside the payout's **Why?** trail.

> Claude reads the email. These rules decide. Approving isn't a tool the agent has.

## 2:25 Close (15s)

Payments: "Books reconcile to the cent." Then the repo link.

> Every decision moved real money, on the Airwallex sandbox and Metal testnet.

## If there is room

- **Prove it (20s), for the Metal award.** Payments, Rechenzentrum Nord, **Prove it**: six pieces of evidence, all ticked, including "the agent's key signed this exact order". Tap **Wasn't allowed**: Denied, and the answer is anchored on Metal. Then the same claim on Lingua Freelance, paid from a bare key: no mandate on record, so it's upheld and refunded on chain. *"Same claim, different proof, different answer."*
- **Bounce and refund (20s).** An account that bounces: Bounced, then Refunded in full, with the refund on Metal under its own capped mandate.
- **The heist (15s).** `npm run demo` beat 8: a compromised agent tries to send the earnings elsewhere and Metal refuses it on chain (`mandate_payee_not_listed`).
- **A higher cap (15s).** A bill over the agent's cap and due tomorrow is held with the cap it needs; the owner approves it with one `mandate replace`.
