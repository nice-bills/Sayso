// The landing page. Four moves do the work: a graded street film behind the hero, one word that
// swaps on a timer, one pinned scroll where the headline dissolves into the dashboard, and Lenis
// for damped scrolling. Everything else is a plain fade-and-rise as it enters the screen.
import Lenis from "/vendor/lenis/lenis.mjs";
import { h, state, brand, stage, proveSection, signinDialog, toApp, openApp, stillMotion } from "/app.js";
import { LOGOS } from "/logos.js";

// Static, trusted markup only (marks and wireframes); never anything a stranger wrote.
const tpl = document.createElement("template");
function svg(markup) { tpl.innerHTML = markup.trim(); return tpl.content.firstChild.cloneNode(true); }
function mark(name, size = 22, color = "currentColor") {
  return svg(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" class="lp-mark"><path fill="${color}" d="${LOGOS[name]}"/></svg>`);
}

// ---------- the rotating name ----------
const SLOT = [["Claude", "claude", "#D97757"], ["Codex", "openai", "#ffffff"], ["Cursor", "cursor", "#ffffff"], ["Copilot", "copilot", "#ffffff"]];
let slotAt = 0;
function slot() {
  return h("span", { class: "lp-slot", "aria-hidden": "true" },
    SLOT.map(([name, logo, color], i) => h("span", { class: `lp-slot-i${i === slotAt ? " on" : ""}` }, mark(logo, 0, color), h("span", {}, name))));
}
function sizeSlot() {
  const s = document.querySelector(".lp-slot"), on = s?.querySelector(".on");
  if (on) s.style.width = `${on.offsetWidth}px`;
}
setInterval(() => {
  const items = document.querySelectorAll(".lp-slot-i");
  if (!items.length || document.hidden) return;
  items[slotAt]?.classList.remove("on");
  slotAt = (slotAt + 1) % SLOT.length;
  items[slotAt]?.classList.add("on");
  sizeSlot();
}, 2600);

// ---------- nav ----------
const LINKS = [["#how", "How it works"], ["#uses", "Use cases"], ["#clients", "Clients"], ["#questions", "FAQ"]];
// On a phone the section links fold into a menu; it toggles a class, so opening it never re-renders.
function setMenu(open) {
  const nav = document.querySelector(".lp-nav");
  nav?.classList.toggle("open", open);
  nav?.querySelector(".lp-burger")?.setAttribute("aria-expanded", String(open));
}
function nav() {
  return h("header", { class: "lp-nav" },
    h("a", { href: "#top", class: "lp-brand", "aria-label": "Sayso, back to top" }, brand()),
    h("nav", { class: "lp-links", id: "lp-links", "aria-label": "Sections" }, LINKS.map(([href, label]) => h("a", { href, onclick: () => setMenu(false) }, label))),
    h("span", { class: "lp-nav-end" },
      h("a", { class: "lp-pill solid small", href: "#signin", onclick: toApp }, state.signedIn ? "Open the app" : "Sign in"),
      h("button", { type: "button", class: "lp-burger", "aria-label": "Menu", "aria-controls": "lp-links", "aria-expanded": "false",
        onclick: () => setMenu(!document.querySelector(".lp-nav")?.classList.contains("open")) }, h("i"), h("i"))));
}

// ---------- 1–2: the film hero, pinned into the dashboard ----------
// Built once, so a re-render (a toast, a sign-in) never restarts the film.
let filmEl;
function film() {
  if (filmEl) return filmEl;
  // night.mp4 is cut so its last second crossfades into its first: the loop has no seam and no black frame.
  const video = h("video", { src: "/film/night.mp4", poster: "/film/night.jpg", loop: "", playsinline: "", preload: "auto" });
  video.muted = true;
  if (!stillMotion) video.autoplay = true;
  return (filmEl = h("div", { class: "lp-film", "aria-hidden": "true" }, video, h("i", { class: "lp-grade" }), h("i", { class: "lp-grain" }), h("i", { class: "lp-veil" })));
}
function hero() {
  return h("section", { class: "lp-seq", id: "top", "aria-label": "Sayso" },
    h("div", { class: "lp-stage" },
      film(),
      h("div", { class: "lp-hero-copy lp-col" },
        h("h1", { class: "lp-display lp-h1" },
          h("span", { class: "sr" }, "Now your agent can pay."),
          h("span", { "aria-hidden": "true" }, "Now your ", slot(), h("br"), "can pay.")),
        h("p", { class: "lp-lede" }, "Forward an invoice or let an MCP agent ask. Sayso prices it, checks the payee with the bank and pays inside the limits you set. Anything over the line waits for your tap."),
        h("div", { class: "lp-actions" },
          h("a", { class: "lp-pill solid", href: "#signin", onclick: toApp }, "Get started"),
          h("a", { class: "lp-pill glass", href: "#how" }, "See how"))),
      h("div", { class: "lp-reveal" },
        h("div", { class: "lp-reveal-head" },
          h("span", { class: "lp-k" }, "Everything your agents may spend. One place."),
          h("h2", { class: "lp-display" }, "You keep the final say.")),
        dashboard(),
        h("a", { class: "lp-link", href: "#signin", onclick: toApp }, "Open the live testnet dashboard", h("i", { "aria-hidden": "true" }, "→")))),
  );
}

function dashboard() {
  const fact = (k, v) => h("div", {}, h("dt", {}, k), h("dd", {}, v));
  const agent = (logo, color, name, rule, used, cap, st) => h("div", { class: "db-agent" },
    h("span", { class: "db-ico" }, mark(logo, 16, color)),
    h("span", { class: "db-name" }, name, h("small", {}, rule)),
    h("span", { class: "db-budget" }, h("span", {}, h("b", {}, `$${used}`), ` of $${cap}`), h("span", { class: "db-bar" }, h("i", { style: `width:${Math.round((used / cap) * 100)}%` }))),
    h("span", { class: `db-state ${st === "Active" ? "" : "off"}` }, st));
  return h("div", { class: "db", role: "img", "aria-label": "The Sayso dashboard: a $184.20 mandate, a $5 payment from claude waiting for approval, three agents and recent activity" },
    h("div", { class: "db-top" }, brand(),
      h("span", { class: "db-tabs" }, ["Home", "Inbox", "Agents", "Activity"].map((t, i) => h("span", { class: i ? "" : "on" }, t))),
      h("span", { class: "db-net" }, h("i"), "Testnet")),
    h("div", { class: "db-grid" },
      h("section", { class: "db-card db-vault" },
        h("span", { class: "db-muted" }, "Mandate balance"),
        h("strong", { class: "db-balance" }, "$184", h("span", {}, ".20")),
        h("span", { class: "db-sub" }, "USDZ on Metal"),
        h("div", { class: "db-today" }, h("span", {}, "Spent today"), h("b", {}, "$6.40"), h("span", {}, "of $18 across agents")),
        svg(`<svg class="db-chart" viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true"><path d="M6 80 54 53 102 69 150 37 198 47 246 18 294 33 294 94 6 94Z" fill="currentColor" fill-opacity=".12"/><path d="M6 80 54 53 102 69 150 37 198 47 246 18 294 33" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`),
        h("div", { class: "db-days" }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("span", {}, d)))),
      h("section", { class: "db-card db-ask" },
        h("div", { class: "db-head" }, h("span", { class: "db-who" }, h("span", { class: "db-ico" }, mark("claude", 16, "#D97757")), "claude wants to pay"), h("span", { class: "db-flag" }, "over $2 limit")),
        h("strong", { class: "db-amount" }, "$5", h("span", {}, ".00")),
        h("span", { class: "db-sub" }, "to Kreuzberg Studio · EUR 4.62"),
        h("p", { class: "db-memo" }, "“Monthly API plan, renews today.”"),
        h("dl", { class: "db-facts" }, fact("claude may pay alone", "up to $2.00"), fact("Left today", "$2.00 of $3.00"), fact("Kreuzberg Studio", "Paid before"), fact("Approving", "This payment only")),
        h("div", { class: "db-timer" }, h("i")),
        h("span", { class: "db-muted" }, "43 min left to decide"),
        h("div", { class: "db-decide" }, h("span", { class: "ghost" }, "Deny"), h("span", { class: "ink" }, "Approve with passkey"))),
      h("section", { class: "db-card db-side" },
        h("div", { class: "db-head" }, h("strong", {}, "Agents"), h("span", { class: "db-muted" }, "Limits reset daily")),
        agent("claude", "#D97757", "claude", "Up to $2, then asks", 2, 3, "Active"),
        agent("openai", "#fff", "codex", "Compute only", 4.1, 10, "Active"),
        agent("cursor", "#fff", "cursor", "Revoked Tuesday", 0, 5, "Off"),
        h("div", { class: "db-head db-gap" }, h("strong", {}, "Activity")),
        h("ul", { class: "db-feed" },
          h("li", {}, h("i", { class: "go" }), "Paid €48.00 to Holloway Print", h("small", {}, "2m")),
          h("li", {}, h("i", { class: "warn" }), "Held new bank details, Kreuzberg", h("small", {}, "1h")),
          h("li", {}, h("i", { class: "stop" }), "Refused $40, over cursor's budget", h("small", {}, "3h"))))));
}

// ---------- 3: two-column statement ----------
function statement() {
  return h("section", { class: "lp-beat" },
    h("div", { class: "lp-col lp-two", "data-reveal": "" },
      h("h2", { class: "lp-display lp-h2" }, "Agents already find the bill. Paying it is where they stop."),
      h("div", { class: "lp-two-body" },
        h("p", {}, "A card in a prompt is a promise the model can talk its way around. Sayso gives each agent one key that can ask to pay, and nothing else."),
        h("p", {}, "Every request is priced, the payee is checked with the bank, and the decision is made in code: pay, wait, split or hold. Over your line, it comes to you."),
        h("a", { class: "lp-link", href: "#board" }, "Watch it decide", h("i", { "aria-hidden": "true" }, "→")))));
}

// ---------- 4: the use-case strip, edge to edge ----------
const USES = [
  ["subscriptions", "Subscriptions", "Keep my API plan paid every month.", "One vendor on the list. Anything over $5 waits for you."],
  ["freelance", "Freelancers", "Pay the illustrator once I sign off the proofs.", "Parked as a hold until you approve that exact payment."],
  ["compute", "Compute", "Top up my GPU credits when they run low.", "One provider, $25 a day, a minute between top-ups."],
  ["travel", "Travel", "Book the cheapest train to Lisbon under €80.", "Under €80 it pays on its own. Above, it asks first."],
  ["team", "Teams", "Give the intern's agent £20 for the week.", "A mandate that expires on Friday, whatever is left."],
  ["tips", "Tipping", "Tip the writers I read, a dollar each.", "$1 a payment, $10 a day, one a minute."],
  ["errands", "Errands", "Settle the dry cleaner's invoice when it lands.", "A payee paid before, the usual amount: it pays and tells you."],
  ["research", "Research", "Buy the paper behind the paywall if it's under $15.", "One purchase a day, never the same paper twice."],
  ["invoices", "Invoices", "Hold every bill, I'll decide on the way home.", "Each one waits as a card. One tap pays it."],
];
function uses() {
  return h("section", { class: "lp-beat", id: "uses" },
    h("div", { class: "lp-col lp-sec-head", "data-reveal": "" },
      h("span", { class: "lp-k" }, "What it pays for"),
      h("h2", { class: "lp-display lp-h2" }, "Tell it what to pay for. Sayso holds the limit.")),
    h("ul", { class: "lp-strip", "data-reveal": "", "aria-label": "Use cases" }, USES.map(([img, label, quote, rule]) => h("li", { class: "lp-use" },
      h("img", { src: `/people/${img}.jpg`, alt: "", loading: "lazy", decoding: "async" }),
      h("div", { class: "lp-use-body" },
        h("span", { class: "lp-use-k" }, label),
        h("p", { class: "lp-use-q" }, quote),
        h("p", { class: "lp-use-r" }, rule))))));
}

// ---------- 5: the big statement ----------
function contract() {
  return h("section", { class: "lp-beat lp-big" },
    h("div", { class: "lp-col", "data-reveal": "" },
      h("h2", { class: "lp-display lp-h-giant" }, "The limit is a contract, ", h("span", { class: "lp-dim" }, "not a promise.")),
      h("p", { class: "lp-lede" }, "Limits aren't instructions a model can argue with. They live in a mandate on your own Metal account, and the chain enforces them before Sayso is even asked.")));
}

// ---------- 6: 01–04, each with a small wireframe cube ----------
const STEPS = [
  ["You set the limits", "A mandate on Metal: a cap per payment, a total budget, an expiry, and Sayso as its only payee."],
  ["The agent gets one key", "A key that can ask Sayso to pay, and nothing else. Never your account, never a bigger budget."],
  ["Every payment is checked", "decide() weighs price, balance, payee and deadline before money moves. Over the limit, it asks you."],
  ["Revoke, and it's gone", "Revoking the mandate refuses the agent's next payment on chain, before Sayso is even asked."],
];
const CUBE = (inner) => svg(`<svg class="lp-cube" viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M24 5 40 14v19L24 43 8 33V14Z"/><path d="M8 14l16 9 16-9M24 23v20"/>${inner}</svg>`);
const CUBES = [
  "",
  `<path d="M24 17l6 3.4v6.8L24 31l-6-3.8v-6.8Z" opacity=".7"/>`,
  `<path d="M14 28l5 4 9-11" stroke-width="1.6"/>`,
  `<path d="M24 5v18M8 33l16-10 16 10" stroke-dasharray="2 2.5" opacity=".6"/>`,
];
function steps() {
  return h("section", { class: "lp-beat", id: "how" },
    h("div", { class: "lp-col" },
      h("div", { class: "lp-sec-head", "data-reveal": "" },
        h("span", { class: "lp-k" }, "How it holds"),
        h("h2", { class: "lp-display lp-h2" }, "Four steps between your agent and your money.")),
      h("ol", { class: "lp-steps" }, STEPS.map(([title, body], i) => h("li", { "data-reveal": "", style: `--i:${i}` },
        CUBE(CUBES[i]),
        h("span", { class: "lp-step-n" }, `0${i + 1}`),
        h("h3", {}, title),
        h("p", {}, body))))));
}

// The live decision engine and the receipt proof, contained on paper: the real thing, not a mock.
function engine() {
  return h("section", { class: "lp-beat lp-engine" },
    h("div", { class: "lp-col" },
      h("div", { class: "lp-sec-head", "data-reveal": "" },
        h("span", { class: "lp-k" }, "The engine, live"),
        h("h2", { class: "lp-display lp-h2" }, "One invoice. Four possible answers."),
        h("p", { class: "lp-lede" }, "This is Sayso's own decide(), answering now. Move a dial and watch the verdict turn, then check a real receipt against the hash Sayso recorded.")),
      h("div", { class: "lp-paper", "data-reveal": "" }, stage(), proveSection())));
}

// ---------- 7: twelve clients ----------
const CLIENTS = [["claude", "Claude Code"], ["anthropic", "claude.ai"], ["openai", "ChatGPT"], ["openai", "Codex"], ["cursor", "Cursor"], ["windsurf", "Windsurf"], ["zed", "Zed"], ["cline", "Cline"], ["raycast", "Raycast"], ["imessage", "iMessage"], ["gemini", "Gemini CLI"], ["copilot", "GitHub Copilot"]];
function clients() {
  return h("section", { class: "lp-beat", id: "clients" },
    h("div", { class: "lp-col" },
      h("div", { class: "lp-sec-head", "data-reveal": "" },
        h("span", { class: "lp-k" }, "Works where your agent works"),
        h("h2", { class: "lp-display lp-h2" }, "Any MCP client. One Sayso."),
        h("p", { class: "lp-lede" }, "Payments settle in USDZ on Metal. Payees are paid in their own currency through Airwallex.")),
      h("ul", { class: "lp-logos", "data-reveal": "" }, CLIENTS.map(([logo, name]) => h("li", {}, mark(logo, 26), h("span", {}, name))))));
}

// ---------- 8: FAQ ----------
const FAQ = [
  ["What is Sayso?", "An invoice paid by an agent: it forwards the invoice, or asks over MCP, and Sayso prices it, checks the payee and pays through Airwallex once the agent's USDZ settles on Metal."],
  ["Who holds the money?", "You do, on Metal. An agent spends only inside the mandate you bind, and only to Sayso."],
  ["What stops an agent from overspending?", "Two layers. Metal refuses any payment past the cap, the budget or the expiry. Sayso's decide() checks price, balance, payee and deadline before a cent moves."],
  ["What happens above the limit?", "The payment waits as a hold. You see who, how much, to whom and why, and approve it with a passkey before the window closes."],
  ["What if the bank details changed?", "Sayso holds it, sends 0.01 with a code to the new account, and asks the payee at the address on file from an earlier paid invoice, never the address that sent the new details."],
  ["Is it live?", "Agents pay against Airwallex's sandbox and Metal's testnet. The offline demo simulates both; every proof it produces says sim:."],
];
function faq() {
  return h("section", { class: "lp-beat", id: "questions" },
    h("div", { class: "lp-col lp-faq" },
      h("div", { class: "lp-sec-head", "data-reveal": "" },
        h("span", { class: "lp-k" }, "Questions"),
        h("h2", { class: "lp-display lp-h2" }, "What people ask first.")),
      h("div", { class: "lp-acc", "data-reveal": "" }, FAQ.map(([q, a]) => h("details", {}, h("summary", {}, q, h("i", { "aria-hidden": "true" })), h("p", {}, a))))));
}

// ---------- 9: the photo CTA, with every way in ----------
function closing() {
  return h("section", { class: "lp-cta", id: "signin" },
    h("img", { class: "lp-cta-img", src: "/people/closing.jpg", alt: "", loading: "lazy", decoding: "async" }),
    h("div", { class: "lp-col lp-cta-in" },
      h("div", { class: "lp-cta-copy", "data-reveal": "" },
        h("h2", { class: "lp-display lp-h-giant" }, "Give your agent a budget, not your wallet."),
        h("p", { class: "lp-lede" }, "Sign in with a passkey, then pay what your agents found, or hold it. Nothing over your line leaves without one tap from you.")),
      h("div", { class: "lp-cta-card" }, state.signedIn
        ? h("div", { class: "dialog signed", "data-ui": "" }, h("h3", {}, state.me?.viewer ? "You're looking around, read-only" : "You're signed in"), h("p", { class: "muted small" }, "Nothing on this page changed. The app is one tap away."), h("a", { class: "btn", href: "/app", onclick: openApp }, "Open the app"))
        : signinDialog())));
}

// ---------- 10: footer ----------
function footer() {
  const col = (title, links) => h("div", { class: "lp-fcol" }, h("h3", {}, title), links.map(([href, label]) => h("a", { href, rel: href.startsWith("http") ? "noopener" : null }, label)));
  return h("footer", { class: "lp-foot" },
    h("div", { class: "lp-col lp-foot-grid" },
      h("div", { class: "lp-fcol lp-fid" }, brand(), h("p", {}, "Agents pay real invoices. You keep the final say.")),
      col("Product", [["#how", "How it works"], ["#uses", "Use cases"], ["#board", "Live engine"], ["#prove", "Receipt proof"]]),
      col("Developers", [["#clients", "MCP clients"], ["/ops/", "Back office"], ["https://github.com/nice-bills/Sayso", "Source"]]),
      h("div", { class: "lp-fcol" }, h("h3", {}, "Contact"), h("span", {}, "Forward invoices to"), h("a", { href: "mailto:sayso-invoices@agentmail.to" }, "sayso-invoices@agentmail.to"))),
    h("div", { class: "lp-col lp-foot-base" },
      h("span", {}, "© 2026 Sayso. Built for the Airwallex Agentic Banking Hackathon."),
      h("span", {}, "Airwallex sandbox · Metal testnet")));
}

export function landing() {
  return h("div", { class: "lp" }, nav(), hero(), statement(), uses(), contract(), steps(), engine(), clients(), faq(), closing(), footer());
}

// ---------- the one pin: headline out, dashboard in, over ~600px ----------
const PIN = 600;
function drive() {
  const seq = document.querySelector(".lp-seq");
  if (!seq) return;
  const p = Math.min(1, Math.max(0, (window.scrollY - seq.offsetTop) / PIN));
  seq.style.setProperty("--p", p.toFixed(3));
  seq.dataset.state = p > 0.5 ? "product" : "hero";
  document.querySelector(".lp-nav")?.classList.toggle("scrolled", window.scrollY > 24);
}
window.addEventListener("scroll", drive, { passive: true });
window.addEventListener("resize", () => { drive(); sizeSlot(); });

// Called after every render: Lenis runs only while the landing is on screen.
let lenis = null;
export function afterRender() {
  const on = Boolean(document.querySelector(".lp"));
  if (on && !lenis && !stillMotion) lenis = new Lenis({ autoRaf: true, anchors: true, lerp: 0.09 });
  if (!on && lenis) { lenis.destroy(); lenis = null; }
  if (on) { drive(); requestAnimationFrame(sizeSlot); }
  // Taking the film out of the page for a re-render pauses it; put it back to playing.
  const video = filmEl?.querySelector("video");
  if (on && video?.paused && !stillMotion) video.play().catch(() => {});
}
