// Shared bits for the signed-in app mocks: the film backdrop and grain, the tab bar the real app
// shows on Inbox/Payments/Agents, icons, the split-flap word and a toast. Pages set <body data-tab>.
(() => {
  const ICON = {
    home: '<path d="M4 11 12 4l8 7v9H4Z"/>', inbox: '<path d="M4 5h16v14H4ZM4 13h5l1 2h4l1-2h5"/>', payments: '<path d="M3 7h18v10H3ZM3 11h18"/>',
    bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>', ledger: '<path d="M6 4h12v16H6ZM9 8h6M9 12h6M9 16h4"/>',
    out: '<path d="M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10"/>', face: '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 10v1M15 10v1M12 10v3h-1M9 16c1.5 1 4.5 1 6 0"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z"/>', check: '<path d="m5 12 5 5 9-10"/>', hand: '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.4-1.8L8 15"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>', mail: '<path d="M3 6h18v12H3ZM3 7l9 6 9-6"/>',
  };
  const icon = (n, s = 18) => `<svg class="i" style="width:${s}px;height:${s}px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[n] ?? ""}</svg>`;

  // the night film behind every screen, then grain
  document.body.insertAdjacentHTML("afterbegin", '<div class="backdrop" aria-hidden="true"><video src="/film/night.mp4" poster="/film/night.jpg" autoplay muted loop playsinline></video></div><div class="grain" aria-hidden="true"></div><div class="toast glass" role="status"></div>');

  // the tab bar: same tabs, same right-hand cluster as the real app
  const tab = document.body.dataset.tab;
  if (tab !== "home") {
    const t = (id, label, href, n) => `<a class="tab${tab === id ? " on" : ""}${href ? "" : " off"}" href="${href ?? "#"}" ${href ? "" : 'aria-disabled="true" title="Not mocked"'}>${icon(id === "agents" ? "bot" : id, 18)}<span class="tl">${label}</span>${n ? `<span class="count">${n}</span>` : ""}</a>`;
    document.body.insertAdjacentHTML("afterbegin", `<header class="top"><div class="wrap"><div class="bar glass">
      <a class="brand" href="/mocks/app-home.html"><i></i>sayso</a>
      <nav class="tabs">${t("home", "Home", "/mocks/app-home.html", 3)}${t("inbox", "Inbox", "/mocks/app-inbox.html")}${t("payments", "Payments")}${t("agents", "Agents", "/mocks/app-agents.html")}</nav>
      <div class="top-right"><button class="ibtn" title="Face ID is on" aria-label="Passkey">${icon("face")}</button><span class="balchip">Available <b>$1,496.03</b></span><span class="mode">Offline demo</span><a class="ibtn" href="#" title="Back office" aria-label="Back office">${icon("ledger")}</a><a class="ibtn" href="/mocks/" title="Sign out" aria-label="Sign out">${icon("out")}</a></div>
    </div></div></header>`);
  }

  // split-flap: each cell runs through a few letters before it lands
  function flaps(word, tone, len = word.length) {
    const box = document.createElement("span"); box.className = `flaps ${tone}`; box.setAttribute("aria-label", word);
    [...word.padEnd(len)].forEach((ch, i) => {
      const f = document.createElement("span"); f.className = "flap"; box.append(f);
      let n = 0; const tick = () => { f.classList.remove("turn"); void f.offsetWidth; f.classList.add("turn"); f.textContent = n < 3 + i ? "ABCDEHKLOPRSTWY"[Math.floor(Math.random() * 15)] : ch; if (n++ < 3 + i) setTimeout(tick, 80); };
      setTimeout(tick, 250);
    });
    return box;
  }
  let tt;
  function toast(msg) { const el = document.querySelector(".toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), 2600); }
  function count(el, to, ms, fmt) { const t0 = performance.now(); (function f(t) { const k = Math.min(1, (t - t0) / ms); el.innerHTML = fmt(to * (1 - Math.pow(1 - k, 4))); if (k < 1) requestAnimationFrame(f); })(t0); }
  window.M = { icon, flaps, toast, count };
})();
