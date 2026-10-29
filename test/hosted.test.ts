import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { fakeLandlord, studioInvoice, vagueEmail } from "../samples/invoices.js";

async function setup() {
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const connect = async (key: string) => {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
    return client;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: Boolean(r.isError), body: JSON.parse((r.content as Array<{ text: string }>)[0]!.text) };
  };
  return { cs, server, base, connect, call };
}

describe("hosted MCP endpoint", () => {
  it("lets an agent forward an invoice but leaves the tap to the owner", async () => {
    const { cs, server, base, connect, call } = await setup();
    try {
      const { key } = cs.keys.create("Phone assistant", null);
      const agent = await connect(key);
      const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["ask_for_details", "email_inbox", "forward_invoice", "list_invoices", "payout_status", "quote_payout", "read_email", "reply_email", "send_email"]);
      expect(tools.some((t) => /approve/.test(t))).toBe(false); // no tool can approve

      // Chat apps that support MCP Apps draw the inbox as cards (the view can't approve either).
      const listed = (await agent.listTools()).tools;
      for (const t of ["forward_invoice", "list_invoices"]) expect(listed.find((x) => x.name === t)?._meta).toMatchObject({ ui: { resourceUri: "ui://sayso/cards.html" } });
      const view = await agent.readResource({ uri: "ui://sayso/cards.html" });
      expect(view.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
      expect((view.contents[0] as { text: string }).text).toContain("ui/initialize");

      const { body } = await call(agent, "forward_invoice", { text: studioInvoice.body, from: studioInvoice.from });
      expect(body.status).toBe("awaiting_approval");
      expect(body.approval_url).toMatch(new RegExp(`^${base}/p/[\\w-]{8}$`));
      expect((await fetch(body.approval_url, { redirect: "manual" })).headers.get("location")).toBe(`/approve/${encodeURIComponent(body.invoice_id)}`);

      const shown = await agent.callTool({ name: "forward_invoice", arguments: { text: studioInvoice.body, from: studioInvoice.from, subject: "Again" } });
      const sc = shown.structuredContent as { items: Array<Record<string, unknown>>; focus: string };
      expect(sc.items.find((c) => c.id === sc.focus)).toMatchObject({ status: "duplicate" }); // the same invoice twice
      expect(sc.items.find((c) => c.id === body.invoice_id)).toMatchObject({ status: "awaiting_approval", currency: "EUR", payee: expect.any(String), approval_url: body.approval_url });
      const held = await call(agent, "forward_invoice", { text: fakeLandlord.body, from: fakeLandlord.from });
      expect(held.body.status).toBe("needs_verification");
      const all = await agent.callTool({ name: "list_invoices", arguments: {} });
      expect((all.structuredContent as { items: Array<{ status: string }> }).items.map((c) => c.status).sort()).toEqual(["awaiting_approval", "needs_verification"]);

      // The agent's key can't reach the owner's approval route.
      const tap = await fetch(`${base}/v1/inbox/${encodeURIComponent(body.invoice_id)}/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" });
      expect(tap.status).toBe(401);
      expect(cs.inbox.get(body.invoice_id)?.status).toBe("awaiting_approval");
      // The approval link opens the app.
      expect((await fetch(body.approval_url)).headers.get("content-type")).toMatch(/html/);
      // The REST twin for curl-based skills.
      const rest = await fetch(`${base}/v1/agent/invoices`, { headers: { authorization: `Bearer ${key}` } });
      expect(((await rest.json()) as unknown[]).length).toBe(2);
      await agent.close();
    } finally {
      server.close();
    }
  });

  it("refuses missing, revoked and over-cap keys", async () => {
    const { cs, server, base, connect, call } = await setup();
    try {
      expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      // Key in the URL, for chat apps that can only paste a connector URL.
      const viaUrl = cs.keys.create("Chat app", null);
      const c = new Client({ name: "url-agent", version: "1.0.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/k/${viaUrl.key}`)));
      expect((await c.listTools()).tools).toHaveLength(9);
      await c.close();
      const small = cs.keys.create("Tiny budget", 5000); // $50
      const agent = await connect(small.key);
      const r = await call(agent, "forward_invoice", { text: studioInvoice.body }); // ~EUR 280
      expect(r.error).toBe(true);
      expect(r.body.error).toMatch(/above this agent's cap/);
      await agent.close();
      cs.keys.revoke(small.agent.id);
      await expect(connect(small.key)).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it("lets an agent email through Sayso's own address, but only people who wrote in", async () => {
    const { cs, server, connect, call } = await setup();
    try {
      const agent = await connect(cs.keys.create("Claude", null).key);
      const vague = await call(agent, "forward_invoice", { text: vagueEmail.body, from: vagueEmail.from, subject: vagueEmail.subject });
      expect(vague.body.status).toBe("needs_details");

      const asked = await call(agent, "ask_for_details", { invoice_id: vague.body.invoice_id });
      expect(asked.error).toBe(false);
      expect(asked.body).toMatchObject({ sent_to: "someone@someone.example", from: "sayso-demo@agentmail.to" });
      const box = await call(agent, "email_inbox", {});
      expect(box.body.address).toBe("sayso-demo@agentmail.to");
      expect(box.body.messages[0]).toMatchObject({ to: ["someone@someone.example"] });
      expect((await call(agent, "read_email", { message_id: box.body.messages[0].message_id })).body.text).toMatch(/payee name/);

      // A stranger can't be emailed from the business's address; someone who wrote in can.
      const stranger = await call(agent, "send_email", { to: "victim@elsewhere.example", subject: "Hi", text: "Pay me" });
      expect(stranger.error).toBe(true);
      expect(stranger.body.error).toMatch(/only emails people/);
      expect((await call(agent, "send_email", { to: "someone@someone.example", subject: "Following up", text: "Any news?" })).error).toBe(false);
      // Only invoices that are missing something get asked.
      const ok = await call(agent, "forward_invoice", { text: studioInvoice.body, from: studioInvoice.from });
      expect((await call(agent, "ask_for_details", { invoice_id: ok.body.invoice_id })).body.error).toMatch(/isn't missing/);
      await agent.close();
    } finally {
      server.close();
    }
  });
});
