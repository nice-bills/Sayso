// A real Claude agent paying a real invoice through Sayso's MCP server: `npm run agent`.
//
//   SAYSO_URL           the Sayso to pay through (default http://127.0.0.1:4021, e.g. `npm run serve:offline`)
//   SAYSO_BUYER_KEY     the agent's Metal testnet key (live), or SAYSO_SIM_PAYER=0x... against an offline Sayso
//   SAYSO_MAX_USDZ      the most it may pay (default 250)
//   ANTHROPIC_API_KEY   (or an `ant auth login` profile): no key, no run; there is no scripted fallback
//   --invoice <file>    the invoice or email to pay (default: a sample one)

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hasClaudeCredentials, runClaudePayer } from "../src/agent/claude-payer.js";

const SAMPLE = `From: Etiqueta SL <facturas@etiqueta.example>
Subject: Factura 2026-311, data labelling (October)

Hello, please find our invoice for the October labelling batch.

Invoice: 2026-311
Amount due: EUR 42.00 (part payments accepted)
Due: 20 November 2026

Etiqueta SL, Calle de Alcalá 1, 28014 Madrid, Spain
IBAN: ES91 2100 0418 4502 0005 1332

Gracias!`;

const at = process.argv.indexOf("--invoice");
const invoice = at > 0 ? readFileSync(process.argv[at + 1]!, "utf8") : SAMPLE;
const max = process.env.SAYSO_MAX_USDZ ?? "250";
if (!hasClaudeCredentials()) {
  console.error("Set ANTHROPIC_API_KEY (or run `ant auth login`). This agent is Claude; there is no scripted stand-in.");
  process.exit(2);
}
if (!process.env.SAYSO_BUYER_KEY && !process.env.SAYSO_SIM_PAYER && !process.env.SAYSO_MANDATE) {
  console.error("Set SAYSO_BUYER_KEY (a Metal testnet key), SAYSO_MANDATE, or SAYSO_SIM_PAYER for an offline Sayso.");
  process.exit(2);
}

const mcp = new Client({ name: "claude-payer", version: "1.0.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], env: { ...(process.env as Record<string, string>), SAYSO_MAX_USDZ: max }, stderr: "inherit" }));
try {
  const run = await runClaudePayer({
    client: new Anthropic(),
    mcp,
    task: `Pay this invoice. Your limit is ${max} USDZ.\n\n<invoice>\n${invoice}\n</invoice>`,
    onStep: (s) => console.log(`→ ${s.tool}(${JSON.stringify(s.input).slice(0, 160)})\n  ${s.result.replace(/\s+/g, " ").slice(0, 300)}`),
  });
  console.log(`\n${run.model}, ${run.turns} turns, ${run.steps.length} tool calls:\n${run.summary}`);
} finally {
  await mcp.close();
}
