import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { buildSayso } from "../src/app.js";
import { parseSpoken } from "../src/inbox/say.js";
import { recentEvents } from "../src/events.js";
import { studioBankChange, studioInvoice } from "../samples/invoices.js";

async function start() {
  const cs = await buildSayso({ offline: true });
  const server = cs.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cs.ownerToken}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const forward = (e: typeof studioInvoice) => post("/v1/inbox", { message_id: e.messageId, from: e.from, subject: e.subject, body: e.body });
  /** Pays the studio's first invoice, so Sayso knows them: bank details and a contact on file. */
  const payStudio = async () => {
    const item = await forward(studioInvoice);
    await post(`/v1/inbox/${encodeURIComponent(item.body.id)}/approve`, { approver: "will" });
    for (let i = 0; i < 2; i++) await cs.svc.follow();
  };
  return { cs, server, base, post, forward, payStudio };
}

describe("reading a spoken payment", () => {
  it.each([
    ["Pay Kreuzberg Studio 480 euros for invoice 1042", { payee: "Kreuzberg Studio", amount: "480.00", currency: "EUR", reference: "1042" }],
    ["send £200 to the plumber", { payee: "plumber", amount: "200.00", currency: "GBP", reference: null }],
    ["pay Holloway Print 72 pounds", { payee: "Holloway Print", amount: "72.00", currency: "GBP", reference: null }],
    ["pay Kreuzberg Studio", { payee: "Kreuzberg Studio", amount: null, currency: null, reference: null }],
  ])("%s", (said, want) => {
    expect(parseSpoken(said)).toEqual({ action: "pay", ...want });
  });

  it("is not a payment when nothing asks to pay", () => {
    expect(parseSpoken("what did I spend this week").action).toBe("other");
  });
});

describe("say a payment", () => {
  it("takes bank details only from a payee already paid, and says where each field came from", async () => {
    const { server, post, payStudio } = await start();
    try {
      const unknown = await post("/v1/say", { transcript: "Pay Kreuzberg Studio 480 euros" });
      expect(unknown.body.item).toBeNull();
      expect(unknown.body.problem).toMatch(/haven't paid/);

      await payStudio();
      const r = await post("/v1/say", { transcript: "Pay Kreuzberg Studio 480 euros for invoice 1042" });
      expect(r.body.heard).toBe("Pay Kreuzberg Studio 480 euros for invoice 1042");
      const by = Object.fromEntries(r.body.understood.map((u: { field: string; value: string; source: string }) => [u.field, u]));
      expect(by.amount).toMatchObject({ value: "480.00", source: "you said" });
      expect(by.bank.value).toBe("•••• 3000");
      expect(by.bank.source).toMatch(/your payment to Kreuzberg Studio GmbH/);
      expect(r.body.item.status).toBe("awaiting_approval"); // still waits for the owner's tap
      expect(r.body.item.payout.amount).toBe("480.00");
    } finally {
      server.close();
    }
  });

  it("matches a name speech-to-text misspelled, shows both spellings, and won't guess at a stranger", async () => {
    const { server, post, payStudio } = await start();
    try {
      await payStudio();
      // What Whisper actually wrote for a spoken "Pay Kreuzberg Studio 280 euros".
      const r = await post("/v1/say", { transcript: "Pay Cruzeburg Studio €280." });
      const payee = r.body.understood.find((u: { field: string }) => u.field === "payee");
      expect(payee).toMatchObject({ value: "Kreuzberg Studio GmbH", source: "you said “Cruzeburg Studio”" });
      expect(r.body.item.payout.amount).toBe("280.00");

      const other = await post("/v1/say", { transcript: "Pay Kreuzberg Bakery 50 euros" });
      expect(other.body.item).toBeNull();
      expect(other.body.problem).toMatch(/haven't paid/);
    } finally {
      server.close();
    }
  });

  it("points at an invoice already waiting instead of making a new one", async () => {
    const { server, post, forward } = await start();
    try {
      const item = await forward(studioInvoice);
      const r = await post("/v1/say", { transcript: "pay Kreuzberg Studio" });
      expect(r.body.item.id).toBe(item.body.id);
      expect(r.body.understood.find((u: { field: string }) => u.field === "amount")).toMatchObject({ value: "280.00", source: expect.stringMatching(/invoice from/) });
    } finally {
      server.close();
    }
  });
});

describe("the one-cent code check", () => {
  const linkFrom = (base: string) => {
    const sent = recentEvents().filter((e) => e.title.startsWith("Email to billing@kreuzberg-studio.example")).at(-1)!;
    return base + new URL(sent.title.match(/https?:\/\/\S+/)![0]).pathname;
  };
  const answer = (link: string, form: Record<string, string>) => fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });

  it("asks the contact on file, not the lookalike sender, and lifts the hold on the right code", async () => {
    const { server, base, post, forward, payStudio } = await start();
    try {
      await payStudio();
      const held = await forward(studioBankChange);
      expect(held.body.status).toBe("needs_verification");
      const id = encodeURIComponent(held.body.id);
      expect((await post(`/v1/inbox/${id}/approve`, { approver: "will" })).status).toBe(409); // still held

      const check = await post(`/v1/inbox/${id}/penny`);
      expect(check.body.contact).toBe("billing@kreuzberg-studio.example"); // on file, not kreuzberg-studlo
      expect(check.body.simStatementReference).toMatch(/^SAYSO CODE \d{6}$/);
      const code = check.body.simStatementReference.slice(-6);

      // The payee's page, from the email: no sign-in, plain HTML forms.
      const link = linkFrom(base);
      const page = await (await fetch(link)).text();
      expect(page).toContain("account ending <b>4300</b>");
      expect(page).not.toContain(code);

      expect((await answer(link, { code: "000000" })).status).toBe(400);
      expect((await answer(link, { code })).status).toBe(200);
      const paid = await post(`/v1/inbox/${id}/approve`, { approver: "will" });
      expect(paid.status).toBe(200);
      expect(paid.body.status).toBe("paying");
    } finally {
      server.close();
    }
  });

  it("blocks the invoice for good when the payee says the details aren't theirs, or after three wrong codes", async () => {
    const { server, base, post, forward, payStudio } = await start();
    try {
      await payStudio();
      const held = await forward(studioBankChange);
      const id = encodeURIComponent(held.body.id);
      await post(`/v1/inbox/${id}/penny`);
      await answer(linkFrom(base), { denied: "1" });
      const r = await post(`/v1/inbox/${id}/approve`, { approver: "will", verified_with_payee: true });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/not their bank details/);
    } finally {
      server.close();
    }

    const second = await start();
    try {
      await second.payStudio();
      const held = await second.forward(studioBankChange);
      await second.post(`/v1/inbox/${encodeURIComponent(held.body.id)}/penny`);
      const link = linkFrom(second.base);
      for (let i = 0; i < 3; i++) await answer(link, { code: "111111" });
      expect(await (await fetch(link)).text()).toContain("This check is closed");
    } finally {
      second.server.close();
    }
  });

  it("has nobody to ask when Sayso never paid the payee", async () => {
    const { server, post, forward } = await start();
    try {
      const held = await forward(studioBankChange);
      const r = await post(`/v1/inbox/${encodeURIComponent(held.body.id)}/penny`);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/no contact on file/);
    } finally {
      server.close();
    }
  });
});
