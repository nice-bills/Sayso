// Sayso, the app. No framework and no build step: a small element builder (text is always set
// as text, never as HTML, because invoice emails are written by strangers), state in one object,
// and a full re-render after each change. Live updates come from the server's event stream.

const $root = document.getElementById("root");
const state = {
  signedIn: null, inbox: [], payouts: [], summary: null, agents: [], newKey: null,
  focus: decodeURIComponent(location.pathname.match(/^\/approve\/(.+)$/)?.[1] ?? "") || null,
  tab: sessionGet("tab") || "inbox", filter: "all",
  showAdd: false, drafts: {}, verified: {}, open: {}, busy: {}, toast: null,
};

function sessionGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } }

// ---------- elements ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- formatting ----------
const money = (amount, ccy) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(Number(amount)); }
  catch { return `${ccy} ${Number(amount).toFixed(2)}`; }
};
const usdz = (n) => `${Number(n).toFixed(2)} USDZ`;
const ago = (iso) => {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secs] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
  return "just now";
};
const sender = (from) => (from.match(/^"?([^"<]+?)"?\s*</)?.[1] ?? from).trim();

// ---------- api ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401 && !path.startsWith("/auth/")) { state.signedIn = false; render(); throw new Error("signed out"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function load() {
  const [inbox, payouts, summary, agents] = await Promise.all([api("/v1/inbox"), api("/v1/payouts"), api("/v1/summary"), api("/v1/agents")]);
  const changed = JSON.stringify([inbox, payouts, summary, agents]) !== JSON.stringify([state.inbox, state.payouts, state.summary, state.agents]);
  Object.assign(state, { inbox, payouts, summary, agents, signedIn: true });
  if (changed) render();
}

let pending;
function refreshSoon() { clearTimeout(pending); pending = setTimeout(() => load().catch(() => {}), 350); }

let stream;
function goLive() {
  if (stream) return;
  stream = new EventSource("/ops/events");
  stream.onmessage = refreshSoon;
  stream.onerror = () => { if (state.signedIn === false) { stream.close(); stream = undefined; } };
  setInterval(() => { if (state.signedIn && document.visibilityState === "visible") load().catch(() => {}); }, 8000);
}

function toast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { if (state.toast === msg) { state.toast = null; render(); } }, 3500);
}

async function act(key, fn, done) {
  state.busy[key] = true;
  render();
  try { await fn(); if (done) toast(done); await load(); }
  catch (e) { if (e.message !== "signed out") toast(e.message); }
  finally { delete state.busy[key]; render(); }
}

// ---------- render ----------
let dirty = false;
function render() {
  // Don't yank an input out from under someone typing; catch up when they leave it.
  const focused = document.activeElement;
  if (focused && $root.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) && focused.type !== "checkbox") { dirty = true; return; }
  dirty = false;
  const y = window.scrollY;
  $root.replaceChildren(...[state.signedIn === null ? h("div") : state.signedIn ? appView() : landing(), state.toast ? h("div", { class: "toast", role: "status" }, state.toast) : null].filter(Boolean));
  window.scrollTo(0, y);
}
document.addEventListener("focusout", () => setTimeout(() => { if (dirty) render(); }, 0));

function brand() { return h("div", { class: "brand" }, h("span", { class: "mark", "aria-hidden": "true" }), "Sayso"); }

function landing() {
  let token = "";
  const err = h("div", { class: "error", role: "alert" });
  const submit = async (e) => {
    e.preventDefault();
    try { await api("/auth/login", { token }); state.signedIn = true; await load(); goLive(); render(); }
    catch (x) { err.textContent = x.message === "wrong token" ? "That token isn't right." : x.message; }
  };
  return h("div", { class: "landing wrap" },
    brand(),
    h("h1", {}, "Pay any invoice, from an AI agent or with one tap."),
    h("p", { class: "lede" }, "Agents pay in USDZ on Metal and Sayso delivers local currency through Airwallex. People forward an invoice and tap once. The rules that keep money safe are code, not a prompt."),
    h("div", { class: "landing-grid" },
      h("ul", { class: "points" },
        point(1, "Forward an invoice", "Sayso reads it, checks the payee with Airwallex, and asks you one question."),
        point(2, "Tap to pay", "Invoices that change bank details or push urgency wait until you've confirmed with the payee yourself."),
        point(3, "Or let your agent pay", "Any MCP agent can pay a real-world invoice over x402. If the bank bounces it, the agent is refunded in full."),
      ),
      h("form", { class: "card signin", onsubmit: submit },
        h("label", { for: "token" }, "Owner token"),
        h("input", { id: "token", class: "field", type: "password", autocomplete: "current-password", placeholder: "Paste your owner token", oninput: (e) => { token = e.target.value; } }),
        h("button", { class: "btn pay", type: "submit" }, "Sign in"),
        err,
        h("p", { class: "small muted" }, "The token is in your server's log, or set OWNER_TOKEN. Running offline? It's ", h("code", {}, "sayso-demo"), "."),
      ),
    ),
  );
}
function point(n, title, text) { return h("li", {}, h("span", { class: "n" }, n), h("div", {}, h("b", {}, title), h("span", { class: "muted" }, text))); }

function appView() {
  const needsYou = state.inbox.filter((i) => ["needs_details", "awaiting_approval", "needs_verification"].includes(i.status)).length;
  const reviews = reviewable().length;
  const tabs = [["inbox", "Inbox", needsYou], ["payments", "Payments", reviews], ["agents", "Agents", 0]];
  const balances = Object.entries(state.summary?.balances ?? {}).filter(([, m]) => m !== 0);
  return h("div", {},
    h("header", { class: "top" }, h("div", { class: "wrap" },
      brand(),
      h("div", { class: "grow balances", title: "Airwallex balances" }, balances.map(([c, m]) => h("span", {}, c, " ", h("b", {}, money(m / 100, c).replace(/^[^\d-]+/, "")))), state.summary?.offline ? h("span", { class: "pill" }, "offline") : null),
      h("a", { class: "btn quiet", href: "/ops/", target: "_blank", rel: "noopener" }, "Back office"),
      h("button", { class: "btn quiet", onclick: async () => { await api("/auth/logout", {}); state.signedIn = false; render(); } }, "Sign out"),
    )),
    h("div", { class: "wrap" },
      h("nav", { class: "tabs", role: "tablist" }, tabs.map(([id, label, n]) => h("button", { class: "tab", role: "tab", "aria-selected": String(state.tab === id), onclick: () => { state.tab = id; sessionSet("tab", id); leaveFocus(); render(); } }, label, n ? h("span", { class: "count" }, n) : null))),
      h("main", {}, state.focus ? focusView() : state.tab === "inbox" ? inboxView() : state.tab === "payments" ? paymentsView() : agentsView()),
    ),
  );
}

// ---------- one invoice, opened from an approval link ----------
function leaveFocus() {
  if (!state.focus) return;
  state.focus = null;
  history.replaceState(null, "", "/");
}

function focusView() {
  const item = state.inbox.find((i) => i.id === state.focus);
  return h("div", {},
    h("button", { class: "btn quiet", style: "padding-left:0;margin-bottom:8px", onclick: () => { leaveFocus(); state.tab = "inbox"; render(); } }, "← All invoices"),
    item ? h("div", { class: "list" }, invoiceCard(item)) : h("div", { class: "empty" }, "This invoice isn't in your inbox."),
  );
}

// ---------- inbox ----------
const ACTIVE = ["needs_verification", "awaiting_approval", "needs_details"];

function inboxView() {
  const active = state.inbox.filter((i) => ACTIVE.includes(i.status)).sort((a, b) => ACTIVE.indexOf(a.status) - ACTIVE.indexOf(b.status));
  const done = state.inbox.filter((i) => !ACTIVE.includes(i.status));
  return h("div", {},
    h("div", { class: "head" },
      h("div", {}, h("h2", {}, "Inbox"), h("div", { class: "muted small" }, "Invoices forwarded to Sayso. Nothing is paid until you tap.")),
      h("button", { class: "btn", onclick: () => { state.showAdd = !state.showAdd; render(); } }, state.showAdd ? "Close" : "Add invoice"),
    ),
    state.showAdd ? addSheet() : null,
    h("div", { class: "list" },
      active.length ? active.map(invoiceCard) : h("div", { class: "empty" }, "You're all caught up. Forward an invoice, or add one here."),
      done.length ? h("h3", { class: "muted small", style: "margin:12px 0 0" }, "Done") : null,
      done.map(invoiceCard),
    ),
  );
}

function addSheet() {
  const d = (state.drafts.__new ??= { from: "", subject: "", body: "" });
  const set = (k) => (e) => { d[k] = e.target.value; };
  const file = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const header = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
    d.from = header("From") ?? d.from;
    d.subject = header("Subject") ?? (d.subject || f.name);
    d.body = text.includes("\n\n") && header("From") ? text.slice(text.indexOf("\n\n") + 2) : text;
    render();
  };
  return h("form", { class: "card sheet", style: "margin-bottom:12px", onsubmit: (e) => {
    e.preventDefault();
    act("add", async () => {
      const item = await api("/v1/inbox", { from: d.from || "you", subject: d.subject || "(no subject)", body: d.body });
      delete state.drafts.__new; state.showAdd = false;
      toast(item.status === "awaiting_approval" ? "Invoice added. It's ready to pay." : item.status === "needs_details" ? "Invoice added. A few details are missing." : "Invoice added.");
    });
  } },
    h("div", { class: "form" },
      h("label", {}, h("span", {}, "From"), h("input", { class: "field", name: "from", value: d.from, placeholder: "billing@supplier.com", oninput: set("from") })),
      h("label", {}, h("span", {}, "Subject"), h("input", { class: "field", name: "subject", value: d.subject, placeholder: "Invoice 0042", oninput: set("subject") })),
      h("label", { class: "wide" }, h("span", {}, "Invoice text"), h("textarea", { class: "field", name: "body", required: true, placeholder: "Paste the email or invoice text", oninput: set("body") }, d.body)),
    ),
    h("div", { class: "actions" },
      h("button", { class: "btn pay", type: "submit", disabled: state.busy.add }, state.busy.add ? "Reading…" : "Add to inbox"),
      h("label", { class: "btn quiet" }, "Or open a .eml or .txt file", h("input", { type: "file", accept: ".eml,.txt,text/plain,message/rfc822", class: "hidden", onchange: file })),
    ),
  );
}

const INBOX_PILL = {
  needs_details: ["Needs details", "warn"], awaiting_approval: ["Ready to pay", "coin"], needs_verification: ["Check before paying", "stop"],
  rejected: ["Won't pay", "stop"], ignored: ["Ignored", ""], duplicate: ["Duplicate", ""],
};

function invoiceCard(item) {
  const f = item.fields, p = item.payout;
  const known = f.amount && f.currency;
  const [label, tone] = item.status === "paying" && p ? PAYOUT_PILL[p.status] ?? [p.status, ""] : INBOX_PILL[item.status] ?? [item.status, ""];
  const done = !ACTIVE.includes(item.status);
  return h("article", { class: `inv${done && item.status !== "paying" ? " done" : ""}`, "data-status": item.status },
    h("div", { class: "meta" }, h("span", {}, sender(item.from), " · ", item.subject), h("span", {}, ago(item.receivedAt))),
    h("div", { class: "line", style: "display:flex;justify-content:space-between;gap:12px;align-items:flex-start" },
      h("div", { class: "what" }, known ? [h("span", { class: "amt" }, money(f.amount, f.currency)), " to ", f.payeeName ?? "someone"] : item.subject),
      h("span", { class: `pill ${tone}` }, label),
    ),
    h("div", { class: "sub" }, [f.reference && `Ref ${f.reference}`, f.dueDate && `Due ${f.dueDate}`, bankLine(f, item.status !== "needs_verification")].filter(Boolean).join(" · ")),
    item.status === "awaiting_approval" ? approveBlock(item) : null,
    item.status === "needs_verification" ? verifyBlock(item) : null,
    item.status === "needs_details" ? detailsBlock(item) : null,
    item.status === "paying" && p ? [timeline(p, true), failure(p)] : null,
    item.status === "rejected" && p?.reasons?.length ? h("div", { class: "alert" }, h("b", {}, "Sayso won't pay this: "), p.reasons.join("; ")) : null,
    item.status === "duplicate" ? h("div", { class: "sub" }, "This matches an invoice already in your inbox, so it wasn't queued again.") : null,
  );
}

function bankLine(f, masked) {
  const acct = f.iban ? `IBAN ${f.iban}` : f.accountNumber ? `${f.sortCode ? `Sort code ${f.sortCode}, ` : f.routingNumber ? `Routing ${f.routingNumber}, ` : ""}account ${f.accountNumber}` : "";
  if (!acct) return "";
  if (!masked) return acct;
  const digits = (f.iban ?? f.accountNumber).replace(/\s/g, "");
  return `${f.iban ? "IBAN" : "Account"} ending ${digits.slice(-4)}`;
}

function approveBlock(item) {
  const p = item.payout, key = `pay:${item.id}`;
  return h("div", { class: "actions" },
    h("button", { class: "btn pay", disabled: state.busy[key], onclick: () => act(key, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/approve`, {}), `Paying ${money(p.amount, p.currency)} to ${p.payee}.`) }, state.busy[key] ? "Paying…" : `Pay ${money(p.amount, p.currency)}`),
    ignoreButton(item),
    h("span", { class: "muted small" }, `From your Airwallex balance by ${p.method === "SWIFT" ? "SWIFT" : "local transfer"}, about ${money(p.price_usdz, "USD")}.`),
  );
}

function verifyBlock(item) {
  const p = item.payout, f = item.fields, key = `pay:${item.id}`;
  const ok = Boolean(state.verified[item.id]);
  return [
    h("div", { class: "alert" },
      h("b", {}, "This one needs a phone call first."),
      p?.reasons?.length ? h("ul", {}, p.reasons.map((r) => h("li", {}, r))) : null,
      h("p", { style: "margin:8px 0 0" }, `Call ${f.payeeName ?? "the payee"} on a number you already had (not one from this email) and read them these details: `, h("code", {}, bankLine(f, false))),
    ),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: ok, onchange: (e) => { state.verified[item.id] = e.target.checked; render(); } }),
      h("span", {}, "I confirmed these bank details with the payee myself."),
    ),
    h("div", { class: "actions" },
      h("button", { class: "btn pay", disabled: !ok || state.busy[key], onclick: () => act(key, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/approve`, { verified_with_payee: true }), `Paying ${money(p.amount, p.currency)} to ${p.payee}.`) }, `Pay ${money(p.amount, p.currency)}`),
      ignoreButton(item),
    ),
  ];
}

const FIELDS = [
  ["payeeName", "Payee name", "payee name"], ["amount", "Amount", "amount"], ["currency", "Currency", "currency"],
  ["iban", "IBAN (or an account number below)", "bank account"], ["accountNumber", "Account number", "bank account"], ["sortCode", "Sort code"], ["routingNumber", "Routing number"],
  ["bankCountry", "Bank country (2 letters)", "bank country"], ["reference", "Reference"],
];
const ADDRESS = [["street", "Street", null, true], ["city", "City"], ["postcode", "Postcode"], ["addressCountry", "Country (2 letters)"]];

function detailsBlock(item) {
  const d = (state.drafts[item.id] ??= {});
  const key = `details:${item.id}`;
  const needs = (tag) => tag && item.missing.includes(tag);
  const input = ([k, label, tag, wide]) => h("label", { class: `${wide ? "wide " : ""}${needs(tag) ? "need" : ""}` },
    h("span", {}, label),
    h("input", { class: "field", name: k, value: d[k] ?? item.fields[k] ?? "", oninput: (e) => { d[k] = e.target.value; } }));
  const other = item.missing.filter((m) => !FIELDS.some(([, , tag]) => tag === m));
  // Up front: what's missing (one account field stands for "bank account"). Folded: everything else, to correct.
  const upFront = FIELDS.filter(([k, , tag]) => needs(tag) && k !== "accountNumber");
  const rest = [...FIELDS.filter((f) => !upFront.includes(f)), ...ADDRESS];
  return h("form", { class: "sheet", onsubmit: (e) => {
    e.preventDefault();
    act(key, async () => {
      const r = await api(`/v1/inbox/${encodeURIComponent(item.id)}/details`, d);
      delete state.drafts[item.id];
      toast(r.status === "awaiting_approval" ? "Got it. It's ready to pay." : r.status === "needs_verification" ? "Got it, but check it before paying." : r.status === "needs_details" ? `Still missing: ${r.missing.join(", ")}` : `Saved. ${INBOX_PILL[r.status]?.[0] ?? r.status}.`);
    });
  } },
    h("div", { class: "sub" }, `I couldn't find ${item.missing.join(", ")}. Fill in what you know and I'll check it again.`),
    other.length ? h("div", { class: "alert" }, other.join("; ")) : null,
    upFront.length ? h("div", { class: "form" }, upFront.map(input)) : null,
    h("details", { open: upFront.length === 0 }, h("summary", {}, needs("bank account") ? "Other details (UK or US account, address, reference)" : "Other details"), h("div", { class: "form", style: "margin-top:10px" }, rest.map(input))),
    h("div", { class: "actions" }, h("button", { class: "btn pay", type: "submit", disabled: state.busy[key] }, state.busy[key] ? "Checking…" : "Save and check"), ignoreButton(item)),
  );
}

function ignoreButton(item) {
  const key = `ignore:${item.id}`;
  return h("button", { class: "btn quiet", type: "button", disabled: state.busy[key], onclick: () => act(key, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/ignore`, {}), "Ignored.") }, "Ignore");
}

// ---------- payouts ----------
const PAYOUT_PILL = {
  quoted: ["Waiting for payment", "info"], needs_review: ["Needs review", "warn"], rejected: ["Blocked", "stop"], accepted: ["Payment settling", "info"],
  funded: ["Paid, sending", "info"], submitted: ["On its way", "info"], paid: ["Delivered", "go"], failed: ["Bounced", "stop"],
  refunded: ["Bounced, refunded", "warn"], refund_failed: ["Refund failed", "stop"], expired: ["Expired", ""],
};

function timeline(p, inbox) {
  const done = { accepted: 0, funded: 1, submitted: 2, paid: 3, failed: 2, refunded: 2, refund_failed: 2 }[p.status];
  if (done === undefined) return null; // not paid for yet
  const bounced = ["failed", "refunded", "refund_failed"].includes(p.status);
  const steps = [inbox ? "Approved" : "Paid in USDZ", "Sent by Airwallex", bounced ? "Bounced" : "Delivered"].map((label, i) => ({
    label, cls: bounced && i === 2 ? "bad" : i < done ? "done" : i === done ? "now" : "",
  }));
  if (p.status === "refunded") steps.push({ label: "Refunded in full", cls: "done" });
  if (p.status === "refund_failed") steps.push({ label: "Refund failed", cls: "bad" });
  if (p.status === "failed" && p.source === "agent") steps.push({ label: "Refunding", cls: "now" });
  return h("div", { class: "steps", style: `grid-template-columns:repeat(${steps.length},minmax(0,1fr))`, "aria-label": "progress" }, steps.map((s) => h("div", { class: `step ${s.cls}` }, s.label)));
}

function failure(p) {
  if (!p.failure) return null;
  return h("div", { class: "sub" }, p.status === "refunded" && p.source === "agent" ? `The bank returned it (${p.failure}). The agent got all ${usdz(p.price_usdz)} back.` : `The bank returned it: ${p.failure}.`);
}

const linkedPayouts = () => new Set(state.inbox.map((i) => i.payoutId).filter(Boolean));
const reviewable = () => state.payouts.filter((p) => p.status === "needs_review" && !linkedPayouts().has(p.id));

function payoutRow(p) {
  const tapPending = linkedPayouts().has(p.id) && ["quoted", "needs_review"].includes(p.status);
  const [label, tone] = tapPending ? (p.status === "quoted" ? ["Waiting for your tap", "coin"] : ["Check before paying", "stop"]) : PAYOUT_PILL[p.status] ?? [p.status, ""];
  const open = state.open[p.id];
  const from = p.source === "agent" ? "Agent" : p.source === "inbox" || linkedPayouts().has(p.id) ? "Inbox" : "Quote";
  return h("article", { class: "row", "data-status": p.status },
    h("div", { class: "line" }, h("b", {}, p.payee), h("span", { class: "amt" }, money(p.amount, p.currency))),
    h("div", { class: "line small" }, h("span", { class: "muted" }, from, " · ", p.reference, p.created_at ? ` · ${ago(p.created_at)}` : ""), h("span", { class: `pill ${tone}` }, label)),
    timeline(p, from === "Inbox"),
    failure(p),
    p.status === "needs_review" && !linkedPayouts().has(p.id) ? reviewBlock(p) : null,
    h("button", { class: "btn quiet small", style: "justify-self:start;padding-left:0", onclick: () => { state.open[p.id] = !open; render(); } }, open ? "Hide details" : "Details"),
    open ? h("div", { class: "proofs" },
      row("Payout id", p.id), row("Method", p.method),
      from === "Agent" ? row("Agent paid", `${usdz(p.price_usdz)} (fee ${usdz(p.fee_usdz)})`) : null,
      row("Metal payment", p.funding_tx), row("Airwallex transfer", p.airwallex_transfer_id), row("Refund", p.refund_tx),
      p.reasons?.length ? row("Why", p.reasons.join("; ")) : null,
    ) : null,
  );
}
function row(k, v) { return v ? h("div", {}, k, ": ", h("code", {}, String(v))) : null; }

function reviewBlock(p) {
  const key = `review:${p.id}`;
  const go = (decision) => act(key, () => api(`/v1/payouts/${encodeURIComponent(p.id)}/review`, { decision }), decision === "reject" ? "Blocked." : "Approved. The agent can pay it now.");
  return h("div", {},
    h("div", { class: "alert" }, h("b", {}, "Held for review: "), p.reasons.join("; ")),
    h("div", { class: "actions", style: "margin-top:8px" },
      h("button", { class: "btn", disabled: state.busy[key], onclick: () => go("approve") }, "Allow"),
      h("button", { class: "btn danger", disabled: state.busy[key], onclick: () => go("reject") }, "Block"),
    ),
  );
}

function paymentsView() {
  const all = state.payouts;
  const linked = linkedPayouts();
  const filters = [["all", "All"], ["agent", "From agents"], ["inbox", "From the inbox"], ["review", "Needs review"], ["problems", "Bounced"]];
  const shown = all.filter((p) => state.filter === "all" ? true
    : state.filter === "agent" ? p.source === "agent"
    : state.filter === "inbox" ? p.source === "inbox" || linked.has(p.id)
    : state.filter === "review" ? p.status === "needs_review" && !linked.has(p.id)
    : ["failed", "refunded", "refund_failed"].includes(p.status));
  const delivered = all.filter((p) => p.status === "paid");
  const moving = all.filter((p) => ["accepted", "funded", "submitted"].includes(p.status));
  const rec = state.summary?.reconcile;
  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h2", {}, "Payments"), h("div", { class: "muted small" }, rec ? (rec.ok ? "Books reconcile to the cent." : "Books don't reconcile. Check the back office.") : "Every payout, from agents and from your inbox.")),
    ),
    h("div", { class: "stats" },
      stat(delivered.length, "delivered", byCcy(delivered)),
      stat(moving.length, "on the way", byCcy(moving)),
      stat(all.filter((p) => p.status === "refunded").length, "bounced and refunded", ""),
    ),
    h("div", { class: "filters", style: "margin-bottom:12px" }, filters.map(([id, label]) => h("button", { class: "chip", "aria-pressed": String(state.filter === id), onclick: () => { state.filter = id; render(); } }, label))),
    h("div", { class: "list" }, shown.length ? shown.map(payoutRow) : h("div", { class: "empty" }, "Nothing here yet.")),
  );
}
function byCcy(ps) {
  const t = {};
  for (const p of ps) t[p.currency] = (t[p.currency] ?? 0) + Number(p.amount);
  return Object.entries(t).map(([c, a]) => money(a, c)).join(" · ");
}
function stat(big, lbl, sub) { return h("div", { class: "card stat" }, h("div", { class: "big" }, big), h("div", { class: "lbl" }, lbl), sub ? h("div", { class: "small muted" }, sub) : null); }

// ---------- agents ----------
function agentsView() {
  const agentPays = state.payouts.filter((p) => p.source === "agent");
  const received = agentPays.filter((p) => p.status !== "refunded").reduce((s, p) => s + Number(p.price_usdz), 0);
  const earned = agentPays.filter((p) => p.status !== "refunded").reduce((s, p) => s + Number(p.fee_usdz), 0);
  const swept = (state.summary?.sweeps ?? []).filter((s) => s.status === "credited").reduce((s, x) => s + x.amountMinor, 0) / 100;
  const origin = location.origin;
  const mcp = `claude mcp add sayso \\\n  -e SAYSO_URL=${origin} \\\n  -e SAYSO_BUYER_KEY=0x… \\\n  -e SAYSO_MAX_USDZ=500 \\\n  -- npx tsx src/mcp/server.ts`;
  const curl = `curl -X POST ${origin}/v1/quotes \\\n  -H 'content-type: application/json' \\\n  -d '{"amount":"180.00","currency":"EUR","reference":"Oct",\n       "payee":{"name":"Lingua Freelance","bank":{"iban":"FR14…"},\n       "bank_country_code":"FR","address":{"country_code":"FR","city":"Paris"}}}'`;
  return h("div", {},
    h("div", { class: "head" }, h("div", {}, h("h2", {}, "Agents"), h("div", { class: "muted small" }, "Any AI agent with USDZ on Metal can pay a real-world invoice through Sayso."))),
    h("div", { class: "stats" },
      stat(agentPays.length, "agent payouts", byCcy(agentPays.filter((p) => p.status === "paid")) || ""),
      stat(usdz(received), "received over x402", `${usdz(earned)} in fees`),
      stat(money(swept, "USD"), "swept into Airwallex", "under the ramp-only Metal mandate"),
    ),
    h("div", { class: "card", style: "margin-bottom:12px" },
      h("b", {}, "How an agent pays"),
      h("ul", { class: "points", style: "margin-top:12px" },
        point(1, "Quote, for free", "Sayso prices the payout, checks the payee with Airwallex, and runs the risk rules."),
        point(2, "Pay over x402", "The 402 response names the exact price. Metal won't sign above the agent's own cap."),
        point(3, "Airwallex delivers", "Fiat moves only after the payment settles on Metal. If the bank bounces it, the agent gets everything back."),
      ),
    ),
    connectAgents(origin),
    snippet("Or run the MCP server next to an agent with its own wallet", mcp),
    snippet("Or call the API", curl),
    h("h3", { class: "muted small", style: "margin:20px 0 8px" }, "Recent agent payouts"),
    h("div", { class: "list" }, agentPays.length ? agentPays.slice(0, 10).map(payoutRow) : h("div", { class: "empty" }, "No agent has paid yet.")),
  );
}
function snippet(title, text) {
  return h("div", { class: "card", style: "margin-bottom:12px" },
    h("button", { class: "btn quiet small copy", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Couldn't copy here."); } } }, "Copy"),
    h("b", {}, title), h("pre", {}, text));
}

function connectAgents(origin) {
  const d = (state.drafts.__agent ??= { name: "", cap: "" });
  const nk = state.newKey;
  const live = state.agents.filter((a) => !a.revokedAt);
  const add = (e) => {
    e.preventDefault();
    act("agent", async () => {
      state.newKey = await api("/v1/agents", { name: d.name, cap_usd: d.cap || undefined });
      delete state.drafts.__agent;
    });
  };
  return h("div", { class: "card", style: "margin-bottom:12px" },
    h("b", {}, "Connect your agent"),
    h("p", { class: "small muted", style: "margin:4px 0 12px" }, "Claude, ChatGPT, OpenClaw, or the assistant you text from iMessage. It can forward invoices and check on payments. It can't approve them: you get a link and tap it yourself."),
    nk ? h("div", { class: "sheet" },
      h("div", { class: "alert", style: "background:var(--go-bg)" }, h("b", { style: "color:var(--go)" }, `Key for ${nk.agent.name}. `), "Copy it now; it won't be shown again."),
      h("pre", {}, nk.key),
      h("div", { class: "small muted" }, "Add Sayso to the agent by URL:"),
      h("pre", {}, `${origin}/mcp\nAuthorization: Bearer ${nk.key}`),
      h("div", { class: "small muted" }, "Claude Code:"),
      h("pre", {}, `claude mcp add --transport http sayso ${origin}/mcp \\\n  --header "Authorization: Bearer ${nk.key}"`),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(nk.key); toast("Copied."); } catch { toast("Couldn't copy here."); } } }, "Copy key"),
        h("button", { class: "btn quiet", onclick: () => { state.newKey = null; render(); } }, "Done"),
      ),
    ) : h("form", { class: "form", onsubmit: add },
      h("label", {}, h("span", {}, "Agent name"), h("input", { class: "field", name: "agent-name", required: true, value: d.name, placeholder: "My phone assistant", oninput: (e) => { d.name = e.target.value; } })),
      h("label", {}, h("span", {}, "Most it can ask for, per payout (USD, optional)"), h("input", { class: "field", name: "agent-cap", inputmode: "decimal", value: d.cap, placeholder: "500", oninput: (e) => { d.cap = e.target.value; } })),
      h("div", { class: "actions wide", style: "grid-column:1/-1" }, h("button", { class: "btn pay", type: "submit", disabled: state.busy.agent }, "Create a key")),
    ),
    live.length ? h("div", { style: "margin-top:14px" }, live.map((a) => h("div", { class: "line", style: "display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)" },
      h("div", {}, h("b", {}, a.name), h("div", { class: "small muted" }, a.capMinor ? `Up to ${money(a.capMinor / 100, "USD")} per payout · ` : "", a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : "not used yet")),
      h("button", { class: "btn quiet danger", disabled: state.busy[`revoke:${a.id}`], onclick: () => act(`revoke:${a.id}`, () => api(`/v1/agents/${encodeURIComponent(a.id)}/revoke`, {}), `Disconnected ${a.name}.`) }, "Disconnect"),
    ))) : null,
  );
}

// ---------- start ----------
(async () => {
  try {
    const me = await api("/auth/me");
    state.signedIn = me.owner;
    if (me.owner) { await load(); goLive(); }
  } catch { state.signedIn = false; }
  render();
})();
