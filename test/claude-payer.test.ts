import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildSayso } from "../src/app.js";
import { runClaudePayer } from "../src/agent/claude-payer.js";

// The model is stood in for here (no key in CI); everything it touches is real: Sayso's MCP server
// over stdio, its tool list, the HTTP API, the signed-offer check and the payout.
describe("the Claude payer drives Sayso's real MCP tools", () => {
  it("lists Sayso's tools, calls the one the model picks, feeds results back, and the invoice gets paid", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mcp = new Client({ name: "t", version: "1" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"], env: { ...(process.env as Record<string, string>), SAYSO_URL: base, SAYSO_SIM_PAYER: "0xA9e0000000000000000000000000000000000001" }, stderr: "ignore" }));
    const seen: Array<{ tools: string[]; last: unknown }> = [];
    const invoice = { amount: "42.00", currency: "EUR", reference: "2026-311", payee_name: "Etiqueta SL", payee_country: "ES", payee_city: "Madrid", payee_street: "Calle de Alcala 1", payee_postcode: "28014", payee_state: "Madrid", bank_country: "ES", bank: { iban: "ES9121000418450200051332" }, max_usdz: "100" };
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "pay_invoice", input: invoice }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Paid." }] },
    ];
    const client = { beta: { messages: { create: async (req: { tools: Array<{ name: string }>; messages: Array<{ content: unknown }> }) => {
      seen.push({ tools: req.tools.map((t) => t.name), last: req.messages.at(-1)!.content });
      return { model: "claude-opus-5-5", stop_details: null, ...replies[seen.length - 1]! };
    } } } } as never;
    try {
      const run = await runClaudePayer({ client, mcp, task: "Pay this invoice." });
      expect(seen[0]!.tools).toEqual(expect.arrayContaining(["quote_payout", "pay_invoice", "prove_payout", "dispute_payout", "pay_remainder"]));
      expect(run.steps).toHaveLength(1);
      const result = JSON.parse(run.steps[0]!.result);
      expect(result.paid).toBe(true);
      // The tool's answer went back to the model as a tool_result for its call.
      expect(seen[1]!.last).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "t1" })]);
      expect(run.summary).toBe("Paid.");
      expect(cs.svc.book.get(result.quote_id)!.status).not.toBe("quoted");
    } finally {
      await mcp.close();
      server.close();
    }
  }, 30_000);
});
