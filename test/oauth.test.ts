import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";

describe("Sign in with Sayso (MCP authorization for chat apps)", () => {
  it("lets Claude register, the owner tap Allow, and Claude use /mcp with no key pasted", async () => {
    const cs = await buildSayso({ offline: true });
    const server = cs.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const owner = { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}` };
    const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
    try {
      // What a chat app reads first: a 401 from /mcp pointing at the metadata, then the metadata.
      const first = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(first.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
      const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
      expect(as).toMatchObject({ issuer: base, authorization_endpoint: `${base}/oauth2/authorize`, registration_endpoint: `${base}/oauth2/register`, code_challenge_methods_supported: ["S256"] });

      const redirect = "https://claude.ai/api/mcp/auth_callback";
      const reg = (await (await fetch(`${base}/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }) })).json()) as { client_id: string };
      expect((await fetch(`${base}/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const auth = await fetch(`${base}/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" })}`, { redirect: "manual" });
      const connect = auth.headers.get("location")!;
      expect(connect).toMatch(/^\/connect\/[\w-]+$/);
      expect((await fetch(`${base}${connect}`)).headers.get("content-type")).toMatch(/html/); // the app's Allow screen
      const id = connect.split("/").pop()!;

      // Only the signed-in owner sees and answers it.
      expect((await fetch(`${base}/oauth2/requests/${id}`)).status).toBe(401);
      expect(await (await fetch(`${base}/oauth2/requests/${id}`, { headers: owner })).json()).toMatchObject({ client_name: "Claude", returns_to: "claude.ai" });
      const allowed = (await (await fetch(`${base}/oauth2/requests/${id}/allow`, { method: "POST", headers: owner, body: "{}" })).json()) as { redirect: string };
      const back = new URL(allowed.redirect);
      expect(`${back.origin}${back.pathname}`).toBe(redirect);
      expect(back.searchParams.get("state")).toBe("xyz");
      const code = back.searchParams.get("code")!;

      // A wrong verifier fails, and burns the code.
      const bad = await fetch(`${base}/oauth2/token`, form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: "nope" }));
      expect(bad.status).toBe(400);
      const again = await fetch(`${base}/oauth2/token`, form({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }));
      expect(again.status).toBe(400);

      // The proper run: a fresh request, the right verifier, then MCP with the token.
      const auth2 = await fetch(`${base}/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`, { redirect: "manual" });
      const id2 = auth2.headers.get("location")!.split("/").pop()!;
      const code2 = new URL(((await (await fetch(`${base}/oauth2/requests/${id2}/allow`, { method: "POST", headers: owner, body: "{}" })).json()) as { redirect: string }).redirect).searchParams.get("code")!;
      const tok = (await (await fetch(`${base}/oauth2/token`, form({ grant_type: "authorization_code", code: code2, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }))).json()) as { access_token: string; refresh_token: string };
      const mcp = new Client({ name: "Claude", version: "1" });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
      expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("list_invoices");
      await mcp.close();

      // Refresh works once, then the connection ends when the owner disconnects it.
      const fresh = (await (await fetch(`${base}/oauth2/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }))).json()) as { refresh_token: string };
      expect(fresh.refresh_token).toBeTruthy();
      expect((await fetch(`${base}/oauth2/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token }))).status).toBe(400);
      const agent = cs.keys.list().find((k) => k.name === "Claude" && !k.revokedAt)!;
      cs.keys.revoke(agent.id);
      expect((await fetch(`${base}/oauth2/token`, form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token }))).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
