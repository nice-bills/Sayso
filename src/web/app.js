// Sayso, the app. No framework and no build step: a small element builder (text is always set
// as text, never as HTML, because invoice emails are written by strangers), state in one object,
// and a full re-render after each change. Live updates come from the server's event stream.

const $root = document.getElementById("root");
const state = {
  signedIn: null, inbox: [], payouts: [], summary: null, agents: [], newKey: null,
  focus: decodeURIComponent(location.pathname.match(/^\/approve\/(.+)$/)?.[1] ?? "") || null,
  tab: sessionGet("tab") || "home", filter: "all", events: [], recent: new Set(),
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

// Line icons, drawn as one SVG path each.
const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  payments: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M2 10h20 M6 15h4",
  bot: "M12 8V4H8 M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  spark: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5 18 18 M6 18l2.5-2.5 M15.5 8.5 18 6",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
  check: "M20 6 9 17l-5-5",
  hand: "M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4",
  plus: "M12 5v14 M5 12h14",
  out: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  ext: "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  back: "M19 12H5 M12 19l-7-7 7-7",
  ledger: "M4 4h16v16H4z M8 9h8 M8 13h8 M8 17h5",
};
function icon(name, size = 18) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.eye);
  svg.append(path);
  return svg;
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
/** The agent that forwarded an invoice, when one did. */
const agentOf = (item) => item.id.startsWith("agent-") || / \(agent\)$/.test(item.from) ? (item.from.match(/^(.+) \(agent\)$/)?.[1] ?? "an agent") : null;

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
  stream.onmessage = (m) => { try { addEvent(JSON.parse(m.data)); } catch { /* not an event */ } refreshSoon(); };
  stream.onerror = () => { if (state.signedIn === false) { stream.close(); stream = undefined; } };
  setInterval(() => { if (state.signedIn && document.visibilityState === "visible") load().catch(() => {}); }, 8000);
  setInterval(() => { if (state.signedIn && state.tab === "home" && document.visibilityState === "visible") render(); }, 30000);
}

// The server replays its recent events on connect, so a reconnect sends some twice.
const seen = new Set();
let drawSoon;
function addEvent(e) {
  if (!e?.title || seen.has(e.at + e.title)) return;
  seen.add(e.at + e.title);
  state.events.push(e);
  if (state.events.length > 200) state.events.shift();
  clearTimeout(drawSoon);
  drawSoon = setTimeout(render, 120);
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
  return h("div", { class: "landing" },
    h("header", { class: "landing-nav wrap" }, brand(), h("a", { class: "btn", href: "#token" }, "Sign in")),
    h("section", { class: "landing-hero wrap" },
      h("span", { class: "badge" }, h("span", { class: "dot live" }), "Running on Airwallex and Metal"),
      h("h1", {}, "Your agents pay the bills. ", h("span", { class: "fade" }, "You keep the say.")),
      h("p", { class: "lede" }, "Any AI agent can pay a real invoice in local currency. Sayso checks the payee with their bank first, and anything risky waits for you."),
      h("form", { class: "signin", onsubmit: submit },
        h("label", { for: "token", class: "sr" }, "Owner token"),
        h("div", { class: "signin-row" },
          h("input", { id: "token", class: "field", type: "password", autocomplete: "current-password", placeholder: "Owner token", oninput: (e) => { token = e.target.value; } }),
          h("button", { class: "btn pay", type: "submit" }, "Sign in"),
        ),
        err,
        h("p", { class: "small muted" }, "Running the offline demo? The token is ", h("code", {}, "sayso-demo"), "."),
      ),
    ),
    h("section", { class: "stage wrap" }, chatDemo()),
    h("section", { class: "band" }, h("div", { class: "wrap" },
      h("p", { class: "statement" },
        "Agents can earn money now, but they can't pay a freelancer in Lyon. Sayso takes their payment on Metal and delivers euros or pounds through Airwallex. ",
        h("span", { class: "fade" }, "The rules that protect the money are code, not a prompt, so a clever email can't talk its way past them.")),
      h("div", { class: "facts" },
        fact("100%", "refunded to the agent when a bank bounces a payout"),
        fact("1 tap", "from you approves a payment; an agent never can"),
        fact("0", "payouts sent twice, because Airwallex dedupes every request"),
      ),
    )),
    h("footer", { class: "landing-foot wrap small muted" }, "Sayso, built for the Airwallex and Metal hackathon."),
  );
}
function fact(big, text) { return h("div", { class: "fact" }, h("div", { class: "fact-big" }, big), h("div", { class: "fact-text" }, text)); }

/** The landing page's product shot: a short conversation with an agent that pays through Sayso. */
function chatDemo() {
  const msg = (who, ...kids) => h("div", { class: `msg ${who}` }, ...kids);
  const tool = (name) => h("div", { class: "tool" }, "Used Sayso: ", name);
  return h("div", { class: "chat", "aria-label": "Example: an agent paying invoices through Sayso" },
    h("div", { class: "chat-head" }, h("span", { class: "avatar" }, icon("bot", 15)), h("b", {}, "Your assistant")),
    h("div", { class: "chat-body" },
      msg("you", "Pay the Kreuzberg Studio invoice that came in this morning."),
      msg("agent", tool("pay invoice"), "Done. €280.00 to Kreuzberg Studio GmbH is waiting for your tap."),
      msg("sayso", h("div", { class: "small muted" }, "Sayso"), h("div", { class: "fake-pay" }, "Pay €280.00")),
      msg("agent", "Delivered by Airwallex. Reference INV-2026-114."),
      msg("you", "Also pay the rent. They said their bank details changed."),
      msg("agent warn", tool("pay invoice"), "Sayso is holding that one. The bank says the account isn't the landlord's, so call them on a number you already have."),
    ),
  );
}

const NEEDS = (i) => ["needs_details", "awaiting_approval", "needs_verification"].includes(i.status);

function appView() {
  const needsYou = state.inbox.filter(NEEDS).length + reviewable().length;
  const tabs = [["home", "Home", "home", needsYou], ["inbox", "Inbox", "inbox", 0], ["payments", "Payments", "payments", 0], ["agents", "Agents", "bot", 0]];
  const s = state.summary;
  return h("div", { class: "shell" },
    h("header", { class: "top" }, h("div", { class: "wrap" },
      brand(),
      h("nav", { class: "tabs", role: "tablist" }, tabs.map(([id, label, ic, n]) => h("button", { class: "tab", role: "tab", "aria-selected": String(state.tab === id && !state.focus), onclick: () => { state.tab = id; sessionSet("tab", id); leaveFocus(); render(); window.scrollTo(0, 0); } }, icon(ic, 20), h("span", { class: "tab-label" }, label), n ? h("span", { class: "count" }, n) : null))),
      h("div", { class: "top-right" },
        s ? h("span", { class: "mode", title: s.offline ? "Airwallex and Metal are simulated" : "Real Airwallex and Metal APIs" }, h("span", { class: `dot${s.offline ? "" : " live"}` }), s.offline ? "Offline demo" : s.sandbox ? "Sandbox" : "Live") : null,
        h("a", { class: "btn quiet icon-btn", href: "/ops/", target: "_blank", rel: "noopener", title: "Back office", "aria-label": "Back office" }, icon("ledger", 18)),
        h("button", { class: "btn quiet icon-btn", title: "Sign out", "aria-label": "Sign out", onclick: async () => { await api("/auth/logout", {}); state.signedIn = false; render(); } }, icon("out", 18)),
      ),
    )),
    h("div", { class: "wrap" },
      h("main", {}, state.focus ? focusView() : state.tab === "home" ? homeView() : state.tab === "inbox" ? inboxView() : state.tab === "payments" ? paymentsView() : agentsView()),
    ),
  );
}

// ---------- home: what needs you, and what your agents are doing ----------
function homeView() {
  const order = ["needs_verification", "awaiting_approval", "needs_details"];
  const needs = state.inbox.filter(NEEDS).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const reviews = reviewable();
  const n = needs.length + reviews.length;
  // Keep what you just approved in view, so you can watch it go through.
  const recent = state.inbox.filter((i) => state.recent.has(i.id) && !NEEDS(i));
  const s = state.summary;
  const usd = (s?.balances ?? {}).USD;
  return h("div", {},
    h("section", { class: "hero" },
      h("h2", { class: "hero-title" }, n ? `${n} ${n === 1 ? "payment needs" : "payments need"} you` : "All clear"),
      h("p", { class: "muted" },
        !s ? "Connecting…" : s.offline ? "Offline demo with simulated Airwallex and Metal." : `Live on the Airwallex${s.sandbox ? " sandbox" : ""} and Metal${s.sandbox ? " testnet" : ""}.`,
        usd ? ` ${money(usd / 100, "USD")} available.` : ""),
    ),
    h("div", { class: "home-grid" },
      h("section", {},
        h("h3", { class: "section" }, "Needs you"),
        h("div", { class: "list" },
          n ? [reviews.map(payoutRow), needs.map(invoiceCard)] : h("div", { class: "empty" }, "Nothing needs you. Your agents will bring the next invoice here."),
          recent.length ? [h("h3", { class: "section sub-section" }, "Just approved"), recent.map(invoiceCard)] : null,
        ),
      ),
      h("section", { class: "activity" },
        h("h3", { class: "section" }, "What's happening"),
        activityFeed(),
      ),
    ),
  );
}

// Each step's tone: green moved money, amber waits for a person, red was refused.
const TONE = { observe: "", decide: "", act: "go", reconcile: "go", escalate: "warn", refuse: "stop" };
const sentence = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const NOISE = /^(Sayso on |Running OFFLINE|Seeded sample|Airwallex sandbox: payee name)/;

function activityFeed() {
  const evs = state.events.filter((e) => !NOISE.test(e.title)).slice(-30).reverse();
  if (!evs.length) return h("p", { class: "muted small" }, "Steps appear here as your agents and Sayso take them.");
  // A time is shown once per run of steps that share it, so a burst doesn't repeat "just now".
  let last;
  return h("ol", { class: "feed" }, evs.map((e) => {
    const when = ago(e.at), shown = when !== last ? when : null;
    last = when;
    const meta = [shown, proof(e.proof)].filter(Boolean);
    return h("li", { class: `ev ${TONE[e.phase] ?? ""}` },
      h("span", { class: "ev-dot", "aria-hidden": "true" }),
      h("div", {}, h("div", { class: "ev-title" }, sentence(e.title.replace(/ \(sim\)$/, ""))), meta.length ? h("div", { class: "ev-meta" }, meta) : null),
    );
  }));
}

function proof(p) {
  if (!p || p.startsWith("sim:")) return null;
  if (/^https?:\/\//.test(p)) return h("a", { href: p, target: "_blank", rel: "noopener noreferrer", class: "proof" }, "Proof", icon("ext", 12));
  return h("code", { class: "proof", title: p }, p.length > 18 ? `${p.slice(0, 10)}…${p.slice(-4)}` : p);
}

// ---------- one invoice, opened from an approval link ----------
function leaveFocus() {
  if (!state.focus) return;
  state.focus = null;
  history.replaceState(null, "", "/");
}

function focusView() {
  const item = state.inbox.find((i) => i.id === state.focus);
  return h("div", { class: "focus" },
    h("button", { class: "btn quiet back", onclick: () => { leaveFocus(); state.tab = "home"; render(); } }, icon("back", 16), "Home"),
    h("h2", { class: "hero-title" }, item && NEEDS(item) ? "Your say" : "Payment"),
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
      h("div", {}, h("h2", {}, "Inbox"), h("div", { class: "muted small" }, "Everything forwarded to Sayso, by email or by your agents. Nothing is paid until you tap.")),
      h("button", { class: "btn", onclick: () => { state.showAdd = !state.showAdd; render(); } }, state.showAdd ? "Close" : [icon("plus", 16), "Add invoice"]),
    ),
    state.showAdd ? addSheet() : null,
    h("div", { class: "list" },
      active.length ? active.map(invoiceCard) : h("div", { class: "empty" }, icon("check", 22), h("div", {}, "You're all caught up. Forward an invoice, or add one here.")),
      done.length ? h("h3", { class: "section sub-section" }, "Done") : null,
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
    h("div", { class: "meta" }, h("span", {}, agentOf(item) ? h("span", { class: "via" }, icon("bot", 14), `Forwarded by ${agentOf(item)}`) : sender(item.from)), h("span", {}, ago(item.receivedAt))),
    h("div", { class: "line" },
      h("div", { class: "what" }, known ? [h("span", { class: "amt" }, money(f.amount, f.currency)), " to ", f.payeeName ?? "someone"] : item.subject),
      h("span", { class: `pill ${tone}` }, label),
    ),
    h("div", { class: "sub" }, [f.reference && `Ref ${f.reference}`, f.dueDate && `Due ${f.dueDate}`, bankLine(f, item.status !== "needs_verification")].filter(Boolean).map((x) => h("span", {}, x))),
    item.status === "awaiting_approval" ? approveBlock(item) : null,
    item.status === "needs_verification" ? verifyBlock(item) : null,
    item.status === "needs_details" ? (state.open[item.id] ? detailsBlock(item)
      : [h("div", { class: "sub" }, `Sayso couldn't find the ${item.missing.join(", ")}.`), h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => { state.open[item.id] = true; render(); } }, "Add missing details"), ignoreButton(item))]) : null,
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
    h("button", { class: "btn pay", disabled: state.busy[key], onclick: () => { state.recent.add(item.id); act(key, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/approve`, {}), `Paying ${money(p.amount, p.currency)} to ${p.payee}.`); } }, state.busy[key] ? "Paying…" : `Pay ${money(p.amount, p.currency)}`),
    ignoreButton(item),
    h("span", { class: "muted small" }, `From your Airwallex balance by ${p.method === "SWIFT" ? "SWIFT" : "local transfer"}, about ${money(p.price_usdz, "USD")}.`),
  );
}

function verifyBlock(item) {
  const p = item.payout, f = item.fields, key = `pay:${item.id}`;
  const ok = Boolean(state.verified[item.id]);
  return [
    h("div", { class: "alert" },
      h("b", {}, icon("shield", 15), " Sayso is holding this one until you call."),
      p?.reasons?.length ? h("ul", {}, p.reasons.map((r) => h("li", {}, r))) : null,
      h("p", { style: "margin:8px 0 0" }, `Call ${f.payeeName ?? "the payee"} on a number you already had (not one from this email) and read them these details: `, h("code", {}, bankLine(f, false))),
    ),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: ok, onchange: (e) => { state.verified[item.id] = e.target.checked; render(); } }),
      h("span", {}, "I confirmed these bank details with the payee myself."),
    ),
    h("div", { class: "actions" },
      h("button", { class: "btn pay", disabled: !ok || state.busy[key], onclick: () => { state.recent.add(item.id); act(key, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/approve`, { verified_with_payee: true }), `Paying ${money(p.amount, p.currency)} to ${p.payee}.`); } }, `Pay ${money(p.amount, p.currency)}`),
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
    h("p", { class: "summary" }, `${delivered.length} delivered, ${moving.length} on the way, ${all.filter((p) => p.status === "refunded").length} bounced and refunded.`, delivered.length ? ` ${byCcy(delivered)} so far.` : ""),
    h("div", { class: "filters", style: "margin-bottom:12px" }, filters.map(([id, label]) => h("button", { class: "chip", "aria-pressed": String(state.filter === id), onclick: () => { state.filter = id; render(); } }, label))),
    h("div", { class: "list" }, shown.length ? shown.map(payoutRow) : h("div", { class: "empty" }, icon("payments", 22), h("div", {}, "Nothing here yet."))),
  );
}
function byCcy(ps) {
  const t = {};
  for (const p of ps) t[p.currency] = (t[p.currency] ?? 0) + Number(p.amount);
  return Object.entries(t).map(([c, a]) => money(a, c)).join(" · ");
}

// ---------- agents ----------
function agentsView() {
  const agentPays = state.payouts.filter((p) => p.source === "agent");
  const received = agentPays.filter((p) => p.status !== "refunded").reduce((s, p) => s + Number(p.price_usdz), 0);
  const swept = (state.summary?.sweeps ?? []).filter((s) => s.status === "credited").reduce((s, x) => s + x.amountMinor, 0) / 100;
  const origin = location.origin;
  const mcp = `claude mcp add sayso \\\n  -e SAYSO_URL=${origin} \\\n  -e SAYSO_BUYER_KEY=0x… \\\n  -e SAYSO_MAX_USDZ=500 \\\n  -- npx tsx src/mcp/server.ts`;
  const curl = `curl -X POST ${origin}/v1/quotes \\\n  -H 'content-type: application/json' \\\n  -d '{"amount":"180.00","currency":"EUR","reference":"Oct",\n       "payee":{"name":"Lingua Freelance","bank":{"iban":"FR14…"},\n       "bank_country_code":"FR","address":{"country_code":"FR","city":"Paris"}}}'`;
  return h("div", {},
    h("div", { class: "head" }, h("h2", {}, "Agents")),
    h("p", { class: "summary" }, `Agents have paid ${agentPays.length} ${agentPays.length === 1 ? "invoice" : "invoices"} with ${usdz(received)} over x402, and ${money(swept, "USD")} of Sayso's earnings has moved into Airwallex.`),
    connectAgents(origin),
    h("h3", { class: "section" }, "Recent agent payouts"),
    h("div", { class: "list" }, agentPays.length ? agentPays.slice(0, 10).map(payoutRow) : h("div", { class: "empty" }, "No agent has paid yet. Connect one above, and its payouts show up here.")),
    h("details", { class: "dev" },
      h("summary", {}, "Developer setup"),
      h("p", { class: "small muted" }, "For an agent with its own Metal wallet: it gets a free quote, pays the exact price over x402, and Metal won't sign above the cap you set."),
      snippet("Run the MCP server next to the agent", mcp),
      snippet("Or call the API", curl),
    ),
  );
}
function snippet(title, text) {
  return h("div", { class: "snippet" },
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
  return h("div", { class: "card connect" },
    h("h3", { class: "card-title" }, "Connect your agent"),
    h("p", { class: "small muted", style: "margin:4px 0 12px" }, "Claude, ChatGPT, OpenClaw, or the assistant you text from iMessage. It can forward invoices and check on payments. Approving stays with you."),
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
    live.length ? h("div", { class: "agent-list" }, live.map((a) => h("div", { class: "agent-row" },
      h("span", { class: "avatar" }, icon("bot", 16)),
      h("div", { class: "grow" }, h("b", {}, a.name), h("div", { class: "small muted" }, a.capMinor ? `Up to ${money(a.capMinor / 100, "USD")} per payout · ` : "", a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : "not used yet")),
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
