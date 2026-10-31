// Sayso, the app. No framework and no build step: a small element builder (text is always set
// as text, never as HTML, because invoice emails are written by strangers), state in one object,
// and a full re-render after each change. Live updates come from the server's event stream.

const $root = document.getElementById("root");
const state = {
  signedIn: null, me: null, inbox: [], payouts: [], summary: null, agents: [], newKey: null,
  claim: location.pathname === "/claim" ? new URLSearchParams(location.search).get("claim_attempt_token") : location.pathname.match(/^\/c\/([\w-]+)$/)?.[1] ?? null, claimInfo: null, laterPasskey: sessionGet("laterPasskey") === "1",
  home: { top: 0, open: null, from: null, shifted: false },
  connect: location.pathname.match(/^\/connect\/([\w-]+)$/)?.[1] ?? null, connectInfo: null,
  focus: decodeURIComponent(location.pathname.match(/^\/approve\/(.+)$/)?.[1] ?? "") || null,
  tab: sessionGet("tab") || "home", filter: "all", rows: new Set(), events: [], recent: new Set(),
  pick: null, showAdd: false, drafts: {}, verified: {}, open: {}, busy: {}, toast: null,
  say: { listening: false, text: "", result: null }, why: {},
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
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3",
  face: "M7 3H5a2 2 0 0 0-2 2v2 M17 3h2a2 2 0 0 1 2 2v2 M7 21H5a2 2 0 0 1-2-2v-2 M17 21h2a2 2 0 0 0 2-2v-2 M9 9v1.5 M15 9v1.5 M12 9v4h-1 M9 16c1.7 1.3 4.3 1.3 6 0",
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
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.need !== "passkey" && !path.startsWith("/auth/")) { state.signedIn = false; render(); throw new Error("signed out"); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- passkeys (Face ID, Touch ID, a fingerprint, a security key) ----------
const canPasskey = () => Boolean(window.PublicKeyCredential && navigator.credentials);
const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const creationOptions = (o) => PublicKeyCredential.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(o)
  : { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) }, excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: dec(c.id) })) };
const requestOptions = (o) => PublicKeyCredential.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(o)
  : { ...o, challenge: dec(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c) => ({ ...c, id: dec(c.id) })) };
function credentialJSON(c) {
  try { if (c.toJSON) return c.toJSON(); } catch { /* older browsers: build it by hand */ }
  const r = c.response;
  return { id: c.id, rawId: enc(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults(),
    response: r.attestationObject ? { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports?.() }
      : { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: r.userHandle ? enc(r.userHandle) : undefined } };
}
/** The browser's own Face ID / fingerprint sheet. Cancelling it throws a plain sentence. */
async function askDevice(kind, options) {
  try { return credentialJSON(await navigator.credentials[kind]({ publicKey: kind === "create" ? creationOptions(options) : requestOptions(options) })); }
  catch (e) { throw new Error(e?.name === "NotAllowedError" ? "Cancelled, so nothing changed." : e?.name === "InvalidStateError" ? "This device already has a Sayso passkey." : e?.message || "The passkey didn't work."); }
}
async function addPasskey() {
  const { challenge_id, options } = await api("/auth/passkey/register/options", {});
  await api("/auth/passkey/register", { challenge_id, response: await askDevice("create", options) });
  state.me = { ...state.me, passkeys: true, methods: { ...state.me?.methods, passkey: true } };
}
/** A passkey check bound to one action. Undefined while no passkey is set up (the server then doesn't ask). */
async function confirmWith(purpose, subject) {
  if (!state.me?.passkeys) return undefined;
  const { challenge_id, options } = await api("/auth/passkey/confirm/options", { purpose, subject });
  return { challenge_id, response: await askDevice("get", options) };
}
const approveInvoice = async (id, extra = {}) => api(`/v1/inbox/${encodeURIComponent(id)}/approve`, { ...extra, confirmation: await confirmWith("approve", id) });

async function load() {
  const [inbox, payouts, summary, agents, mailbox] = await Promise.all([api("/v1/inbox"), api("/v1/payouts"), api("/v1/summary"), api("/v1/agents"), api("/v1/mailbox").catch(() => null)]);
  const changed = JSON.stringify([inbox, payouts, summary, agents, mailbox]) !== JSON.stringify([state.inbox, state.payouts, state.summary, state.agents, state.mailbox]);
  Object.assign(state, { inbox, payouts, summary, agents, mailbox, signedIn: true });
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
  staggered = 0;
  const y = window.scrollY;
  $root.replaceChildren(...[state.signedIn === null ? h("div") : state.signedIn ? (state.claim ? claimView() : state.connect ? connectView() : appView()) : state.claim || state.connect ? claimGate() : landing(), state.toast ? h("div", { class: "toast", role: "status" }, state.toast) : null].filter(Boolean));
  window.scrollTo(0, y);
  if (!state.signedIn) watchReveals();
}
// Enter motion plays only the first time something appears (the set clears on a tab switch),
// and a status change flashes once. A full re-render would otherwise replay every animation.
const shown = new Set(), lastStatus = {};
let staggered = 0;
function motion(key, status) {
  let cls = "", style;
  if (!shown.has(key)) { shown.add(key); cls += " enter"; style = `--i:${Math.min(staggered++, 8)}`; }
  if (status !== undefined) { if (lastStatus[key] && lastStatus[key] !== status) cls += " flash"; lastStatus[key] = status; }
  return { cls, style };
}
document.addEventListener("focusout", () => setTimeout(() => { if (dirty) render(); }, 0));

function brand() { return h("div", { class: "brand" }, h("i", { "aria-hidden": "true" }), "sayso"); }

// ---------- the split-flap board: a verdict turns like a station departure board ----------
// One board per key survives re-renders (render() rebuilds the tree, the board element moves into
// it), so a verdict that changes flips letter by letter instead of being redrawn.
const FLAP_CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,€£$%+-:";
const stillMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const boards = new Map();
function flaps(key, text, { len = text.length, size = "", tone = "" } = {}) {
  let b = boards.get(key);
  if (!b || b.cells.length !== len) { b = makeFlaps(len, size); boards.set(key, b); }
  b.set(text, tone);
  return b.el;
}
function makeFlaps(len, size) {
  const el = h("span", { class: `flaps ${size}`, "aria-hidden": "true" });
  const cells = Array.from({ length: len }, () => {
    const c = h("span", { class: "cell" }, h("span", { class: "half t" }, h("span", {}, " ")), h("span", { class: "half b" }, h("span", {}, " ")));
    c.dataset.ch = " ";
    el.append(c);
    return c;
  });
  let shown = null;
  const set = (text, tone) => {
    if (tone !== undefined) el.dataset.tone = tone;
    const s = String(text).toUpperCase().padEnd(len).slice(0, len);
    if (s === shown) return;
    shown = s;
    cells.forEach((c, i) => { const tok = (c._tok = {}); setTimeout(() => turn(c, s[i], tok), i * 35); });
  };
  return { el, cells, set };
}
function showFlap(c, ch) { c.dataset.ch = ch; for (const s of c.querySelectorAll(".half > span")) s.textContent = ch; }
function flipOnce(c, next, ms) {
  return new Promise((done) => {
    const cur = c.dataset.ch;
    c.querySelector(".half.t span").textContent = next;
    c.querySelector(".half.b span").textContent = cur;
    const top = h("span", { class: "fl t", style: `--sp:${ms}ms` }, h("span", {}, cur));
    const bottom = h("span", { class: "fl b", style: `--sp:${ms}ms` }, h("span", {}, next));
    c.append(top, bottom);
    setTimeout(() => { top.remove(); bottom.remove(); showFlap(c, next); done(); }, ms * 2);
  });
}
async function turn(c, target, tok) {
  if (stillMotion || !c.isConnected) return showFlap(c, target);
  const from = Math.max(0, FLAP_CHARS.indexOf(c.dataset.ch)), to = Math.max(0, FLAP_CHARS.indexOf(target));
  // A drum only turns one way; a long turn shows its first and last few letters so it stays quick.
  const steps = [];
  for (let k = from; k !== to && steps.length < FLAP_CHARS.length;) { k = (k + 1) % FLAP_CHARS.length; steps.push(FLAP_CHARS[k]); }
  const path = steps.length > 9 ? [...steps.slice(0, 4), ...steps.slice(-5)] : steps;
  for (const ch of path) { if (c._tok !== tok) return; await flipOnce(c, ch, 55); }
}

// ---------- landing: the decision is the hero ----------
// The board asks the server's own decide() (POST /v1/decide/preview) what an agent would do with a
// sample €480 invoice, and plays a run of changes until a visitor grabs a control.
function landing() {
  return h("div", { class: "landing" },
    stage(),
    proveSection(),
    refusesSection(),
    signinSection(),
    footer(),
  );
}

let stageEl;
function stage() {
  if (stageEl) return stageEl;
  const st = { rate_drift_pct: 0.3, spendable_usdz: 820, risk: "allow", due_in_days: 6 };
  const COLORS = { pay: "pay", wait: "wait", split: "split", hold: "hold", reject: "hold" };
  const reason = h("p", { class: "b-reason", "aria-live": "polite" });
  const mode = h("span", { class: "b-live" }, "Playing a run");
  const val = {}, sub = {}, dial = {};
  const mk = (key, label, control, note) => {
    val[key] = h("div", { class: "d-val" }); sub[key] = h("div", { class: "d-sub" }, note ?? "");
    return (dial[key] = h("div", { class: "dial" }, h("div", { class: "d-label" }, h("span", {}, label), h("i", {}, "Decided it")), val[key], control, sub[key]));
  };
  const drift = h("input", { type: "range", id: "b-drift", min: -1, max: 4, step: 0.1, value: st.rate_drift_pct, "aria-label": "EUR rate against this week's median, percent", oninput: (e) => change({ rate_drift_pct: Number(e.target.value) }) });
  const spend = h("input", { type: "range", id: "b-spend", min: 0, max: 1000, step: 10, value: st.spendable_usdz, "aria-label": "USDZ the agent can spend", oninput: (e) => change({ spendable_usdz: Number(e.target.value) }) });
  const seg = (key, opts) => h("div", { class: "seg" }, opts.map(([v, label]) => h("button", { type: "button", "data-v": String(v), "aria-pressed": String(st[key] === v), onclick: () => change({ [key]: v }) }, label)));
  const risk = seg("risk", [["allow", "Paid before"], ["newbank", "New bank details"], ["mismatch", "Name mismatch"]]);
  const due = seg("due_in_days", [[6, "In 6 days"], [1, "Tomorrow"]]);
  const dials = h("div", { class: "dials" },
    mk("price", "Price", drift), mk("balance", "Balance", spend), mk("risk", "Risk", risk),
    mk("deadline", "Due", due, "A bill due within 2 days stops waiting for a better rate."));

  // where the money is: the agent's USDZ, escrow on Metal, the Airwallex payout, the payee's bank
  const POS = [6, 35, 65, 94];
  const nodes = POS.map((x) => h("span", { class: "node", style: `left:${x}%` }));
  const names = [["Metal", "Agent's USDZ"], ["Metal", "Escrow"], ["Airwallex", "EUR payout"], ["SEPA", "Payee's bank"]].map(([k, n], i) => h("span", { class: "node-l", style: `left:${POS[i]}%` }, h("small", {}, k), n));
  const coin = h("span", { class: "coin" }, h("span", { class: "tag" })), coin2 = h("span", { class: "coin hidden" }, h("span", { class: "tag" }));
  const track = h("div", { class: "track" }, h("span", { class: "line" }), nodes, names, coin, coin2);
  const railNote = h("p", { class: "rail-note" });
  let railTok = 0;
  const place = (c, x) => { c.style.left = `${x}%`; };
  const travel = (c, stops, tok) => stops.reduce((p, to) => p.then(() => new Promise((done) => {
    if (tok !== railTok) return done();
    const from = parseFloat(c.style.left) || POS[0];
    if (stillMotion) { place(c, to); nodes[POS.indexOf(to)].classList.add("lit"); return done(); }
    const t0 = performance.now();
    const step = (t) => {
      if (tok !== railTok) return done();
      const k = Math.min(1, (t - t0) / 650);
      place(c, from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step); else { nodes[POS.indexOf(to)].classList.add("lit"); done(); }
    };
    requestAnimationFrame(step);
  })), Promise.resolve());
  const tag = (c, t) => { c.firstChild.textContent = t; };
  function rail(d) {
    const tok = ++railTok, i = d.inputs;
    nodes.forEach((n) => n.classList.remove("lit", "shut"));
    coin.classList.remove("parked"); coin2.classList.remove("parked"); coin2.classList.add("hidden");
    place(coin, POS[0]); nodes[0].classList.add("lit"); tag(coin, `${i.price_usdz} USDZ`);
    if (d.verdict === "pay") {
      railNote.textContent = "Paid over x402 on Metal. It sits in escrow until Airwallex delivers, then it's released.";
      travel(coin, [POS[1]], tok).then(() => { if (tok === railTok) tag(coin, "€480.00"); return travel(coin, [POS[2], POS[3]], tok); })
        .then(() => { if (tok === railTok) railNote.textContent = "Delivered €480.00 by SEPA. The escrow is released to the ramp."; });
    } else if (d.verdict === "wait" && d.until?.rate_within_pct !== undefined) {
      railNote.textContent = `Paid into escrow on Metal. It stays there until the rate is back within ${d.until.rate_within_pct}%, or until ${new Date(d.until.by).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}.`;
      travel(coin, [POS[1]], tok).then(() => { if (tok === railTok) coin.classList.add("parked"); });
    } else if (d.verdict === "wait") {
      coin.classList.add("parked"); tag(coin, `${i.spendable_usdz} USDZ`);
      railNote.textContent = "Nothing moves until the next earnings sweep tops the budget up.";
    } else if (d.verdict === "split") {
      const [now, later] = d.tranches;
      coin2.classList.remove("hidden"); place(coin2, POS[0]); tag(coin2, `€${later.amount} later`); coin2.classList.add("parked");
      tag(coin, `€${now.amount}`);
      railNote.textContent = `€${now.amount} goes now. €${later.amount} follows the next earnings sweep.`;
      travel(coin, [POS[1], POS[2], POS[3]], tok);
    } else {
      nodes[2].classList.add("shut"); coin.classList.add("parked");
      railNote.textContent = "Nothing is paid. It waits for the owner's call.";
    }
  }

  const boardEl = h("div", { class: "board", role: "group", "aria-label": "What the agent decides" },
    h("div", { class: "b-head" }, h("span", {}, "INV-2026-114 · Kreuzberg Studio GmbH · €480.00 · forwarded by Claude"), mode),
    h("div", { class: "b-main" },
      h("div", { class: "b-verdict" }, flaps("land:verdict", "", { len: 5, size: "xl" })),
      h("div", { class: "b-why" },
        h("div", { class: "b-row" }, h("span", { class: "b-k" }, "Decided by"), flaps("land:by", "", { len: 8, size: "sm" })),
        h("div", { class: "b-row" }, h("span", { class: "b-k" }, "Costs"), flaps("land:cost", "", { len: 11, size: "sm" })),
        reason)),
    dials,
    h("div", { class: "rail" }, h("div", { class: "b-head" }, h("span", {}, "Where the money is"), h("button", { type: "button", class: "b-replay", onclick: () => play() }, "Replay")), track, railNote),
  );

  let lastVerdict = null, seq = 0;
  async function decideNow() {
    const mine = ++seq;
    let r;
    try { r = await api("/v1/decide/preview", st); } catch { return; }
    if (mine !== seq) return;
    const d = r.decision, i = d.inputs, tone = COLORS[d.verdict];
    boardEl.dataset.tone = tone;
    flaps("land:verdict", VERDICT[d.verdict] ?? d.verdict, { len: 5, size: "xl", tone });
    flaps("land:by", d.decided_by === "deadline" ? "DUE DATE" : d.decided_by, { len: 8, size: "sm" });
    flaps("land:cost", `${i.price_usdz} USDZ`, { len: 11, size: "sm" });
    const [lead, ...rest] = d.reason.split(":");
    reason.replaceChildren(h("b", {}, `${lead}:`), rest.join(":"));
    const decider = d.decided_by;
    for (const [k, el] of Object.entries(dial)) el.classList.toggle("decider", k === decider);
    val.price.textContent = `${r.rate.toFixed(4)} USD/EUR`;
    sub.price.textContent = `${st.rate_drift_pct >= 0 ? "+" : ""}${st.rate_drift_pct.toFixed(1)}% against this week's median of ${r.median}. Over +1.5% waits.`;
    val.balance.textContent = `${st.spendable_usdz} USDZ`;
    sub.balance.textContent = `What the agent can spend now. This bill costs ${i.price_usdz}.`;
    val.risk.textContent = st.risk === "allow" ? "Checks out" : "Held";
    sub.risk.textContent = st.risk === "allow" ? "The same account as the last paid invoice." : st.risk === "newbank" ? "The invoice asks to pay new bank details." : "The bank says the account is Mark Lehmann's.";
    val.deadline.textContent = st.due_in_days <= 1 ? "Tomorrow" : `In ${st.due_in_days} days`;
    for (const b of risk.children) b.setAttribute("aria-pressed", String(b.dataset.v === st.risk));
    for (const b of due.children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === st.due_in_days));
    drift.value = st.rate_drift_pct; spend.value = st.spendable_usdz;
    const key = `${d.verdict}:${d.until?.by ?? ""}:${d.tranches?.[0]?.amount ?? ""}`;
    if (key !== lastVerdict) { lastVerdict = key; rail(d); }
  }
  // The run: each beat changes one input, the way someone trying it would.
  const BEATS = [{ rate_drift_pct: 0.3, spendable_usdz: 820, risk: "allow", due_in_days: 6 }, { rate_drift_pct: 2.4 }, { due_in_days: 1 }, { rate_drift_pct: 0.3, due_in_days: 6, spendable_usdz: 310 }, { spendable_usdz: 820, risk: "newbank" }];
  let beat = 0, timer = null;
  function play() {
    clearTimeout(timer); beat = 0; mode.textContent = "Playing a run"; mode.classList.remove("you");
    const tick = () => { Object.assign(st, BEATS[beat]); decideNow(); beat = (beat + 1) % BEATS.length; timer = setTimeout(tick, 3800); };
    tick();
  }
  function change(c) {
    if (timer) { clearTimeout(timer); timer = null; mode.textContent = "You're driving"; mode.classList.add("you"); }
    Object.assign(st, c); decideNow();
  }
  play();

  stageEl = h("section", { class: "l-stage", id: "board" },
    h("div", { class: "stage-in" },
      h("header", { class: "l-top" }, brand(),
        h("nav", { class: "l-nav", "aria-label": "Sections" },
          h("a", { href: "#prove" }, "Prove it"), h("a", { href: "#refuses" }, "What it holds"),
          h("a", { class: "l-signin", href: "#signin", onclick: toToken }, "Sign in"))),
      h("div", { class: "l-hero-copy" },
        h("h1", {}, "Your agent wants to pay €480", h("br"), h("span", { class: "soft" }, "Sayso decides how")),
        h("div", { class: "l-side" },
          h("p", { class: "l-lede" }, "Price, balance and risk go in. Pay, wait, split or hold comes out, decided in code before a cent moves on Metal or Airwallex."),
          h("div", { class: "l-actions" },
            h("a", { class: "l-btn", href: "#signin", onclick: toToken }, "Open the demo"),
            h("a", { class: "l-btn quiet", href: "#prove" }, "See the proof"))),
      ),
      boardEl,
      h("p", { class: "l-rails" }, "Settles in USDZ on Metal testnet. Pays out in EUR, GBP and USD through the Airwallex sandbox. Asked from Claude, ChatGPT or any MCP agent."),
    ));
  return stageEl;
}
const toToken = () => setTimeout(() => document.getElementById("token")?.focus({ preventScroll: true }), 600);

// ---------- prove it: the chain of proof behind one payout ----------
// The receipt is hashed here, in the browser, exactly as Sayso hashes it (sorted keys, SHA-256), and
// compared with the hash the anchor transaction carries. Edit a field and the check fails.
async function receiptHash(r) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const SAMPLE_RECEIPT = { v: 1, payout: "68830b99-5c1e-4b7a-9d02-3f1c2a7e91aa", status: "paid", amount: "480.00", currency: "EUR", price_usdz: "521.92", payee_hash: "0x2c7e41d09b5f…91aa", reference: "INV-2026-114", funding_tx: "0x3f0b…77c1", airwallex_transfer_id: "tfr_8c21…", refund_tx: null, final_at: "2026-10-30T19:42:07.000Z" };
const CHAIN = [
  ["Sayso's signed offer", "521.92 USDZ for €480.00 to Kreuzberg Studio. Single use, so it can't be paid twice.", "Sayso"],
  ["The budget a person signed", "A Metal mandate whose only payee is Sayso: a cap per payment, a total and an expiry. The agent can't go past it.", "Owner"],
  ["Settled on Metal, checked four ways", "A successful receipt, the exact Transfer event, consensus finality and a durable event key.", "Metal"],
  ["The owner's tap", "A held invoice is paid only after a passkey approval, which an agent can't fake.", "Owner"],
  ["Delivered by Airwallex", "The payee's bank confirmed whose account it is before anything was paid.", "Airwallex"],
];
let proveEl;
function proveSection() {
  if (proveEl) return proveEl;
  const r = { ...SAMPLE_RECEIPT };
  let anchored = "";
  const hashOut = h("b", { class: "r-hash" }, "…");
  const anchorLine = h("div", { class: "hashline" });
  const verdict = h("span", { class: "v-line", role: "status" });
  const last = h("li", { class: "link" }, h("span", { class: "tick" }, "?"), h("div", {}, h("h3", {}, "Receipt anchored on chain"), h("p", {}, "Its SHA-256 is in a Metal transaction's data, after the tag SAYSO1. Anyone can check it."), anchorLine), h("span", { class: "who" }, "Anyone"));
  const rehash = async () => { hashOut.textContent = await receiptHash(r); };
  receiptHash(r).then((x) => { anchored = x; anchorLine.textContent = `anchor data: SAYSO1 ${x.slice(0, 18)}…${x.slice(-6)}`; rehash(); });
  const check = async () => {
    const ok = (await receiptHash(r)) === anchored;
    last.className = `link ${ok ? "ok" : "bad"}`; last.querySelector(".tick").textContent = ok ? "✓" : "✕";
    verdict.className = `v-line ${ok ? "ok" : "bad"}`;
    verdict.textContent = ok ? "Matches the chain. This is the receipt Sayso anchored." : "Doesn't match the chain. This receipt was changed.";
  };
  const rows = Object.entries(r).map(([k, v]) => [h("dt", {}, k), h("dd", {}, ["amount", "reference"].includes(k)
    ? h("input", { id: `r-${k}`, value: v, "aria-label": `Receipt ${k}`, oninput: (e) => { r[k] = e.target.value; rehash(); } })
    : String(v))]);
  return (proveEl = h("section", { id: "prove", class: "l-sheet" },
    h("div", { class: "sheet-in" },
      h("span", { class: "eyebrow" }, "Prove it"),
      h("h2", {}, "When an agent’s payment is questioned, Sayso shows its work"),
      h("p", { class: "lede" }, "For disputes and merchant checks. Every payout keeps a chain of proof anyone can check without trusting Sayso. Change a line of the receipt, then hash it again."),
      h("div", { class: "l-prove" },
        h("div", {},
          h("ol", { class: "chain" }, CHAIN.map(([t, p, who]) => h("li", { class: "link ok" }, h("span", { class: "tick" }, "✓"), h("div", {}, h("h3", {}, t), h("p", {}, p)), h("span", { class: "who" }, who))), last),
          h("div", { class: "verify" }, h("button", { type: "button", class: "btn pay", onclick: check }, "Hash the receipt and compare"), verdict)),
        h("div", { class: "receipt" },
          h("div", { class: "r-head" }, h("span", {}, "Receipt v1"), h("span", {}, "Sample")),
          h("dl", {}, rows),
          h("div", { class: "r-sum" }, h("span", {}, "sha256(sorted keys) ="), hashOut),
          h("p", { class: "r-hint" }, "The amount and reference are editable. In the app, every paid payout has its own receipt and anchor.")),
      ),
    )));
}

function refusesSection() {
  const refusals = [
    ["New bank details in an email", "The bank is asked whose account it is before a penny moves."],
    ["Pressure to pay today", "Urgency is a reason to slow down, so Sayso holds it."],
    ["A name the bank doesn't know", "If the account isn't the payee's, it waits for your call."],
    ["More than you allowed", "Each agent has a cap per payout, and Metal enforces its own."],
    ["The same invoice twice", "Airwallex dedupes every request, so a retry can't pay again."],
    ["Fees sent elsewhere", "Sayso's earnings sweep into its own Airwallex account only."],
  ];
  return h("section", { id: "refuses", class: "l-sheet" },
    h("div", { class: "sheet-in" },
      h("span", { class: "eyebrow" }, "Held every time"),
      h("h2", {}, "What it won't pay"),
      h("ul", { class: "refuse" }, refusals.map(([name, why]) => h("li", {}, h("h3", {}, name), h("p", {}, why)))),
    ));
}

const SIGNIN_NOTES = {
  expired: "That sign-in link has expired or was used already. Ask for a new one.",
  "google-not-owner": "That Google account isn't this Sayso's owner.", "google-failed": "Google sign-in didn't finish. Try again.", "google-off": "Google sign-in isn't set up here.",
};
async function signedIn() {
  state.me = await api("/auth/me");
  state.signedIn = true;
  await load(); goLive(); render(); window.scrollTo({ top: 0, behavior: "instant" });
}

/** Every way in, best first: a passkey, an emailed link, Google, then the owner token. */
function signinDialog() {
  const m = state.me?.methods ?? {};
  let token = "", email = "";
  const err = h("div", { class: "error", role: "alert" }, SIGNIN_NOTES[new URLSearchParams(location.search).get("signin")] ?? "");
  const note = h("p", { class: "small muted", role: "status" });
  const run = (fn) => async (e) => { e?.preventDefault(); err.textContent = ""; try { await fn(); } catch (x) { err.textContent = x.message === "wrong token" ? "That token isn't right." : x.message; } };
  const passkey = run(async () => {
    const { challenge_id, options } = await api("/auth/passkey/login/options", {});
    await api("/auth/passkey/login", { challenge_id, response: await askDevice("get", options) });
    await signedIn();
  });
  const mail = run(async () => { note.textContent = (await api("/auth/email", { email })).message; });
  const tokenIn = run(async () => { await api("/auth/login", { token }); await signedIn(); });
  const or = (t) => h("div", { class: "or" }, h("span", {}, t));
  return h("div", { class: "dialog", "data-ui": "" },
    h("h3", {}, state.claim || state.connect ? "Sign in to connect your agent" : "Sign in to Sayso"),
    m.passkey && canPasskey() ? h("button", { class: "btn pay wide", type: "button", onclick: passkey }, icon("face", 18), "Use Face ID or a passkey") : null,
    m.email ? h("form", { class: "row-form", onsubmit: mail },
      h("label", { class: "sr", for: "email" }, "Email"),
      h("input", { id: "email", class: "field", type: "email", autocomplete: "email", required: true, placeholder: "you@company.com", oninput: (e) => { email = e.target.value; } }),
      h("button", { class: m.passkey ? "btn" : "btn pay", type: "submit" }, "Email me a link")) : null,
    note,
    m.google ? h("a", { class: "btn wide google", href: "/auth/google" }, h("span", { class: "g", "aria-hidden": "true" }, "G"), "Continue with Google") : null,
    m.passkey || m.email || m.google ? or("or use the owner token") : null,
    h("form", { class: "row-form", onsubmit: tokenIn },
      h("label", { for: "token" }, "Owner token"),
      h("input", { id: "token", class: "field", type: "password", autocomplete: "current-password", placeholder: "Paste your token", oninput: (e) => { token = e.target.value; } }),
      h("button", { class: m.passkey || m.email ? "btn" : "btn pay", type: "submit" }, "Sign in")),
    m.demo ? h("p", { class: "small muted" }, "Running the offline demo? The token is ", h("code", {}, "sayso-demo"), ". Sign in with it, then turn on Face ID to try passkeys.") : null,
    err,
  );
}

function signinSection() {
  return h("section", { id: "signin", class: "cta" },
    h("div", { class: "cta-copy" },
      h("span", { class: "eyebrow" }, "Your say"),
      h("h2", {}, "Every held payment waits for one tap from you"),
      h("p", {}, "Sign in with Face ID or a fingerprint, then pay what your agents found, or hold it."),
    ),
    h("div", {}, signinDialog()),
  );
}

// ---------- an agent asking to connect (auth.md) ----------
function claimGate() {
  return h("div", { class: "gate" }, h("header", { class: "l-top" }, brand()), h("div", { class: "gate-body" }, signinDialog()));
}

function leaveClaim() { state.claim = null; state.claimInfo = null; history.replaceState(null, "", "/"); render(); }

function claimView() {
  const info = state.claimInfo;
  if (!info) {
    api(`/agent/identity/claim/attempt?t=${encodeURIComponent(state.claim)}`).then((i) => { state.claimInfo = i; render(); }).catch((e) => { state.claimInfo = { error: e.message }; render(); });
    return h("div", { class: "gate" }, h("header", { class: "l-top" }, brand()));
  }
  let code = "";
  const err = h("div", { class: "error", role: "alert" });
  const label = state.me?.passkeys ? "Confirm with Face ID" : canPasskey() ? "Turn on Face ID and connect" : "Connect";
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    state.busy.claim = true; render();
    try {
      if (!state.me?.passkeys && canPasskey()) await addPasskey();
      const confirmation = await confirmWith("claim", info.subject);
      await api("/agent/identity/claim/complete", { attempt_token: state.claim, user_code: code, confirmation });
      state.claimInfo = { ...info, status: "claimed" };
    } catch (x) { state.claimInfo = { ...info, lastError: x.message }; }
    finally { delete state.busy.claim; render(); }
  };
  const body = info.error ? [h("h2", {}, "This link has expired"), h("p", { class: "muted" }, info.error), h("button", { class: "btn", onclick: leaveClaim }, "Open Sayso")]
    : info.status !== "pending" ? [h("span", { class: "tick big-tick", "aria-hidden": "true" }, icon("check", 26)), h("h2", {}, `${info.agent_name} is connected`), h("p", { class: "muted" }, `Go back to ${info.agent_name}; it finishes on its own. It can forward and check invoices. Paying still needs you.`), h("button", { class: "btn pay", onclick: leaveClaim }, "Open Sayso")]
    : [
      h("span", { class: "agent-mark", "aria-hidden": "true" }, icon("bot", 24)),
      h("h2", {}, `Connect ${info.agent_name} to Sayso?`),
      h("p", { class: "muted" }, `${info.agent_name} asked to forward and check invoices for ${info.login_hint}. It can't pay anything: that stays with your face or fingerprint.`),
      h("form", { class: "claim-form", onsubmit: submit },
        h("label", { for: "user-code" }, "The code your agent showed you"),
        h("input", { id: "user-code", class: "field code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, required: true, placeholder: "123456", oninput: (e) => { code = e.target.value; } }),
        h("button", { class: "btn pay wide", type: "submit", disabled: state.busy.claim }, icon("face", 18), state.busy.claim ? "Checking…" : label),
      ),
      info.lastError ? h("div", { class: "error", role: "alert" }, info.lastError) : err,
      h("button", { class: "btn quiet", type: "button", onclick: leaveClaim }, "Not now"),
    ];
  return h("div", { class: "gate ink" }, h("header", { class: "l-top" }, brand()), h("div", { class: "gate-body" }, h("div", { class: "dialog claim", "data-ui": "" }, body)));
}

// ---------- a chat app signing in with Sayso (Claude, ChatGPT: the connector's sign-in) ----------
function connectView() {
  const info = state.connectInfo;
  const gate = (...body) => h("div", { class: "gate ink" }, h("header", { class: "l-top" }, brand()), h("div", { class: "gate-body" }, h("div", { class: "dialog claim", "data-ui": "" }, body)));
  if (!info) {
    api(`/oauth2/requests/${encodeURIComponent(state.connect)}`).then((i) => { state.connectInfo = i; render(); }).catch((e) => { state.connectInfo = { error: e.message }; render(); });
    return h("div", { class: "gate ink" }, h("header", { class: "l-top" }, brand()));
  }
  if (info.error) return gate(h("h2", {}, "This link has expired"), h("p", { class: "muted" }, info.error), h("button", { class: "btn", onclick: () => { state.connect = null; history.replaceState(null, "", "/"); render(); } }, "Open Sayso"));
  if (info.done) return gate(h("span", { class: "tick big-tick", "aria-hidden": "true" }, icon("check", 26)), h("h2", {}, `Going back to ${info.client_name}…`));
  const label = state.me?.passkeys ? "Allow with Face ID" : canPasskey() ? "Turn on Face ID and allow" : "Allow";
  const go = (path, confirm) => async () => {
    state.busy.connect = true; render();
    try {
      let confirmation;
      if (confirm) {
        if (!state.me?.passkeys && canPasskey()) await addPasskey();
        confirmation = await confirmWith("connect", info.subject);
      }
      const r = await api(`/oauth2/requests/${encodeURIComponent(state.connect)}/${path}`, confirm ? { confirmation } : {});
      state.connectInfo = { ...info, done: true }; render();
      location.assign(r.redirect);
    } catch (x) { state.connectInfo = { ...info, lastError: x.message }; }
    finally { delete state.busy.connect; render(); }
  };
  return gate(
    h("span", { class: "agent-mark", "aria-hidden": "true" }, icon("bot", 24)),
    h("h2", {}, `Connect ${info.client_name} to Sayso?`),
    h("p", { class: "muted" }, `${info.client_name} will see your Sayso inbox, forward invoices to it, and email suppliers from Sayso's address. It can't pay anyone: you approve every payment yourself.`),
    h("button", { class: "btn pay wide", type: "button", disabled: state.busy.connect, onclick: go("allow", true) }, icon("face", 18), state.busy.connect ? "Connecting…" : label),
    info.lastError ? h("div", { class: "error", role: "alert" }, info.lastError) : null,
    h("button", { class: "btn quiet", type: "button", disabled: state.busy.connect, onclick: go("deny", false) }, "Not now"),
    h("p", { class: "small muted" }, `You'll go back to ${info.returns_to}. Disconnect it any time under Agents.`),
  );
}

/** Offered once signed in, until there's a passkey: Face ID becomes the way in and the way to pay. */
/** A small header button until the owner has a passkey: approving with a face or fingerprint is something an agent can't fake. */
function passkeyButton(iconOnly = false) {
  if (!state.me || state.me.passkeys || !canPasskey()) return null;
  return h("button", { class: "btn quiet small faceid", title: "Sign in and approve payments with your face or fingerprint. An agent can't fake it.", disabled: state.busy.passkey, onclick: () => act("passkey", addPasskey, "Face ID is on. You'll use it to sign in and to pay.") },
    icon("face", iconOnly ? 20 : 16), iconOnly ? null : h("span", { class: "tab-label" }, "Turn on Face ID"));
}

function footer() {
  return h("footer", { class: "foot" }, h("div", { class: "foot-in" },
    h("div", { class: "ft-id" }, brand(), h("p", {}, "Agents pay real invoices. You keep the final say. Built for the Airwallex Agentic Banking Hackathon")),
    h("nav", { class: "ft-nav", "aria-label": "Footer" }, h("a", { href: "#board" }, "The board"), h("a", { href: "#prove" }, "Prove it"), h("a", { href: "/ops/" }, "Back office"), h("a", { href: "https://github.com/nice-bills/Sayso", rel: "noopener" }, "Source")),
    h("div", { class: "ft-mail" }, h("span", {}, "Forward invoices to"), h("a", { href: "mailto:sayso-invoices@agentmail.to" }, "sayso-invoices@agentmail.to")),
  ));
}

// Things marked data-reveal fade up as they enter the screen; html.js gates it so nothing hides without script.
document.documentElement.classList.add("js");
const viewer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    e.target.classList.add("in");
    if (e.target.hasAttribute("data-onview")) e.target.dispatchEvent(new Event("inview"));
    viewer.unobserve(e.target);
  }
}, { rootMargin: "0px 0px -12% 0px" }) : null;
function watchReveals() {
  for (const el of $root.querySelectorAll("[data-reveal]:not(.in), [data-onview]")) {
    if (viewer) viewer.observe(el);
    else { el.classList.add("in"); if (el.hasAttribute("data-onview")) el.dispatchEvent(new Event("inview")); }
  }
}

const NEEDS = (i) => ["needs_details", "awaiting_approval", "needs_verification"].includes(i.status);

function appView() {
  const needsYou = state.inbox.filter(NEEDS).length + reviewable().length;
  const tabs = [["home", "Home", "home", needsYou], ["inbox", "Inbox", "inbox", 0], ["payments", "Payments", "payments", 0], ["agents", "Agents", "bot", 0]];
  const s = state.summary;
  if (state.tab === "home" && !state.focus) return homeView();
  return h("div", { class: "shell" },
    h("header", { class: "top" }, h("div", { class: "wrap" },
      brand(),
      h("nav", { class: "tabs", role: "tablist" }, tabs.map(([id, label, ic, n]) => h("button", { class: "tab", role: "tab", "aria-selected": String(state.tab === id && !state.focus), onclick: () => { state.tab = id; sessionSet("tab", id); shown.clear(); leaveFocus(); render(); window.scrollTo(0, 0); } }, icon(ic, 20), h("span", { class: "tab-label" }, label), n ? h("span", { class: "count" }, n) : null))),
      h("div", { class: "top-right" },
        passkeyButton(),
        s?.balances?.USD ? h("span", { class: "bal" }, "Available ", h("b", {}, money(s.balances.USD / 100, "USD"))) : null,
        s ? h("span", { class: "mode", title: s.offline ? "Airwallex and Metal are simulated" : "Real Airwallex and Metal APIs" }, h("span", { class: `dot${s.offline ? "" : " live"}` }), s.offline ? "Offline demo" : s.sandbox ? "Sandbox" : "Live") : null,
        h("a", { class: "btn quiet icon-btn", href: "/ops/", target: "_blank", rel: "noopener", title: "Back office", "aria-label": "Back office" }, icon("ledger", 18)),
        h("button", { class: "btn quiet icon-btn", title: "Sign out", "aria-label": "Sign out", onclick: async () => { await api("/auth/logout", {}); state.me = await api("/auth/me").catch(() => state.me); state.signedIn = false; render(); } }, icon("out", 18)),
      ),
    )),
    h("div", { class: "wrap" },
      h("main", {}, state.focus ? focusView() : state.tab === "home" ? homeView() : state.tab === "inbox" ? inboxView() : state.tab === "payments" ? paymentsView() : agentsView()),
    ),
  );
}

// ---------- home: your balance, one card, and you say what you want ----------
// No buttons to learn. Hold the orb and say it; the words appear as they're heard, and one card
// shows how Sayso read them, where each detail came from, and the single thing to approve.
// Whatever already needs you (a held invoice, one ready to pay) sits in that same card.
// Home, after the mockup: the balance, the things that need you as a deck of colour cards (swipe for
// the next, tap to open one full screen), and a lime mic. Solid colours only: mint ground, lime while
// it listens, the card's own colour when open, green once paid.
const FLAP_WORD = { Held: ["HOLD", "hold"], Ready: ["PAY", "pay"], "Missing details": ["ASK", "wait"], Review: ["CHECK", "wait"] };
const CARD_TONE = { needs_verification: "ink", awaiting_approval: "lime", needs_details: "sky", paying: "green" };
function homeView() {
  const order = ["needs_verification", "awaiting_approval", "needs_details"];
  const s = state.say, r = s.result, hs = state.home;
  const needs = state.inbox.filter(NEEDS).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const queue = [...reviewable().map((p) => ({ key: p.id, payout: p })), ...needs.map((i) => ({ key: i.id, item: i }))];
  const sum = state.summary;
  const bal = sum?.balances?.USD;
  // What you just approved stays in view until it's paid, like a receipt.
  const done = state.inbox.find((i) => i.id === state.lastPaid && i.payout);
  const said = r?.item ? state.inbox.find((i) => i.id === r.item.id) ?? r.item : null;
  const open = queue.find((q) => q.key === hs.open);
  if (hs.open && !open) hs.open = null;
  const listening = s.listening || (state.busy.say && !r);
  const live = h("p", { class: `sh-heard${s.listening || s.text ? " on" : ""}`, id: "say-live", "aria-live": "polite" }, heardLine());
  const sheet = done && !r ? paidSheet(done)
    : r ? cardSheet("said", said ?? null, h("div", {}, live, replyLine(r)), said ? itemCard(said, r) : null)
    : open ? cardSheet(open.key, open.item ?? null, null, open.item ? itemCard(open.item) : h("div", { class: "card-x" }, payoutRow(open.payout, { open: true })))
    : null;
  return h("div", { class: `say-home${listening ? " listening" : ""}${firstShow("home") ? " enter" : ""}` },
    h("header", { class: "sh-top" },
      h("span", { class: "sh-mark" }, "sayso"),
      h("div", { class: "sh-icons" },
        sum?.offline ? h("span", { class: "sh-mode", title: "Airwallex and Metal are simulated" }, "Demo") : null,
        passkeyButton(true),
        h("button", { class: "sh-icon", title: "Everything: inbox, payments, agents", "aria-label": "Everything", onclick: () => { state.tab = "inbox"; sessionSet("tab", "inbox"); render(); window.scrollTo(0, 0); } }, icon("ledger", 20)),
      )),
    listening
      ? h("main", { class: "sh-main sh-listen" }, r ? null : live, h("div", { class: "wave", "aria-hidden": "true" }, Array.from({ length: 18 }, (_, i) => h("i", { style: `animation-delay:-${(i * 0.137) % 1}s` }))), replyLine(null))
      : h("main", { class: "sh-main" },
        h("div", { class: "sh-label" }, "Available"),
        h("div", { class: "sh-amount" }, bal != null ? money(bal / 100, "USD") : "…"),
        queue.length ? [h("div", { class: "sh-row" }, h("span", { class: "sh-label" }, queue.length === 1 ? "Needs you" : `${queue.length} need you`), queue.length > 1 ? h("span", { class: "sh-label" }, "Swipe for the next") : null), deck(queue)]
          : h("div", { class: "sh-clear" }, h("span", { class: "tick big-tick", "aria-hidden": "true" }, icon("check", 26)), h("b", {}, "Nothing needs you"), h("span", {}, "Say a payment, or forward an invoice to Sayso.")),
      ),
    h("footer", { class: "sh-foot" },
      !listening && !r ? live : null,
      s.typing ? h("form", { class: "sh-type", onsubmit: (e) => { e.preventDefault(); const t = e.target.elements.say.value.trim(); if (t) understand(t); } },
        h("input", { class: "field say-field", name: "say", autocomplete: "off", "aria-label": "Type a payment", placeholder: "Pay Kreuzberg Studio 280 euros", value: "", autofocus: true })) : null,
      h("button", { class: `mic${s.listening ? " on" : ""}${state.busy.say ? " busy" : ""}`, type: "button", "aria-label": s.listening ? "Stop listening" : "Hold to talk", "aria-pressed": String(s.listening), disabled: !s.engine,
        onpointerdown: (e) => { if (!s.listening) { e.preventDefault(); orbDown = performance.now(); startListening(); } },
        onpointerup: () => { if (s.listening && orbDown && performance.now() - orbDown > 400) stopListening(); orbDown = 0; },
        onclick: () => { if (s.listening && !orbDown) stopListening(); },
        onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); s.listening ? stopListening() : startListening(); } } }, icon(s.listening ? "hand" : "mic", 28)),
      h("div", { class: "sh-hint" },
        s.listening ? (s.engine === "whisper" ? "Whisper, on this device" : "Listening") : s.engine ? "Hold to talk" : "Type what to pay",
        " · ",
        h("button", { class: "linkish", type: "button", onclick: () => { s.typing = !s.typing; render(); if (s.typing) setTimeout(() => document.querySelector(".say-field")?.focus(), 0); } }, s.typing ? "hide keyboard" : "type instead")),
    ),
    sheet,
  );
}

/** The deck: the top card follows your finger; let go far enough and it flies off to the next one. */
function deck(queue) {
  const hs = state.home, len = queue.length, top = ((hs.top % len) + len) % len;
  const shift = hs.shifted && firstShow(`deck:${hs.top}`);
  const el = h("div", { class: `deck${shift ? " shift" : ""}` });
  const cards = queue.map((q, i) => {
    const rank = (i - top + len) % len, it = q.item, p = q.payout;
    const tone = it ? CARD_TONE[it.status] ?? "sky" : "ink";
    const tag = it ? (it.status === "needs_verification" ? "Held" : it.status === "awaiting_approval" ? "Ready" : "Missing details") : "Review";
    const amt = it ? (it.fields.amount && it.fields.currency ? money(it.fields.amount, it.fields.currency) : "A question") : money(p.amount, p.currency);
    const who = it ? it.fields.payeeName || sender(it.from) : p.payee;
    const sub = it ? (it.status === "needs_verification" ? (it.payout?.reasons?.[0] ?? "Asks to pay new bank details") : it.status === "needs_details" ? `Missing ${it.missing.slice(0, 3).join(", ")}` : agentOf(it) ? `${agentOf(it)} forwarded it` : `From ${sender(it.from)}`) : "An agent's payout, waiting for review";
    const c = h("button", { type: "button", class: `hc ${tone} k${Math.min(rank, 3)}`, "aria-label": `${tag}: ${amt} to ${who}. Opens it.`, tabindex: rank === 0 ? "0" : "-1" },
      h("span", { class: "hc-row" }, h("span", { class: "hc-who" }, who), flaps(`hc:${q.key}`, FLAP_WORD[tag][0], { len: 5, size: "xs", tone: FLAP_WORD[tag][1] })),
      h("span", { class: "hc-row end" }, h("span", {}, h("b", { class: "hc-amt" }, amt), h("span", { class: "hc-sub" }, sub)), h("span", { class: "hc-go", "aria-hidden": "true" }, icon("ext", 16))));
    c._rank = rank;
    let d = null, moved = false;
    c.addEventListener("pointerdown", (e) => { if (rank !== 0) return; d = { x: e.clientX, y: e.clientY, dx: 0, live: false }; try { c.setPointerCapture(e.pointerId); } catch {} });
    c.addEventListener("pointermove", (e) => {
      if (!d) return;
      d.dx = e.clientX - d.x;
      if (!d.live && Math.abs(d.dx) > 6 && Math.abs(d.dx) > Math.abs(e.clientY - d.y)) d.live = true;
      if (!d.live) return;
      const pr = Math.min(Math.abs(d.dx) / 140, 1);
      c.classList.add("drag"); c.style.transform = `translate(${d.dx}px, 32px) rotate(${(d.dx / 16).toFixed(2)}deg)`;
      for (const o of el.children) {
        if (o._rank === 1) { o.classList.add("drag"); o.style.transform = `translateY(${16 + 16 * pr}px) scale(${0.94 + 0.06 * pr})`; }
        if (o._rank === 2) { o.classList.add("drag"); o.style.transform = `translateY(${16 * pr}px) scale(${0.88 + 0.06 * pr})`; }
      }
    });
    const end = () => {
      if (!d) return;
      const was = d; d = null; moved = was.live;
      for (const o of el.children) { o.classList.remove("drag"); o.style.transform = ""; }
      if (was.live && Math.abs(was.dx) > 90 && len > 1) {
        c.classList.add(was.dx > 0 ? "outR" : "out");
        setTimeout(() => { hs.top += 1; hs.shifted = true; render(); }, 340);
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("click", () => {
      if (moved) { moved = false; return; }
      if (rank > 0) { hs.top += rank; hs.shifted = true; render(); return; }
      const rr = c.getBoundingClientRect();
      hs.from = { t: rr.top, b: innerHeight - rr.bottom, x: rr.left, r: innerWidth - rr.right };
      hs.open = q.key; render();
    });
    return c;
  });
  el.append(...cards.sort((a, b) => b._rank - a._rank));
  return el;
}

/** An open card: its colour fills the screen (it grows out of the card you tapped). */
function cardSheet(key, item, lead, body) {
  const hs = state.home, tone = item ? CARD_TONE[item.status] ?? "sky" : "ink";
  const grow = firstShow(`sheet:${key}:${item?.status ?? ""}`) && hs.from;
  const close = () => { if (key === "said") Object.assign(state.say, { result: null, text: "", interim: "" }); hs.open = null; hs.from = null; render(); };
  return h("div", { class: `osheet ${tone}${grow ? " grow" : ""}`, role: "dialog", "aria-label": item?.fields.payeeName ?? "Payment", style: grow ? `--t:${hs.from.t}px;--b:${hs.from.b}px;--x:${hs.from.x}px;--r:${hs.from.r}px` : "" },
    h("header", { class: "sh-top" }, h("button", { class: "sh-icon", "aria-label": "Back", onclick: close }, icon("back", 22)), h("span", { class: "sh-mark" }, "sayso"), h("span", { style: "width:38px" })),
    h("div", { class: "sheet-body sh-card" }, lead, body),
  );
}

/** After the tap: green floods in, then "Paid." */
function paidSheet(item) {
  return h("div", { class: `osheet green${firstShow(`paid:${item.id}`) ? " flood" : ""}` },
    h("header", { class: "sh-top" }, h("span", { class: "sh-mark" }, "sayso")),
    h("div", { class: "sheet-body sh-card" }, paidCard(item)));
}
let orbDown = 0;
const seenCards = new Set();
const firstShow = (key) => !seenCards.has(key) && seenCards.add(key);

/** What was heard: settled words in ink, words still being heard in grey. */
function heardLine() {
  const s = state.say;
  if (s.listening && !s.text && !s.interim) return h("span", { class: "tail" }, s.status || "Listening…");
  if (!s.text && !s.interim) return state.busy.say ? "" : h("span", { class: "tail" }, "Say who to pay, and how much.");
  return [s.text ? `“${s.text}` : "“", s.interim ? h("span", { class: "tail" }, (s.text ? " " : "") + s.interim) : null, s.listening ? "" : "”"];
}
function setLive() {
  const el = document.getElementById("say-live");
  if (el) { el.replaceChildren(...[heardLine()].flat().filter((x) => x != null && x !== "").map((x) => typeof x === "string" ? document.createTextNode(x) : x)); el.classList.toggle("on", true); }
}

/** Sayso's answer, in one sentence, under what you said. */
function replyLine(r) {
  if (state.busy.say) return h("p", { class: "sh-reply" }, h("i", { class: "dot" }), "Reading what you said…");
  if (!r) return null;
  const item = r.item ? state.inbox.find((i) => i.id === r.item.id) ?? r.item : null;
  const bank = r.understood.find((u) => u.field === "bank");
  const p = item?.payout;
  const text = r.problem ? r.problem
    : !item ? "I couldn't make that into a payment."
    : item.status === "awaiting_approval" ? `${money(p.amount, p.currency)} to ${p.payee}${/^your (earlier )?payment/.test(bank?.source ?? "") ? ", to the account you paid before" : ""}. Approve it and it goes.`
    : item.status === "needs_verification" ? "That invoice is on hold: it asks to pay new bank details."
    : item.status === "needs_details" ? "That invoice is missing details."
    : `That one's already ${INBOX_PILL[item.status]?.[0]?.toLowerCase() ?? item.status}.`;
  return h("p", { class: "sh-reply" }, h("i", { class: "dot" }), text,
    " ", h("button", { class: "linkish soft-link", type: "button", onclick: () => { Object.assign(state.say, { result: null, text: "", interim: "" }); render(); } }, "That's not what I said"));
}

/** One invoice as the tweet-style card: the amount, a few rows, one action. */
function itemCard(item, r) {
  const f = item.fields, p = item.payout;
  const src = (field) => { const u = r?.understood.find((x) => x.field === field); return u && u.source !== "you said" ? (u.source.startsWith("you said") ? u.source : `from ${u.source}`) : null; };
  const held = item.status === "needs_verification";
  const badge = held ? ["Held", "stop"] : item.status === "awaiting_approval" ? ["Ready", ""] : item.status === "needs_details" ? ["Missing details", "warn"] : INBOX_PILL[item.status] ?? [item.status, ""];
  const line = (k, v, note) => v ? h("div", { class: "kv" }, h("span", { class: "k" }, k), h("span", { class: "v" }, v, note ? h("small", {}, note) : null)) : null;
  const from = item.from === "You (said)" ? "You said it" : agentOf(item) ? `From ${agentOf(item)}` : sender(item.from);
  return h("article", { class: `pcard${held ? " held" : ""}`, "data-status": item.status },
    h("div", { class: "pc-head" }, h("span", { class: "pc-from" }, from), h("span", { class: `badge ${badge[1]}` }, badge[0])),
    f.amount && f.currency ? h("div", { class: "pc-amt" }, money(f.amount, f.currency)) : h("div", { class: "pc-amt small-amt" }, item.subject),
    h("div", { class: "kvs" },
      line("To", f.payeeName, src("payee")),
      line("Into", bankLine(f, !held) || null, src("bank")),
      line("Reference", f.reference, src("reference")),
      p && item.status === "awaiting_approval" ? line("From", `Airwallex, about ${money(p.price_usdz, "USD")}`) : null,
    ),
    p ? decisionCard(p) : null,
    item.status === "awaiting_approval" ? approveBlock(item)
      : held ? verifyBlock(item, true)
      : item.status === "needs_details" ? h("div", { class: "actions" }, h("button", { class: "btn pay wide", onclick: () => { state.open[item.id] = true; state.tab = "inbox"; render(); } }, "Add the missing details"), ignoreButton(item))
      : item.status === "paying" && p ? [timeline(p, true), whyButton(p.id), whyPanel(p.id)] : null,
  );
}

/** After the tap: the payment going through, then "Paid". */
function paidCard(item) {
  const p = item.payout, paid = p.status === "paid", failed = ["failed", "refunded", "refund_failed"].includes(p.status);
  return h("article", { class: "pcard paid" },
    h("div", { class: `paid-mark${paid ? " ok" : failed ? " bad" : ""}` }, paid ? icon("check", 34) : failed ? icon("hand", 30) : h("i", { class: "spin" })),
    h("b", { class: "paid-title" }, paid ? "Paid." : failed ? PAYOUT_PILL[p.status]?.[0] ?? "Bounced" : "Sending…"),
    h("div", { class: "paid-what" }, `${money(p.amount, p.currency)} ${paid ? "is on its way to" : "to"} ${p.payee}.`),
    h("div", { class: "paid-actions" }, whyButton(p.id), h("button", { class: "btn pay wide", onclick: () => { state.lastPaid = null; render(); } }, "Done")),
    whyPanel(p.id),
  );
}

// ---------- say it: what I heard, and what I understood ----------
// The browser transcribes (on device or through its speech service); the words appear as they are
// heard, then Sayso shows how it read them, field by field, and where each field came from. Bank
// details never come from speech. Nothing pays until you tap Pay and confirm with your passkey.
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const canRecord = !!navigator.mediaDevices?.getUserMedia && !!window.AudioContext;
let recog;
// Two ways to hear: the browser's own speech recognition (Chrome and Safari send the audio to Google
// or Apple), or Whisper running right here on the device. Whisper is the default where the browser
// has none (Firefox), and the owner can pick it anywhere.
const pref = (() => { try { return localStorage.getItem("sayso.voice"); } catch { return null; } })();
state.say.engine = pref === "browser" && Speech ? "browser" : pref === "whisper" || !Speech ? (canRecord ? "whisper" : null) : "browser";
function setEngine(engine) {
  state.say.engine = engine;
  try { localStorage.setItem("sayso.voice", engine); } catch {}
  render();
}
function startListening() {
  if (state.say.engine === "whisper") return void startWhisper();
  const s = state.say;
  recog = new Speech();
  recog.lang = navigator.language || "en-GB";
  recog.interimResults = true;
  recog.continuous = false;
  Object.assign(s, { listening: true, text: "", interim: "", result: null, status: "" });
  state.lastPaid = null;
  render();
  // The live words go straight into their element: a full re-render per syllable would flicker.
  recog.onresult = (e) => {
    const all = Array.from(e.results);
    s.text = all.filter((r) => r.isFinal).map((r) => r[0].transcript).join("").trim();
    s.interim = all.filter((r) => !r.isFinal).map((r) => r[0].transcript).join("").trim();
    setLive();
  };
  recog.onerror = (e) => { s.listening = false; toast(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Allow the microphone to say a payment, or type it." : e.error === "no-speech" ? "I didn't hear anything." : "I didn't catch that. Try again, or type it."); };
  recog.onend = () => { s.listening = false; const t = [s.text, s.interim].filter(Boolean).join(" "); s.interim = ""; if (t) understand(t); else render(); };
  try { recog.start(); } catch { s.listening = false; render(); }
}

let whisper; // { worker, ready, mb, waits }
function whisperWorker() {
  if (whisper) return whisper;
  const worker = new Worker("/whisper-worker.js", { type: "module" });
  whisper = { worker, ready: false, mb: 0, waits: new Map(), next: 1 };
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") { whisper.mb = data.mb; if (state.say.listening && !whisper.ready) { state.say.status = loadingLine(); setLive(); } }
    else if (data.type === "ready") whisper.ready = true;
    else if (data.id && whisper.waits.has(data.id)) { const w = whisper.waits.get(data.id); whisper.waits.delete(data.id); data.type === "error" ? w.reject(new Error(data.message)) : w.resolve(data.text); }
    else if (data.type === "error") toast("Whisper couldn't start here. Type the payment instead.");
  };
  worker.onerror = () => toast("Whisper couldn't start here. Type the payment instead.");
  worker.postMessage({ type: "load" });
  return whisper;
}
const loadingLine = () => `Getting Whisper onto this device${whisper?.mb ? ` (${whisper.mb} MB)` : ""}. Keep talking, I'm recording.`;
function transcribe(audio, rate) {
  const w = whisperWorker(), id = w.next++;
  return new Promise((resolve, reject) => { w.waits.set(id, { resolve, reject }); w.worker.postMessage({ type: "transcribe", id, audio, rate }); });
}

let stopWhisper = null;
async function startWhisper() {
  const s = state.say;
  Object.assign(s, { listening: true, text: "", interim: "", result: null, status: "" });
  state.lastPaid = null;
  render();
  const w = whisperWorker();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch { s.listening = false; render(); return toast("Allow the microphone to say a payment, or type it."); }
  s.status = w.ready ? "Listening…" : loadingLine();
  setLive();
  const ctx = new AudioContext();
  const rate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let length = 0, spoke = false, quietSince = 0, busy = false, done = false;
  const audio = () => { const out = new Float32Array(length); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };
  node.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(d); length += d.length;
    let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const loud = Math.sqrt(sum / d.length) > 0.012, now = performance.now();
    if (loud) { spoke = true; quietSince = 0; } else if (!quietSince) quietSince = now;
    // Stop after 1.8 s of quiet once something was said, or at 20 s.
    if ((spoke && quietSince && now - quietSince > 1800) || length > rate * 20) finish();
  };
  src.connect(node); node.connect(ctx.destination);
  // While talking, re-read everything so far about once a second: that's the live transcript.
  const live = setInterval(async () => {
    if (done || busy || !spoke || !w.ready) return;
    busy = true;
    try { const t = await transcribe(audio(), rate); if (!done && t) { s.interim = t; setLive(); } } catch {} finally { busy = false; }
  }, 900);
  async function finish() {
    if (done) return;
    done = true; stopWhisper = null;
    clearInterval(live);
    node.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close();
    if (!spoke) { s.listening = false; render(); return toast("I didn't hear anything."); }
    s.status = w.ready ? "Reading what you said…" : "Whisper is still downloading. I'll read what you said as soon as it's here.";
    setLive();
    try { s.text = await transcribe(audio(), rate); } catch { s.text = ""; }
    s.interim = "";
    s.listening = false;
    if (s.text) understand(s.text); else { render(); toast("I didn't catch that. Try again, or type it."); }
  }
  stopWhisper = finish;
}
function stopListening() {
  if (stopWhisper) stopWhisper(); else recog?.stop();
}
function understand(text) {
  document.activeElement?.blur?.();
  Object.assign(state.say, { text, interim: "", typing: false });
  act("say", async () => {
    state.say.result = await api("/v1/say", { transcript: text });
    // An invoice that still needs something opens as the main card under Needs you.
    const item = state.say.result.item;
    if (item && item.status !== "awaiting_approval" && NEEDS(item)) state.pick = item.id;
  });
}

const SAID = { payee: "Pay", amount: "Amount", reference: "Reference", bank: "Into" };

// ---------- why: every step behind a payment, with its proof ----------
const WHY = { heard: "You said", read: "Claude read", risk: "Rules", payee: "Bank", mandate: "Mandate", observe: "Seen", decide: "Decided", act: "Moved", reconcile: "Settled", escalate: "Flagged", refuse: "Refused", receipt: "Receipt" };
function whyButton(id) {
  const open = Boolean(state.why[id]);
  return h("button", { class: "btn quiet small why-btn", type: "button", disabled: state.busy[`why:${id}`], onclick: () => open ? (delete state.why[id], render()) : act(`why:${id}`, async () => { state.why[id] = await api(`/v1/payouts/${encodeURIComponent(id)}/why`); }) }, open ? "Hide why" : "Why?");
}
function whyPanel(id) {
  const w = state.why[id];
  if (!w) return null;
  return h("ol", { class: "why" }, w.steps.map((s) => h("li", { class: `why-step ${TONE[s.kind] ?? ""}` },
    h("span", { class: "why-dot", "aria-hidden": "true" }),
    h("div", { class: "why-body" },
      h("div", { class: "why-k" }, WHY[s.kind] ?? s.kind, h("span", { class: "why-when" }, ago(s.at))),
      h("div", { class: "why-t" }, sentence(s.title.replace(/ \(sim\)$/, ""))),
      s.kind === "mandate" && s.detail?.limits ? h("div", { class: "why-d" }, `Owner's limits: ${s.detail.limits.cap_usdz} USDZ a payment, ${s.detail.limits.budget_usdz} USDZ in total${s.detail.limits.expires_at ? `, until ${new Date(s.detail.limits.expires_at).toLocaleDateString()}` : ""}. Mandate `, h("code", {}, `${String(s.detail.ref).slice(0, 10)}…`)) : null,
      s.detail?.citations?.length ? h("div", { class: "why-d" }, s.detail.citations.map((c) => `“${c}”`).join("  ")) : null,
      s.detail?.hash ? h("div", { class: "why-d" }, "Receipt hash ", h("code", {}, `${String(s.detail.hash).slice(0, 14)}…`)) : null,
      proof(s.proof) ? h("div", { class: "why-d" }, proof(s.proof)) : s.proof?.startsWith("sim:") ? h("div", { class: "why-d" }, "Simulated") : null,
    ))));
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
    const m = motion(`ev:${e.at}${e.title}`);
    return h("li", { class: `ev ${TONE[e.phase] ?? ""}${m.cls}`, style: m.style },
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
  return h("div", { class: "page" },
    h("div", { class: "head" },
      h("div", {}, h("h2", {}, "Inbox"), h("div", { class: "muted small" }, "Forwarded by email or by your agents. Nothing is paid until you tap.")),
      h("button", { class: "btn small add-btn", onclick: () => { state.showAdd = !state.showAdd; render(); } }, state.showAdd ? "Close" : [icon("plus", 16), "Add"]),
    ),
    state.showAdd ? addSheet() : null,
    h("div", { class: "list" },
      active.length ? active.map(invoiceCard) : h("div", { class: "empty" }, icon("check", 22), h("div", {}, "You're all caught up. Forward an invoice, or add one here.")),
    ),
    done.length ? [h("h3", { class: "group" }, "Done", h("span", {}, done.length)), h("div", { class: "list rows" }, done.map(invoiceCard))] : null,
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

// An invoice that needs you is a full card in its state's colour: who sent it, the amount, the
// one thing to do. One that's finished folds to a line, like a payment; one still moving stays open.
function invoiceCard(item) {
  const f = item.fields, p = item.payout;
  const known = f.amount && f.currency;
  const [label, tone] = item.status === "paying" && p ? PAYOUT_PILL[p.status] ?? [p.status, ""] : INBOX_PILL[item.status] ?? [item.status, ""];
  const done = !ACTIVE.includes(item.status);
  const moving = item.status === "paying" && p && ["quoted", "accepted", "funded", "waiting", "submitted"].includes(p.status);
  const m = motion(`inv:${item.id}`, `${item.status}:${p?.status ?? ""}`);
  const who = agentOf(item) ? h("span", { class: "via" }, icon("bot", 14), `Forwarded by ${agentOf(item)}`) : h("span", {}, sender(item.from));
  const facts = [f.reference && `Ref ${f.reference}`, f.dueDate && `Due ${f.dueDate}`, bankLine(f, item.status !== "needs_verification")].filter(Boolean);
  const sub = facts.length ? h("div", { class: "sub" }, facts.map((x) => h("span", {}, x))) : null;
  if (done) {
    const open = moving || state.rows.has(item.id) || state.recent.has(item.id);
    const toggle = () => { state.rows.has(item.id) ? state.rows.delete(item.id) : state.rows.add(item.id); render(); };
    return h("article", { class: `inv done row${open ? " open" : ""}${m.cls}`, style: m.style, "data-status": item.status },
      h("button", { type: "button", class: "row-head", "aria-expanded": String(open), onclick: toggle },
        h("span", { class: `rh-mark v-${p?.decision?.verdict ?? "none"}`, "aria-hidden": "true" }, agentOf(item) ? icon("bot", 18) : (f.payeeName ?? sender(item.from) ?? "?").trim().charAt(0).toUpperCase()),
        h("span", { class: "rh-main" }, h("b", { class: "rh-who" }, known ? f.payeeName ?? "someone" : item.subject), h("span", { class: "rh-meta" }, [agentOf(item) ? `From ${agentOf(item)}` : null, f.reference, ago(item.receivedAt)].filter(Boolean).map((x) => h("span", {}, x)))),
        h("span", { class: "rh-end" }, known ? h("span", { class: "amt" }, money(f.amount, f.currency)) : null, h("span", { class: `pill ${tone}` }, label))),
      open ? h("div", { class: "row-body" },
        sub,
        item.status === "paying" && p ? [p.status === "paid" ? null : timeline(p, true), failure(p), whyButton(p.id), whyPanel(p.id)] : null,
        item.status === "rejected" && p?.reasons?.length ? h("div", { class: "alert" }, h("b", {}, "Sayso won't pay this: "), p.reasons.join("; ")) : null,
        item.status === "duplicate" ? h("div", { class: "note-line" }, "This matches an invoice already in your inbox, so it wasn't queued again.") : null,
      ) : null,
    );
  }
  return h("article", { class: `inv${m.cls}`, style: m.style, "data-status": item.status },
    h("div", { class: "meta" }, h("span", { class: "meta-who" }, agentOf(item) || sender(item.from) !== f.payeeName ? who : null, h("span", { class: "meta-when" }, ago(item.receivedAt))), h("span", { class: `pill ${tone}` }, label)),
    h("div", { class: "what" }, known ? [h("span", { class: "amt" }, money(f.amount, f.currency)), h("span", { class: "to" }, "to ", f.payeeName ?? "someone")] : item.subject),
    sub,
    item.status === "awaiting_approval" ? approveBlock(item) : null,
    item.status === "needs_verification" ? verifyBlock(item) : null,
    item.status === "needs_details" ? (state.open[item.id] ? detailsBlock(item)
      : [h("div", { class: "note-line" }, `Sayso couldn't find the ${item.missing.join(", ")}.`), h("div", { class: "actions" }, h("button", { class: "btn pay", onclick: () => { state.open[item.id] = true; render(); } }, "Add missing details"), ignoreButton(item))]) : null,
  );
}

function bankLine(f, masked) {
  const acct = f.iban ? `IBAN ${f.iban}` : f.accountNumber ? `${f.sortCode ? `Sort code ${f.sortCode}, ` : f.routingNumber ? `Routing ${f.routingNumber}, ` : ""}account ${f.accountNumber}` : "";
  if (!acct) return "";
  if (!masked) return acct;
  const digits = (f.iban ?? f.accountNumber).replace(/\s/g, "");
  return `${f.iban ? "IBAN" : "Account"} ending ${digits.slice(-4)}`;
}

/** Approving keeps the payment on Home as a receipt that turns into "Paid". */
function paidFrom(id) {
  state.recent.add(id);
  if (state.tab === "home") { state.lastPaid = id; state.home.open = null; Object.assign(state.say, { result: null, text: "", interim: "" }); }
}

function approveBlock(item) {
  const p = item.payout, key = `pay:${item.id}`;
  return h("div", { class: "actions" },
    h("button", { class: "btn pay", title: `From your Airwallex balance by ${p.method === "SWIFT" ? "SWIFT" : "local transfer"}, about ${money(p.price_usdz, "USD")}.`, disabled: state.busy[key], onclick: () => { paidFrom(item.id); act(key, () => approveInvoice(item.id)); } }, state.me?.passkeys ? icon("face", 18) : null, state.busy[key] ? "Paying…" : `Pay ${money(p.amount, p.currency)}`),
    ignoreButton(item),
  );
}

function verifyBlock(item, compact = false) {
  const p = item.payout, f = item.fields, key = `pay:${item.id}`, pc = item.penny, contact = item.contact_on_file;
  const ok = Boolean(state.verified[item.id]);
  const pay = (extra) => { paidFrom(item.id); act(key, () => approveInvoice(item.id, extra)); };
  const why = sentence((p?.reasons ?? []).join("; ") || "check the bank details with the payee") + ".";
  const head = compact ? h("p", { class: "pc-why" }, icon("shield", 15), why) : h("div", { class: "alert" }, h("b", {}, icon("shield", 15), " Held:"), "\u00a0" + why);
  if (pc?.status === "confirmed") return [
    h("div", { class: "alert ok" }, h("b", {}, icon("check", 15), ` ${pc.contact} confirmed the new details`), "\u00a0with the code from the 1-cent payment."),
    h("div", { class: "actions" }, h("button", { class: "btn pay", disabled: state.busy[key], onclick: () => pay({}) }, `Pay ${money(p.amount, p.currency)}`), ignoreButton(item)),
  ];
  if (pc?.status === "denied" || pc?.status === "failed") return [
    h("div", { class: "alert" }, h("b", {}, icon("hand", 15), pc.status === "denied" ? ` ${pc.contact} says these are not their bank details.` : " The payee never gave the right code."), " Don't pay this invoice; it is very likely fraud."),
    h("div", { class: "actions" }, ignoreButton(item)),
  ];
  const call = [
    h("p", { class: "small", style: "margin:0" }, `Or call ${f.payeeName ?? "the payee"} on a number you already had (not one from this email) and read them: `, h("code", {}, bankLine(f, false))),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: ok, onchange: (e) => { state.verified[item.id] = e.target.checked; render(); } }),
      h("span", {}, "I confirmed these bank details with the payee myself.")),
    h("div", { class: "actions" }, h("button", { class: "btn pay", disabled: !ok || state.busy[key], onclick: () => pay({ verified_with_payee: true }) }, `Pay ${money(p.amount, p.currency)}`), ignoreButton(item)),
  ];
  if (pc?.status === "sent") return [head,
    h("div", { class: "alert note" }, h("b", {}, "Waiting for the payee's code."), ` Sent 1 cent with a code to the account ending ${(f.iban ?? f.accountNumber ?? "").replace(/\s/g, "").slice(-4)}, and asked ${pc.contact} for it.`,
      pc.simStatementReference ? h("div", { class: "small", style: "margin-top:6px" }, "Demo: the payee's statement reads ", h("code", {}, pc.simStatementReference), ". ", h("a", { href: pc.simLink, target: "_blank", rel: "noopener" }, "Open the payee's page")) : null),
    h("details", {}, h("summary", { class: "small" }, "Can't wait? Call them instead"), call)];
  if (contact) return [head,
    h("div", { class: "actions" }, h("button", { class: "btn pay", title: `Sends 1 cent with a code to the new account, and asks ${contact} (from your earlier invoices, not this sender) for it. Only the account's real owner sees the code.`, disabled: state.busy[`penny:${item.id}`], onclick: () => act(`penny:${item.id}`, () => api(`/v1/inbox/${encodeURIComponent(item.id)}/penny`, {}), "Sent. Waiting for the payee's code.") }, state.busy[`penny:${item.id}`] ? "Sending…" : "Check with a 1-cent code"), ignoreButton(item)),
    h("p", { class: "small muted", style: "margin:0" }, `Sends 1 cent with a code to the new account. ${contact}, from your earlier invoices, has to read it back.`),
    h("details", {}, h("summary", { class: "small" }, "Or call them yourself"), call)];
  return [head, ...call];
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
// ---------- the decision: what the agent chose from price, balance and risk, and why ----------
const VERDICT = { pay: "Pay", wait: "Wait", split: "Split", hold: "Hold", reject: "Refuse" };
const FLAP_TONE = { pay: "pay", wait: "wait", split: "split", hold: "hold", reject: "hold" };
const DECIDED = { price: "price", deadline: "the due date", balance: "balance", risk: "risk" };
// One sentence first (the verdict and its reason), then the three things it weighed as a short
// list, the one that decided it marked. Proof and the what-if row sit under a hairline.
function decisionCard(p) {
  const real = p.decision;
  if (!real) return null;
  const sim = state.whatIf?.[p.id];
  const d = sim ?? real, i = d.inputs;
  const decider = d.decided_by === "deadline" ? "price" : d.decided_by;
  const factor = (key, label, value, ok, extra) => h("li", { class: `dc-f${ok ? "" : " off"}${decider === key ? " decider" : ""}` },
    h("span", { class: "dc-dot", "aria-hidden": "true" }, icon(ok ? "check" : "hand", 12)),
    h("span", { class: "dc-fk" }, label, decider === key ? h("span", { class: "dc-tag" }, "Decided it") : null),
    h("span", { class: "dc-fv" }, value),
    extra ?? null);
  const cap = Number(i.cap_usdz), price = Number(i.price_usdz);
  const priceOk = !(cap && price > cap) && i.rate_drift_pct <= 1.5;
  const priceText = cap ? [h("b", {}, i.price_usdz), ` of ${i.cap_usdz} USDZ`] : [h("b", {}, i.price_usdz), " USDZ"];
  const meter = cap ? h("span", { class: "dc-meter", "aria-hidden": "true" }, h("i", { style: `width:${Math.min(100, Math.max(2, (price / cap) * 100)).toFixed(1)}%` })) : null;
  const drift = i.rate_drift_pct > 0 ? h("span", { class: "dc-note" }, `Rate ${i.rate_drift_pct}% dearer than usual`) : null;
  const balOk = !i.spendable_usdz || Number(i.spendable_usdz) >= price;
  const proofs = sim ? [] : [["Metal", p.funding_tx], ["Airwallex", p.airwallex_transfer_id], ["Refund", p.refund_tx]].map(([k, v]) => [k, proof(v)]).filter(([, v]) => v);
  return h("section", { class: `decision v-${d.verdict}${sim ? " is-sim" : ""}`, "aria-label": `Decision: ${VERDICT[d.verdict]}` },
    h("div", { class: "dc-head" },
      flaps(`dc:${p.id}`, VERDICT[d.verdict], { len: 6, size: "md", tone: FLAP_TONE[d.verdict] }),
      h("span", { class: "dc-verdict sr" }, VERDICT[d.verdict]),
      sim ? h("span", { class: "dc-sim" }, "What if · nothing moves") : h("span", { class: "dc-by" }, `Decided by ${DECIDED[d.decided_by] ?? d.decided_by}`)),
    h("p", { class: "dc-reason" }, d.reason),
    h("ul", { class: "dc-factors" },
      factor("price", "Price", priceText, priceOk, [meter, drift]),
      factor("balance", "Balance", i.spendable_usdz ? [h("b", {}, i.spendable_usdz), " USDZ"] : "No budget set", balOk),
      factor("risk", "Risk", i.risk === "allow" ? "Clear" : i.risk === "hold" ? "Held" : "Refused", i.risk === "allow")),
    d.tranches ? h("p", { class: "dc-note" }, d.tranches.map((t) => `${money(t.amount, p.currency)} ${t.when === "now" ? "now" : "after the next sweep"}`).join(" · ")) : null,
    d.proposed_cap_usdz ? h("p", { class: "dc-note" }, `To pay it, raise the agent's cap to ${d.proposed_cap_usdz} USDZ on Metal. On the owner's machine: `, h("code", {}, `npm run setup:agent-budget -- --cap ${d.proposed_cap_usdz} --replaces .metal/agent-budget.json`)) : null,
    proofs.length ? h("div", { class: "dc-proof" }, h("span", { class: "dc-label" }, "Proof"), proofs.map(([k, v]) => h("span", { class: "dc-pf" }, h("span", {}, k), v))) : null,
    state.summary?.offline || state.summary?.sandbox ? whatIfPanel(p) : null,
  );
}
function whatIfPanel(p) {
  const key = `whatif:${p.id}`, cur = state.whatIfInput?.[p.id] ?? {};
  const run = (change) => {
    state.whatIfInput = { ...state.whatIfInput, [p.id]: { ...cur, ...change } };
    act(key, async () => { state.whatIf = { ...state.whatIf, [p.id]: (await api(`/v1/payouts/${encodeURIComponent(p.id)}/what-if`, state.whatIfInput[p.id])).decision }; });
  };
  const reset = () => { delete state.whatIf?.[p.id]; delete state.whatIfInput?.[p.id]; render(); };
  const chip = (label, change, on) => h("button", { type: "button", class: `chip${on ? " on" : ""}`, "aria-pressed": String(Boolean(on)), disabled: state.busy[key], onclick: () => run(change) }, label);
  return h("div", { class: "whatif" },
    h("div", { class: "wi-head" }, h("span", { class: "dc-label" }, "What if"), state.whatIf?.[p.id] ? h("button", { type: "button", class: "linkish wi-reset", onclick: reset }, "Back to real") : h("span", { class: "wi-hint" }, "Try one. Nothing moves.")),
    h("div", { class: "wi-chips" },
      chip("Rate 2% dearer", { rate_drift_pct: 2.1 }, cur.rate_drift_pct === 2.1),
      chip("Budget 190 USDZ", { spendable_usdz: 190 }, cur.spendable_usdz === 190),
      chip("New bank details", { risk: "hold" }, cur.risk === "hold"),
      chip("Known bank details", { risk: "allow" }, cur.risk === "allow")),
  );
}

const PAYOUT_PILL = {
  quoted: ["Waiting for payment", "info"], needs_review: ["Needs review", "warn"], rejected: ["Blocked", "stop"], accepted: ["Payment settling", "info"],
  funded: ["Paid, sending", "info"], waiting: ["Waiting in escrow", "warn"], submitted: ["On its way", "info"], paid: ["Delivered", "go"], failed: ["Bounced", "stop"],
  refunded: ["Bounced, refunded", "warn"], refund_failed: ["Refund failed", "stop"], expired: ["Expired", ""],
};

function timeline(p, inbox) {
  const done = { accepted: 0, funded: 1, waiting: 1, submitted: 2, paid: 3, failed: 2, refunded: 2, refund_failed: 2 }[p.status];
  if (done === undefined) return null; // not paid for yet
  const bounced = ["failed", "refunded", "refund_failed"].includes(p.status);
  const steps = [inbox ? "Approved" : "Paid in USDZ", "Sent by Airwallex", bounced ? "Bounced" : "Delivered"].map((label, i) => ({
    label, cls: bounced && i === 2 ? "bad" : i < done ? "done" : i === done ? "now" : "",
  }));
  if (p.status === "refunded") steps.push({ label: "Refunded in full", cls: "done" });
  if (p.status === "refund_failed") steps.push({ label: "Refund failed", cls: "bad" });
  if (p.status === "failed" && p.source === "agent") steps.push({ label: "Refunding", cls: "now" });
  return h("ol", { class: "steps", style: `grid-template-columns:repeat(${steps.length},minmax(0,1fr))`, "aria-label": "progress" }, steps.map((s) => h("li", { class: `step ${s.cls}` }, h("span", { class: "step-label" }, s.label))));
}

function failure(p) {
  if (!p.failure) return null;
  if (p.failure.startsWith("disputed: ")) return h("div", { class: "sub" }, `Disputed: ${p.failure.slice(10).replace(/\.$/, "")}. The agent got all ${usdz(p.price_usdz)} back.`);
  return h("div", { class: "sub" }, p.status === "refunded" && p.source === "agent" ? `The bank returned it (${p.failure.replace(/^bank returned it: /, "")}). The agent got all ${usdz(p.price_usdz)} back.` : `The bank returned it: ${p.failure.replace(/^bank returned it: /, "")}.`);
}

const linkedPayouts = () => new Set(state.inbox.map((i) => i.payoutId).filter(Boolean));
const reviewable = () => state.payouts.filter((p) => p.status === "needs_review" && !linkedPayouts().has(p.id));

// Collapsed, a payout is one line: who, how much, what Sayso decided, where it is. Tap it for the
// decision, the progress and the proof. One that needs you is open from the start.
function payoutRow(p, opts = {}) {
  const tapPending = linkedPayouts().has(p.id) && ["quoted", "needs_review"].includes(p.status);
  const [label, tone] = tapPending ? (p.status === "quoted" ? ["Waiting for your tap", "coin"] : ["Check before paying", "stop"])
    : p.status === "refunded" && p.failure?.startsWith("disputed: ") ? ["Disputed, refunded", "warn"] : PAYOUT_PILL[p.status] ?? [p.status, ""];
  const from = p.source === "agent" ? "Agent" : p.source === "inbox" || linkedPayouts().has(p.id) ? "Inbox" : "Quote";
  const needsYou = p.status === "needs_review" && !linkedPayouts().has(p.id);
  const open = opts.open || needsYou || state.rows.has(p.id);
  const m = motion(`pay:${p.id}`, p.status);
  const v = p.decision?.verdict;
  const toggle = () => { state.rows.has(p.id) ? state.rows.delete(p.id) : state.rows.add(p.id); render(); };
  const head = [
    v ? h("span", { class: `rh-chip`, "data-tone": FLAP_TONE[v], "aria-hidden": "true" }, VERDICT[v].toUpperCase()) : h("span", { class: "rh-mark v-none", "aria-hidden": "true" }, from === "Agent" ? icon("bot", 18) : (p.payee || "?").trim().charAt(0).toUpperCase()),
    h("span", { class: "rh-main" },
      h("b", { class: "rh-who" }, p.payee),
      h("span", { class: "rh-meta" },
        [from, p.created_at && ago(p.created_at)].filter(Boolean).map((x) => h("span", {}, x)))),
    h("span", { class: "rh-end" },
      h("span", { class: "amt" }, money(p.amount, p.currency)),
      h("span", { class: `pill ${tone}` }, label)),
  ];
  return h("article", { class: `row${open ? " open" : ""}${m.cls}`, style: m.style, "data-status": p.status },
    opts.open || needsYou ? h("div", { class: "row-head" }, head)
      : h("button", { type: "button", class: "row-head", "aria-expanded": String(open), onclick: toggle }, head),
    open ? h("div", { class: "row-body" },
      p.reference ? h("div", { class: "rb-ref" }, "Reference ", h("b", {}, p.reference)) : null,
      decisionCard(p),
      ["paid", "refunded", "expired", "rejected"].includes(p.status) ? null : timeline(p, from === "Inbox"),
      failure(p),
      needsYou ? reviewBlock(p) : null,
      p.status === "quoted" ? null : whyButton(p.id),
      whyPanel(p.id),
      state.why[p.id] ? h("dl", { class: "proofs" },
        prow("Payout id", p.id), prow("Method", p.method),
        from === "Agent" ? prow("Agent paid", `${usdz(p.price_usdz)} (fee ${usdz(p.fee_usdz)})`) : null,
        prow("Metal payment", p.funding_tx), prow("Airwallex transfer", p.airwallex_transfer_id), prow("Refund", p.refund_tx),
        p.reasons?.length ? prow("Why", p.reasons.join("; ")) : null,
      ) : null,
      from === "Agent" && ["paid", "refunded"].includes(p.status) ? provePanel(p) : null,
    ) : null,
  );
}
/**
 * "Prove it": what Sayso can show about an agent's payout, piece by piece, and the disputes on it.
 * A dispute names its claim and the rules settle it from this proof; one they can't settle waits here.
 */
const CLAIM_CHIPS = [["not_authorized", "Wasn't allowed"], ["wrong_amount", "Charged too much"], ["not_delivered", "Never arrived"], ["wrong_payee", "Wrong account"], ["other", "Something else"]];
const DISPUTE_VERDICT = { denied: ["Denied", "go"], upheld: ["Upheld, refunded", "warn"], review: ["Needs you", "warn"], refunded_by_owner: ["You refunded it", "warn"], denied_by_owner: ["You kept it", "go"] };
function provePanel(p) {
  const key = `prove:${p.id}`, proof = state.proof?.[p.id];
  const load = () => act(key, async () => { state.proof = { ...state.proof, [p.id]: await api(`/v1/payouts/${encodeURIComponent(p.id)}/proof`) }; });
  if (!proof) return h("div", { class: "prove" }, h("button", { type: "button", class: "btn quiet small", disabled: state.busy[key], onclick: load }, "Prove it"));
  const file = (claim) => act(key, async () => {
    await api(`/v1/payouts/${encodeURIComponent(p.id)}/disputes`, { claim, by: "the paying agent" });
    state.proof[p.id] = await api(`/v1/payouts/${encodeURIComponent(p.id)}/proof`);
  });
  const keep = () => act(key, async () => {
    await api(`/v1/payouts/${encodeURIComponent(p.id)}/dispute/deny`, {});
    state.proof[p.id] = await api(`/v1/payouts/${encodeURIComponent(p.id)}/proof`);
  }, "Kept. The payout stands.");
  const mark = { proven: "✓", against: "✕", missing: "–" };
  const last = proof.disputes.at(-1);
  const open = last?.verdict === "review";
  return h("div", { class: "prove" },
    h("div", { class: "wi-head" }, h("span", { class: "dc-label" }, "Prove it"), h("button", { type: "button", class: "linkish wi-reset", onclick: () => { delete state.proof[p.id]; render(); } }, "Hide")),
    h("ol", { class: "pv-list" }, proof.evidence.map((e) => h("li", { class: `pv-item pv-${e.status}` },
      h("span", { class: "pv-mark", "aria-label": e.status }, mark[e.status]),
      h("span", { class: "pv-body" }, h("b", {}, e.title), h("span", {}, e.detail), e.link ? h("a", { href: e.link, target: "_blank", rel: "noopener" }, "See it on Metal") : null)))),
    h("div", { class: "pv-hash" }, "Proof hash ", h("code", {}, `${proof.hash.slice(0, 10)}…${proof.hash.slice(-6)}`)),
    proof.disputes.map((d) => h("div", { class: "pv-dispute" },
      h("span", { class: `pill ${DISPUTE_VERDICT[d.verdict]?.[1] ?? ""}` }, DISPUTE_VERDICT[d.verdict]?.[0] ?? d.verdict),
      h("span", {}, h("b", {}, `${proof.claims[d.claim]}. `), d.reason, d.anchor_tx?.startsWith("0x") ? h("a", { href: `https://testnet.metalntwx.com/tx/${d.anchor_tx}`, target: "_blank", rel: "noopener" }, " Anchored on Metal") : null))),
    p.status === "paid" ? h("div", { class: "actions" }, disputeButton(p), open ? h("button", { type: "button", class: "btn quiet small", disabled: state.busy[key], onclick: keep }, "Keep the payout") : null) : null,
    p.status === "paid" && !open ? h("div", { class: "pv-try" },
      h("span", { class: "wi-hint" }, "Dispute it as the agent would. The rules answer from the proof above."),
      h("div", { class: "wi-chips" }, CLAIM_CHIPS.map(([c, label]) => h("button", { type: "button", class: "chip", disabled: state.busy[key], onclick: () => file(c) }, label)))) : null,
  );
}

/** The owner upholds an agent's dispute: the agent gets every cent back under the refund mandate. */
function disputeButton(p) {
  const key = `dispute:${p.id}`;
  return h("button", { class: "btn quiet small", type: "button", disabled: state.busy[key], onclick: () => {
    const reason = window.prompt("Why was this payout wrong? The agent gets its USDZ back.");
    if (reason?.trim()) act(key, async () => api(`/v1/payouts/${encodeURIComponent(p.id)}/dispute`, { reason: reason.trim(), confirmation: await confirmWith("dispute", p.id) }), "Refunded to the agent.");
  } }, `Refund the agent ${usdz(p.price_usdz)}`);
}
function prow(k, v) { return v ? h("div", { class: "kv" }, h("dt", { class: "k" }, k), h("dd", { class: "v" }, h("code", {}, String(v)))) : null; }

function reviewBlock(p) {
  const key = `review:${p.id}`;
  const go = (decision) => act(key, async () => api(`/v1/payouts/${encodeURIComponent(p.id)}/review`, { decision, confirmation: decision === "reject" ? undefined : await confirmWith("review", p.id) }), decision === "reject" ? "Blocked." : "Approved. The agent can pay it now.");
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
  const bounced = all.filter((p) => ["failed", "refunded", "refund_failed"].includes(p.status));
  const rec = state.summary?.reconcile;
  const waitsForYou = (p) => ["quoted", "needs_review"].includes(p.status) && (linked.has(p.id) || p.status === "needs_review");
  const needs = shown.filter(waitsForYou), rest = shown.filter((p) => !waitsForYou(p));
  const stat = (n, label, tone) => h("div", { class: `stat ${tone}` }, h("b", {}, n), h("span", {}, label));
  return h("div", { class: "page" },
    h("div", { class: "head" }, h("div", {}, h("h2", {}, "Payments"),
      h("div", { class: "muted small" }, rec ? (rec.ok ? "Books reconcile to the cent." : "Books don't reconcile. Check the back office.") : "Every payout, from agents and from your inbox."))),
    h("div", { class: "stats" }, stat(delivered.length, "Delivered", "go"), stat(moving.length, "On the way", ""), stat(bounced.length, "Bounced", bounced.length ? "stop" : "")),
    delivered.length ? h("p", { class: "stats-note" }, `${byCcy(delivered)} delivered so far.`) : null,
    h("div", { class: "filters", role: "group", "aria-label": "Show" }, filters.map(([id, label]) => h("button", { class: "chip", "aria-pressed": String(state.filter === id), onclick: () => { state.filter = id; render(); } }, label))),
    shown.length ? [
      needs.length ? [h("h3", { class: "group" }, "Needs you", h("span", {}, needs.length)), h("div", { class: "list rows" }, needs.map((p) => payoutRow(p)))] : null,
      rest.length ? [needs.length ? h("h3", { class: "group" }, "Earlier") : null, h("div", { class: "list rows" }, rest.map((p) => payoutRow(p)))] : null,
    ] : h("div", { class: "empty" }, icon("payments", 22), h("div", {}, "Nothing here yet.")),
    h("details", { class: "happening" }, h("summary", {}, "What's happening, step by step"), activityFeed()),
  );
}
function byCcy(ps) {
  const t = {};
  for (const p of ps) t[p.currency] = (t[p.currency] ?? 0) + Number(p.amount);
  return Object.entries(t).map(([c, a]) => money(a, c)).join(", ");
}

// ---------- agents ----------
function agentsView() {
  const agentPays = state.payouts.filter((p) => p.source === "agent");
  const origin = location.origin;
  const mcp = `claude mcp add sayso \\\n  -e SAYSO_URL=${origin} \\\n  -e SAYSO_BUYER_KEY=0x… \\\n  -e SAYSO_MAX_USDZ=500 \\\n  -- npx tsx src/mcp/server.ts`;
  const curl = `curl -X POST ${origin}/v1/quotes \\\n  -H 'content-type: application/json' \\\n  -d '{"amount":"180.00","currency":"EUR","reference":"Oct",\n       "payee":{"name":"Lingua Freelance","bank":{"iban":"FR14…"},\n       "bank_country_code":"FR","address":{"country_code":"FR","city":"Paris"}}}'`;
  return h("div", { class: "page agents-page" },
    h("div", { class: "head" }, h("h2", {}, "Agents")),
    mailboxBox(),
    escrowBox(),
    agentPays.length ? [h("h3", { class: "section" }, "Recent agent payouts"), h("div", { class: "list" }, agentPays.slice(0, 10).map((p) => payoutRow(p)))] : null,
    connectAgents(origin),
    h("details", { class: "dev" },
      h("summary", {}, "Developer setup"),
      h("p", { class: "small muted" }, "For an agent with its own Metal wallet: it gets a free quote, pays the exact price over x402, and Metal won't sign above the cap you set."),
      snippet("Run the MCP server next to the agent", mcp),
      h("p", { class: "small muted" }, "Better: the agent's owner gives it a budget on Metal (Sayso as the only payee, a cap per payment, a total), and the agent pays from the owner's account. Metal refuses anything outside it."),
      snippet("The owner binds a budget, then the agent uses it", `SAYSO_PAY_TO=${state.summary?.pay_to ?? "<pay_to from /healthz>"} npm run setup:agent-budget -- --cap 250 --budget 1000 --days 30\n\nclaude mcp add sayso -e SAYSO_URL=${origin} \\\n  -e SAYSO_MANDATE=.metal/agent-budget.json -- npx tsx src/mcp/server.ts`),
      snippet("Or call the API", curl),
    ),
  );
}
// Sayso's own email address: invoices go to it, and agents send from it, so nobody sets up email.
function mailboxBox() {
  const m = state.mailbox;
  if (!m?.address) return null;
  const verify = (e) => {
    e.preventDefault();
    act("mailcode", async () => { await api("/v1/mailbox/verify", { code: state.mailCode ?? "" }); state.mailCode = ""; }, "Sayso can email people now");
  };
  return h("div", { class: "card" },
    h("div", { class: "lbl" }, "Sayso's email"),
    h("b", {}, m.address),
    h("p", { class: "small muted", style: "margin:6px 0 0" }, "Forward invoices here. Claude, ChatGPT and your other agents send and reply from this address through Sayso, so you don't connect another email."),
    m.can_send ? null : h("form", { class: "mail-code", onsubmit: verify, style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center" },
      h("p", { class: "small", style: "margin:0;flex-basis:100%" }, m.needs),
      h("input", { class: "field", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "6-digit code", "aria-label": "Code from AgentMail", value: state.mailCode ?? "", oninput: (e) => { state.mailCode = e.target.value.replace(/\D/g, ""); }, style: "max-width:160px" }),
      h("button", { class: "btn pay", type: "submit", disabled: state.busy.mailcode }, state.busy.mailcode ? "Checking…" : "Turn on sending")),
  );
}
function escrowBox() {
  const e = state.summary?.escrow;
  if (!e) return null;
  const m = state.summary.mandates;
  return h("div", { class: "card escrow" },
    h("div", { class: "esc" }, h("div", {}, h("div", { class: "lbl" }, "In escrow on Metal"), h("b", {}, usdz(e.heldMinor / 100)), h("div", { class: "small muted" }, e.heldPayouts ? `behind ${e.heldPayouts} ${e.heldPayouts === 1 ? "payout" : "payouts"} on their way` : "nothing on its way")),
      h("div", {}, h("div", { class: "lbl" }, "Earned by delivered payouts"), h("b", {}, usdz(e.deliveredMinor / 100)), h("div", { class: "small muted" }, `${usdz(e.sweptMinor / 100)} released to Airwallex`))),
    h("p", { class: "small muted", style: "margin:10px 0 0" }, "Released only when a payout is delivered; a bounce goes back to the agent. Metal enforces both.",
      m === "required" ? " Agents must pay under a budget their owner set on Metal." : ""),
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
    h("div", { class: "authmd" }, h("b", {}, "Easiest: let it sign itself up"), h("p", { class: "small muted" }, "Tell your agent: ", h("code", {}, `Connect to Sayso using ${origin}/auth.md`), ". It shows you a code; you enter it here and confirm with Face ID.")),
    h("p", { class: "small muted", style: "margin:14px 0 10px" }, "Or make a key and paste it into the agent yourself:"),
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
      h("div", { class: "grow" }, h("b", {}, a.name), h("div", { class: "small muted" }, a.capMinor ? `Up to ${money(a.capMinor / 100, "USD")} per payout, ` : "", a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : "not used yet")),
      h("button", { class: "btn quiet danger", disabled: state.busy[`revoke:${a.id}`], onclick: () => act(`revoke:${a.id}`, () => api(`/v1/agents/${encodeURIComponent(a.id)}/revoke`, {}), `Disconnected ${a.name}.`) }, "Disconnect"),
    ))) : null,
  );
}

// ---------- start ----------
(async () => {
  try {
    const me = await api("/auth/me");
    state.me = me;
    state.signedIn = me.owner;
    if (me.owner) { await load(); goLive(); }
  } catch { state.signedIn = false; }
  render();
})();
