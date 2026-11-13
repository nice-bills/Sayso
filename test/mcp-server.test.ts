import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The real stdio server, pointed at a fake Sayso host. These tests are about what an agent sees,
// not about pricing: the tool list, the server instructions, and what a restart looks like.

const invoice = {
  amount: "42.00", currency: "EUR", reference: "2026-311",
  payee_name: "Etiqueta SL", payee_country: "ES", payee_city: "Madrid", payee_street: "Calle de Alcala 1", payee_postcode: "28014",
  bank_country: "ES", bank: { iban: "ES9121000418450200051332" }, max_usdz: "100",
};

async function fakeSayso(handler: express.RequestHandler) {
  const paths: string[] = [];
  // Only Sayso API calls count: a parallel test can hit a recycled port with a stray GET /.
  const app = express().use((req, res) => { if (req.path !== "/") paths.push(`${req.method} ${req.path}`); handler(req, res, () => {}); });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, paths, close: () => server.close() };
}

async function connect(base: string, extraEnv: Record<string, string> = {}) {
  const mcp = new Client({ name: "mcp-test", version: "1" });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", "src/mcp/server.ts"],
    env: { ...(process.env as Record<string, string>), SAYSO_URL: base, SAYSO_SIM_PAYER: "0xA9e0000000000000000000000000000000000001", ...extraEnv },
    stderr: "ignore",
  }));
  return mcp;
}

const replyText = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");

describe("the stdio MCP server speaks clearly to an agent", () => {
  it("lists its instructions and says which invoice fields are required and which money is USDZ", async () => {
    const sayso = await fakeSayso((_req, res) => res.status(502).type("html").send("<html>down</html>"));
    const mcp = await connect(sayso.base);
    try {
      const instructions = mcp.getInstructions() ?? "";
      expect(instructions).toMatch(/pay_invoice/);
      expect(instructions).toMatch(/payout_status/);
      expect(instructions).toMatch(/USDZ/);
      expect(instructions).toMatch(/payee_state is required for US and Canadian payees/);
      expect(instructions).toMatch(/Never pay the same invoice twice/);

      const listed = (await mcp.listTools()).tools;
      const pay = listed.find((t) => t.name === "pay_invoice");
      expect(pay).toBeDefined();
      const schema = pay!.inputSchema as { required?: string[]; properties: Record<string, { description?: string }> };
      expect(schema.required).toEqual(expect.arrayContaining([
        "amount", "currency", "payee_name", "payee_country", "payee_city", "payee_street", "payee_postcode", "bank_country", "bank", "reference", "max_usdz",
      ]));
      expect(schema.required).not.toContain("payee_state");
      expect(schema.properties.amount?.description).toMatch(/not USDZ/);
      expect(schema.properties.currency?.description).toMatch(/never USDZ/);
      expect(schema.properties.payee_state?.description).toMatch(/US and Canadian/);
      expect(schema.properties.max_usdz?.description).toMatch(/USDZ/);
      expect(pay!.description).toMatch(/payout_status before paying again/);
      // The free quote tool says it is free.
      expect(listed.find((t) => t.name === "quote_payout")!.description).toMatch(/free/);
    } finally {
      await mcp.close();
      sayso.close();
    }
  }, 30_000);

  it("turns a host's HTML 502 during a quote into a restart message, not an HTML page", async () => {
    const sayso = await fakeSayso((_req, res) => res.status(502).type("html").send("<!doctype html><h1>502 Bad Gateway</h1>"));
    const mcp = await connect(sayso.base);
    try {
      const quoted = await mcp.callTool({ name: "quote_payout", arguments: invoice });
      expect(quoted.isError).toBe(true);
      const body = replyText(quoted);
      expect(body).toMatch(/restarting/);
      expect(body).toMatch(/retry in about a minute/i);
      expect(body).not.toMatch(/<!doctype|<html|unexpected token/i);

      const paid = await mcp.callTool({ name: "pay_invoice", arguments: invoice });
      expect(paid.isError).toBe(true);
      expect(replyText(paid)).toMatch(/restarting/);
      // Sayso was never asked to pay: only the quote call went out.
      expect(sayso.paths).toEqual(["POST /v1/quotes", "POST /v1/quotes"]);
    } finally {
      await mcp.close();
      sayso.close();
    }
  }, 30_000);

  it("does not feed a 200 login page to JSON.parse", async () => {
    const sayso = await fakeSayso((_req, res) => res.status(200).type("html").send("<html><body>Sign in to continue</body></html>"));
    const mcp = await connect(sayso.base);
    try {
      const status = await mcp.callTool({ name: "payout_status", arguments: { payout_id: "00000000-0000-0000-0000-000000000001" } });
      expect(status.isError).toBe(true);
      const body = replyText(status);
      expect(body).toMatch(/web page instead of data/i);
      expect(body).not.toMatch(/unexpected token|<html/i);
    } finally {
      await mcp.close();
      sayso.close();
    }
  }, 30_000);

  it("refuses to pay when the configured cap is not a USDZ number, instead of treating it as no limit", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const sayso = await fakeSayso((req, res) => res.json({ id, status: "quoted", currency: "EUR", price_usdz: "1.00", offer: {} }));
    const mcp = await connect(sayso.base, { SAYSO_MAX_USDZ: "lots" });
    try {
      const paid = await mcp.callTool({ name: "pay_quote", arguments: { quote_id: id } });
      expect(paid.isError).toBe(true);
      expect(replyText(paid)).toMatch(/SAYSO_MAX_USDZ/);
      expect(sayso.paths.some((p) => p.endsWith("/pay"))).toBe(false);
    } finally {
      await mcp.close();
      sayso.close();
    }
  }, 30_000);
});
