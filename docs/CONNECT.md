# Connect any agent to Coin Slot

Every agent gets its own key from the app (**Agents, Connect your agent**), optionally with a per-payout cap. A key can forward invoices, list them, quote and check status. **No key can approve a payment**: the owner gets a link (and a phone notification if `NTFY_TOPIC` is set) and taps Pay while signed in. Disconnecting an agent in the app revokes its key at once.

Coin Slot needs a public HTTPS address for chat apps to reach it. Set `PUBLIC_URL` to it so approval links point there.

| Where your agent lives | How to connect | Tested |
| --- | --- | --- |
| **Claude Code** | `claude mcp add --transport http coinslot https://YOUR-HOST/mcp --header "Authorization: Bearer KEY"` | Yes |
| **Claude Code, as a plugin** | `/plugin install coinslot --marketplace OWNER/REPO`. It asks for the URL and key, and adds a skill that teaches Claude the approval flow. | Plugin validated |
| **claude.ai, Claude Desktop, ChatGPT, other chat apps** | Add a custom connector with the URL `https://YOUR-HOST/mcp/k/KEY`. The key is in the URL because these apps can't set headers, so treat the URL like a password. | Not yet |
| **Cursor, Windsurf, any MCP client** | Streamable HTTP server at `https://YOUR-HOST/mcp` with the `Authorization: Bearer KEY` header | Same endpoint as Claude Code |
| **OpenClaw, Hermes, other skill-based agents** | Copy `integrations/agent-skill/coinslot` into the agent's skills folder and set `COINSLOT_URL` and `COINSLOT_AGENT_KEY`. The skill uses the REST twin, `POST /v1/agent/invoices`. | REST endpoint tested |
| **An agent with its own Metal wallet** | Run the local MCP server, which pays quotes over x402 with the agent's key: `claude mcp add coinslot -e COINSLOT_URL=... -e COINSLOT_BUYER_KEY=0x... -- npx tsx src/mcp/server.ts` | Yes (offline) |

## Texting your agent (iMessage, WhatsApp, Telegram)

Coin Slot doesn't run a chat bot; you bring your own assistant (OpenClaw, Poke, or anything that texts and supports MCP or skills). Connect it as above, then:

1. Text it a photo of an invoice: "pay this".
2. It reads the invoice and forwards it to Coin Slot.
3. It texts back: "Pay €280 to Kreuzberg Studio? Tap to approve: https://YOUR-HOST/approve/...".
4. You tap the link, check the details, and tap Pay. Your phone stays signed in for a week.

If the invoice changes bank details or pushes urgency, the reply says so, and Pay stays locked until you confirm you phoned the payee.
