# Demo film script (4 minutes 32 seconds)

The film has two parts. The first minute is motion graphics: the problem, what Sayso is, and the three verdicts. The rest is real footage of the live deploy (Airwallex sandbox, Metal testnet) and of Freelance Hub, the Base44 app that uses Sayso as its payout layer. Only speed, crop, narration and subtitles are added to the footage. The agent chapter shows a real Claude Code session, re-typeset beside the live app.

Watch it: https://youtu.be/AlF9QM4m-6Q

The lines below are the narration, in order, with the time each scene starts.

## 0:00 Cold open

> An AI agent was just handed an invoice, and told to pay it. It has no card, and no bank login. So who said yes?

## 0:09 The problem

> Software can move money now. Agents hold balances. Apps trigger payouts. And in 2024, hijacked emails and fake invoices cost businesses $2.77 billion, according to the FBI.

## 0:23 Why a prompt is not enough

> Hand an AI agent your bank login, and one convincing email is all it takes. A prompt is not a financial control.

## 0:32 What Sayso is

> Sayso is the payout layer in between. Apps and agents can ask. Your rules, written in plain English and compiled to code, decide what is even allowed. You approve with a passkey. Airwallex moves the money. And every payout leaves a receipt on Metal that anyone can check.

## 0:49 The three verdicts

> Every request gets a verdict, in code. A payee you know, at a fair price: pay. A rate that has gone bad: wait. New bank details: hold, until you look. No prompt can talk its way past that.

## 1:02 Title

> They can ask. Only you can say so. Here it is, running live.

## 1:08 01 · An agent asks

> This is Claude Code, a real AI agent, connected to Sayso over MCP. We hand it an invoice for €140, and tell it to pay.

## 1:18 01 · An agent asks

> It forwards the invoice. Sayso reads it, checks the payee with Airwallex, and it lands in the owner's inbox. The right side is the live app.

## 1:28 01 · It cannot approve

> Then the agent reports back, in its own words. The invoice is in your inbox, but not paid. It needs your approval. The money has not moved.

## 1:38 01 · The owner's say-so

> Approving is not a tool the agent has. Only the owner can, with a passkey. One tap, and Airwallex sends it.

## 1:47 02 · An app asks

> Apps get the same deal. This is Freelance Hub, a real app built on Base44, with Sayso as its payout layer. A buyer posts a job for $450. The freelancer delivers, and the buyer releases the payment.

## 2:02 02 · The rules refuse

> Refused. This owner's rule says euros and pounds only. Nothing is queued, and the buyer sees exactly why.

## 2:10 03 · Inside the rules

> Same app, same flow, this time in euros. €280 to Kreuzberg Studio. Delivered, and released.

## 2:19 03 · It can ask, not pay

> Now the app has done everything it can do. Its key can request a payout. It can never approve one. So the job waits.

## 2:28 04 · The owner's inbox

> On the owner's side, the request arrives by itself. €280 to Kreuzberg Studio, from Freelance Hub.

## 2:37 04 · The decision

> Before asking for anything, Sayso priced it, checked the balance, and checked the payee's account with Airwallex. Price, balance, risk. All clear, so the verdict is pay.

## 2:49 04 · The say-so

> The owner taps once. That tap is a passkey signature, and no app or agent holds that key. In this recording, a software passkey signs it.

## 2:59 05 · Airwallex pays

> 43 seconds later, Airwallex has sent the transfer. This is the sandbox, so no real money moved, but it is the real API.

## 3:09 05 · The app hears back

> Back in Freelance Hub, nobody touched the page. Sayso's signed webhooks moved the job to paid, and attached a receipt.

## 3:17 06 · Proof on Metal

> That link opens Metal's block explorer. The transaction data starts with the letters SAYSO1, followed by the receipt's fingerprint. Anyone can hash the receipt and compare.

## 3:29 07 · What if

> And that verdict is code, not a mood. Make the rate 2% worse, and it flips. Change the bank details, and it flips again. Nothing moves in what-if mode. It only shows the rule.

## 3:42 07 · Why

> Every step is kept. What was read, which rules ran, what the bank said, who approved, and what moved. A model read the request. Code made the decision.

## 3:52 07 · The books

> Five payouts delivered, and the books reconcile to the cent.

## 3:58 08 · A budget on Metal

> One more thing. An owner can give an agent a budget. A mandate on Metal: a cap in USDZ, with Sayso as the only payee. Inside it, the agent pays by itself, over x402, and Sayso checks every payment against the mandate. On 13 November, Claude paid an invoice for €20 this way, live on Metal testnet.

## 4:21 Close

> Apps and agents can ask. Rules, a passkey, and a receipt decide. Sayso. Live today on the Airwallex sandbox, Metal testnet, and Base44.

## Video description (paste under the upload)

Sayso is the payout layer between AI agents, apps and a bank account. Agents and apps can ask for a payout. Rules written in plain English and compiled to code return a verdict (pay, wait, split or hold), the owner approves with a passkey, Airwallex moves the money, and every payout leaves a receipt on Metal.

Sponsor tech in this film:
- Airwallex (sandbox API): payee account checks, FX quotes, transfers, balances and signed webhooks.
- Metal (testnet): USDZ, x402 payments, owner-signed mandates that cap what an agent can spend, and receipt hashes anchored on chain. On 13 Nov 2026 Claude paid a EUR 20 invoice under a mandate: https://testnet.metalntwx.com/tx/0xf1d1bb00e8609a1080d204690327b96b841275a7b1d674b7206fc78393e78e0f
- Base44: Freelance Hub, a Base44 app, uses Sayso for payouts over signed webhooks.
- Claude and MCP: Claude Code connects through the Sayso MCP server.

Live app (read-only for visitors): https://sayso-mp5d.onrender.com
Repo: https://github.com/nice-bills/Sayso

## Rebuilding the film

The sources are in `demo/`, which is not in the repo: recordings in `demo/raw`, the Remotion project in `demo/revision-v3`, and the narration in `demo/revision-v3/vo.json`.
