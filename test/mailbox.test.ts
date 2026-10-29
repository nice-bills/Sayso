import { describe, expect, it } from "vitest";
import { Mailbox } from "../src/inbox/mailbox.js";
import { Store } from "../src/store.js";

/** A pretend AgentMail: records requests and answers from a script. */
function fakeAgentMail(answer: (url: string, body: any) => { status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; body: any; auth?: string }> = [];
  const http = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const a = answer(url, body);
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { http, calls };
}

describe("Sayso's own mailbox", () => {
  it("signs itself up, receives at once, and sends once the owner enters AgentMail's code", async () => {
    delete process.env.AGENTMAIL_API_KEY; delete process.env.AGENTMAIL_INBOX_ID;
    let verified = false;
    const { http, calls } = fakeAgentMail((url) => {
      if (url.endsWith("/agent/sign-up")) return { json: { organization_id: "org", inbox_id: "sayso-ab12@agentmail.to", api_key: "am_key" } };
      if (url.endsWith("/agent/verify")) { verified = true; return { json: { verified: true } }; }
      if (url.endsWith("/messages/send")) return verified ? { json: { message_id: "<m1>", thread_id: "t1" } } : { status: 403, text: '{"name":"message_rejected","message":"Recipient(s) blocked: x (not in allow list)"}' };
      return { status: 404 };
    });
    const store = new Store(":memory:");
    const mb = new Mailbox(store, { ownerEmail: "owner@acme.example", http });
    const s = await mb.ensure();
    expect(calls[0]!.body).toMatchObject({ human_email: "owner@acme.example", source: "sayso" });
    expect(s).toMatchObject({ address: "sayso-ab12@agentmail.to", can_receive: true, can_send: false });
    expect(s.needs).toMatch(/6-digit code .*owner@acme.example/);
    await expect(mb.send("supplier@x.example", "Hi", "Hello")).rejects.toThrow(/6-digit code/);

    expect((await mb.verify("123456")).can_send).toBe(true);
    expect(calls.at(-1)!.auth).toBe("Bearer am_key");
    expect(await mb.send("supplier@x.example", "Hi", "Hello")).toEqual({ message_id: "<m1>", thread_id: "t1" });

    // The key survives a restart, so Sayso keeps the same address.
    const again = new Mailbox(store, { ownerEmail: "owner@acme.example", http });
    expect(await again.ensure()).toMatchObject({ address: "sayso-ab12@agentmail.to", can_send: true });
    expect(calls.filter((c) => c.url.endsWith("/agent/sign-up"))).toHaveLength(1);
  });
});
