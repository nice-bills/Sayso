# Connect any agent to Sayso

Every agent gets its own key from the app (**Agents, Connect your agent**), optionally with a per-payout cap. A key can forward invoices, list them, quote and check status. **No key can approve a payment**: the owner gets a link (and a phone notification if `NTFY_TOPIC` is set) and taps Pay while signed in. Disconnecting an agent in the app revokes its key at once.

Sayso needs a public HTTPS address for chat apps to reach it. Set `PUBLIC_URL` to it so approval links point there.

| Where your agent lives | How to connect | Tested |
| --- | --- | --- |
| **Claude Code** | `claude mcp add --transport http sayso https://YOUR-HOST/mcp --header "Authorization: Bearer KEY"` | Yes |
| **Claude Code, as a plugin** | `/plugin install sayso --marketplace OWNER/REPO`. It asks for the URL and key, and adds a skill that teaches Claude the approval flow. | Plugin validated |
| **claude.ai, Claude Desktop, ChatGPT, other chat apps** | Add a custom connector with the URL `https://YOUR-HOST/mcp/k/KEY`. The key is in the URL because these apps can't set headers, so treat the URL like a password. | Not yet |
| **Cursor, Windsurf, any MCP client** | Streamable HTTP server at `https://YOUR-HOST/mcp` with the `Authorization: Bearer KEY` header | Same endpoint as Claude Code |
| **OpenClaw, Hermes, other skill-based agents** | Copy `integrations/agent-skill/sayso` into the agent's skills folder and set `SAYSO_URL` and `SAYSO_AGENT_KEY`. The skill uses the REST twin, `POST /v1/agent/invoices`. | REST endpoint tested |
| **An agent with its own Metal wallet** | Run the local MCP server, which pays quotes over x402 with the agent's key: `claude mcp add sayso -e SAYSO_URL=... -e SAYSO_BUYER_KEY=0x... -- npx tsx src/mcp/server.ts` | Yes (offline) |

## Cards inside the chat (MCP Apps)

In chat apps that support MCP Apps (Claude, ChatGPT, VS Code, Goose and others), `list_invoices` and `forward_invoice` show the inbox as Sayso cards right in the conversation. Swipe for the next invoice, tap one to open it, and swipe to approve. Approving opens Sayso, where you confirm with your passkey, and the card turns green once the payment is on its way. A held invoice opens the 1 cent check, and one missing details can ask the sender for them through the chat. Apps without MCP Apps get the same tools as plain text.

## Texting your agent (iMessage, WhatsApp, Telegram)

Sayso doesn't run a chat bot; you bring your own assistant (OpenClaw, Poke, or anything that texts and supports MCP or skills). Connect it as above, then:

1. Text it a photo of an invoice: "pay this".
2. It reads the invoice and forwards it to Sayso.
3. It texts back: "Pay €280 to Kreuzberg Studio? Tap to approve: https://YOUR-HOST/approve/...".
4. You tap the link, check the details, and tap Pay. Your phone stays signed in for a week.

If the invoice changes bank details or pushes urgency, the reply says so, and Pay stays locked until you confirm you phoned the payee.

## Sayso's own email address (AgentMail)

Sayso makes its own email address the first time it starts, with no AgentMail account: something like `sayso-1a2b3c4d@agentmail.to`. You can see it in the app under **Agents**.

- **Invoices:** suppliers, or you, forward invoices to that address. Each one shows up in the app within seconds, and your phone gets a push if `NTFY_TOPIC` is set.
- **Agents send through it:** Claude, ChatGPT and other connected agents get `ask_for_details`, `send_email`, `reply_email`, `email_inbox` and `read_email`. They can chase a supplier for a missing bank account, or reply in a thread, without you connecting another email account. Replies come back into Sayso. An agent can only email people who have already emailed Sayso or sent it an invoice, and it can send at most 20 emails a day.
- **One step to send, without a host key:** AgentMail lets a new address receive straight away, but it can only email other people once a human confirms. With `OWNER_EMAIL` set, AgentMail emails you a 6-digit code. Enter it under **Agents, Sayso's email**. Until then Sayso still receives invoices, and sending says what's missing.

**Hosting Sayso for others? Skip the code for everyone.** Verify one AgentMail account once, and set its key as `AGENTMAIL_API_KEY`. Each Sayso then makes its own address under that account, and can send straight away. The owner never sees a code. Already have an inbox? Add `AGENTMAIL_INBOX_ID` and Sayso uses that one. If you'd rather not have Sayso make an address, set `AGENTMAIL_AUTO=off`. Sayso polls the inbox on every tick. For instant delivery, add a `message.received` webhook pointing at `https://YOUR-HOST/webhooks/agentmail` and put its secret (`whsec_...`) in `AGENTMAIL_WEBHOOK_SECRET`.

Webhook signatures are checked, and retries never queue an invoice twice. Gmail over IMAP (`INBOX_IMAP_*`) still works if you'd rather use it.
