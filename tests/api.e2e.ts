// API-level end-to-end checks against Sayso offline: who may do what. Exact steps only, no model.
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const OWNER = { authorization: 'Bearer sayso-demo' };
const JSON_H = { 'content-type': 'application/json' };

type Payout = { id: string; payee: string; status: string; source: string | null };

async function payoutOf(base: string, payee: string): Promise<Payout | undefined> {
  const list = (await (await fetch(new URL('/v1/payouts', base), { headers: OWNER })).json()) as Payout[];
  return list.find((p) => p.payee === payee && p.source === 'agent');
}

test('api: owner endpoints refuse a caller with no sign-in or a wrong token', async ({ app }) => {
  const base = app.baseUrl;
  expect((await fetch(new URL('/v1/payouts', base))).status).toBe(401);
  expect((await fetch(new URL('/v1/inbox', base))).status).toBe(401);
  expect((await fetch(new URL('/v1/payouts', base), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  const approve = await fetch(new URL('/v1/inbox/anything/approve', base), { method: 'POST', headers: JSON_H, body: '{}' });
  expect(approve.status).toBe(401);
  const mcp = await fetch(new URL('/mcp', base), { method: 'POST', headers: JSON_H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  expect(mcp.status).toBe(401);
});

test('api: a stranger cannot dispute an agent payout; the payer can, and a bare-key claim goes to the owner', async ({ app }) => {
  const base = app.baseUrl;
  await expect.poll(async () => (await payoutOf(base, 'Lingua Freelance'))?.status, { timeout: 30_000 }).toBe('paid');
  const p = (await payoutOf(base, 'Lingua Freelance'))!;
  const url = new URL(`/v1/payouts/${p.id}/disputes`, base);
  const body = JSON.stringify({ claim: 'not_authorized', note: 'e2e' });
  const stranger = await fetch(url, { method: 'POST', headers: JSON_H, body });
  expect(stranger.status).toBe(401);
  const wrongPayer = await fetch(url, { method: 'POST', headers: { ...JSON_H, 'x-sim-payer': '0xBAD0000000000000000000000000000000000001' }, body });
  expect(wrongPayer.status).toBe(401);
  const payer = await fetch(url, { method: 'POST', headers: { ...JSON_H, 'x-sim-payer': '0xA9e0000000000000000000000000000000000001' }, body });
  expect(payer.status).toBe(201);
  const r = (await payer.json()) as { dispute: { verdict: string }; payout: { status: string } };
  expect(r.dispute.verdict).toBe('review');
  expect(r.payout.status).toBe('paid');
});

test('api: an invoice missing its bank details waits for them instead of being paid', async ({ app }) => {
  const res = await fetch(new URL('/v1/inbox', app.baseUrl), {
    method: 'POST', headers: { ...OWNER, ...JSON_H },
    body: JSON.stringify({ message_id: `e2e-missing-${Date.now()}`, from: 'Acme <billing@acme.example>', subject: 'Invoice 9', body: 'Please pay invoice 9 for EUR 75.00. Thanks, Acme Ltd' }),
  });
  expect(res.status).toBe(201);
  const item = (await res.json()) as { id: string; status: string; missing: string[] };
  // Cleanup first: the seeded app's own tests expect exactly one invoice missing details.
  await fetch(new URL(`/v1/inbox/${encodeURIComponent(item.id)}/ignore`, app.baseUrl), { method: 'POST', headers: { ...OWNER, ...JSON_H }, body: '{}' });
  expect(item.status).toBe('needs_details');
  expect(item.missing.length).toBeGreaterThan(0);
});

test('api: a connected agent can forward an invoice and list tools, but has no way to approve it', async ({ app }) => {
  const base = app.baseUrl;
  const made = await fetch(new URL('/v1/agents', base), { method: 'POST', headers: { ...OWNER, ...JSON_H }, body: JSON.stringify({ name: `e2e agent ${Date.now()}` }) });
  expect(made.status).toBe(201);
  const { key } = (await made.json()) as { key: string };
  const agent = { authorization: `Bearer ${key}` };
  const mcp = await fetch(new URL('/mcp', base), {
    method: 'POST', headers: { ...agent, ...JSON_H, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(mcp.status).toBe(200);
  const names = ((await mcp.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  expect(names).toContain('forward_invoice');
  expect(names.some((n) => /approve/.test(n))).toBe(false);
  const fwd = await fetch(new URL('/v1/agent/invoices', base), {
    method: 'POST', headers: { ...agent, ...JSON_H },
    body: JSON.stringify({ text: 'Invoice 77 from Holloway Print Ltd. Amount due: GBP 12.00. Sort code 04-00-04, account 12345678. 1 Fleet St, London EC4Y 1AA, United Kingdom.' }),
  });
  expect([201, 422]).toContain(fwd.status);
  const id = ((await fwd.json()) as { invoice_id?: string }).invoice_id ?? 'none';
  const approve = await fetch(new URL(`/v1/inbox/${encodeURIComponent(id)}/approve`, base), { method: 'POST', headers: { ...agent, ...JSON_H }, body: '{}' });
  await fetch(new URL(`/v1/inbox/${encodeURIComponent(id)}/ignore`, base), { method: 'POST', headers: { ...OWNER, ...JSON_H }, body: '{}' });
  expect(approve.status).toBe(401);
});

test('api: an app paying through Sayso is held to its own rules and cannot approve itself', async ({ app }) => {
  const base = app.baseUrl;
  const created = await fetch(new URL('/v1/platform/apps', base), { method: 'POST', headers: { ...OWNER, ...JSON_H }, body: JSON.stringify({ name: 'E2E Hub', rules: 'No more than 300 EUR per payout. Only pay EUR.' }) });
  expect(created.status).toBe(201);
  const { api_key } = (await created.json()) as { api_key: string };
  const asApp = { authorization: `Bearer ${api_key}`, ...JSON_H };
  const pay = (body: object) => fetch(new URL('/v1/platform/payouts', base), { method: 'POST', headers: asApp, body: JSON.stringify(body) });
  const job = { ref: 'e2e-1', payee_name: 'Atelier Nord', amount: '120.00', currency: 'EUR', reference: 'E2E-1', bank: { iban: 'DE89370400440532013000' } };

  expect((await pay({ ...job, ref: 'e2e-big', amount: '999.00' })).status).toBe(422);
  const ok = await pay(job);
  expect(ok.status).toBe(201);
  expect(((await ok.json()) as { state: string }).state).toBe('awaiting_approval');
  // The app's key is not an owner sign-in, and it doesn't open the agent endpoints.
  expect((await fetch(new URL('/v1/inbox/b44/approve', base), { method: 'POST', headers: asApp, body: '{}' })).status).toBe(401);
  expect((await fetch(new URL('/v1/agent/invoices', base), { headers: asApp })).status).toBe(401);
  const spec = (await (await fetch(new URL('/v1/platform/openapi.json', base))).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(spec.paths)).toContain('/v1/platform/payouts');
});
