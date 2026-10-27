// Trickle Down — front end. Plain JS, no build step.
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SITE = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/^https?:\/\//, '');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHARITY_COLORS = ['#1879A0', '#2C9BC4', '#0F5873', '#63B6D3', '#1B6E8C', '#9ED3E4'];

  const state = {
    me: null,            // response of GET /me
    assets: [],
    charities: [],
    selected: null,      // asset chosen for the slice
    quote: null,
    carve: 0,            // dollars being carved right now (0 = no slice)
    sell: null,          // position being cashed out
    flipped: false,      // which side of the coin is up
    authMode: 'login',
    tab: 'today',
    busy: false,
    grow: null,          // { id, t } animation of one wedge's size, t in 0..1
    flipTimer: null,
  };

  // --- formatting ----------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, opts = {}) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: opts.whole ? 0 : 2, maximumFractionDigits: opts.whole ? 0 : 2 });
    return `${n < 0 ? '-' : ''}$${s}`;
  };
  const moneySplit = (n) => `<small>$</small>${esc(Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`;
  const pct = (p, digits = 1) => {
    if (p === null || p === undefined || Number.isNaN(p)) return '—';
    const v = p * 100;
    return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
  };
  const dir = (p) => (p > 0 ? 'up' : p < 0 ? 'down' : '');
  const price = (p) => (p >= 1000 ? money(p, { whole: true }) : p >= 1 ? money(p) : `$${p.toPrecision(3)}`);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const mult = (m) => `×${Number.isInteger(m) ? m : m.toFixed(1)}`;
  const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // "3h ago", "25m ago", "2d ago"
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  // "21h 12m", "48m", "ready"
  function left(matures_at) {
    const s = (new Date(matures_at) - Date.now()) / 1000;
    if (s <= 0) return 'ready';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'any second now';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  // "64d 6h", "6h 12m", "12m"
  function untilLong(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'any minute now';
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h`;
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  const festDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  // Play-money tax hires lobbyists for a charity at a dollar a head. They are
  // not dollars, and the copy never pretends they are.
  const lobbyN = (n) => { const v = round2(n); return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''); };
  const lobby = (n) => `${lobbyN(n)} lobbyist${round2(n) === 1 ? '' : 's'}`;

  // One lobbyist: suit, tie, briefcase. The fractional one is clipped from the
  // feet up, so a quarter of a lobbyist is a head and shoulders.
  const LOBBYIST = `<svg class="lobbyist" viewBox="0 0 20 40" aria-hidden="true">
      <circle cx="9" cy="5.5" r="4.5"/>
      <path d="M3 12 h12 l1.5 14 h-15 z"/>
      <path class="tie" d="M9 12 l1.6 0 l-0.3 9 l-0.5 1.4 l-0.5 -1.4 z"/>
      <rect x="4.5" y="26" width="4" height="13" rx="0.5"/>
      <rect x="9.5" y="26" width="4" height="13" rx="0.5"/>
      <rect class="case" x="15" y="21" width="5" height="7" rx="0.8"/>
    </svg>`;
  function lobbyists(n, { mini = false, max = 24 } = {}) {
    const whole = Math.floor(n + 1e-9), frac = round2(n - whole);
    let out = LOBBYIST.repeat(Math.min(whole, max));
    if (whole > max) out += `<span class="more">+${whole - max}</span>`;
    if (frac > 0) out += LOBBYIST.replace('class="lobbyist"', `class="lobbyist frac" style="clip-path: inset(0 0 ${Math.round((1 - frac) * 100)}% 0)"`);
    return `<span class="lobbyists ${mini ? 'mini' : ''}" role="img" aria-label="${esc(lobby(n))}">${out}</span>`;
  }
  // A dollar, same footprint as a lobbyist so one can become the other.
  const BILL = `<svg class="billsvg" viewBox="0 0 20 40" aria-hidden="true"><rect x="0.5" y="0.5" width="19" height="39" rx="2"/><rect x="3" y="3" width="14" height="34" rx="1" class="bill-inner"/><text x="10" y="25" text-anchor="middle" class="bill-text">$</text></svg>`;
  function billsRow(n, { max = 24 } = {}) {
    const whole = Math.floor(n + 1e-9), frac = round2(n - whole);
    let out = BILL.repeat(Math.min(whole, max));
    if (whole > max) out += `<span class="more">+${whole - max}</span>`;
    if (frac > 0) out += BILL.replace('class="billsvg"', `class="billsvg frac" style="clip-path: inset(0 0 ${Math.round((1 - frac) * 100)}% 0)"`);
    return `<span class="lobbyists" role="img" aria-label="${esc(money(n))}">${out}</span>`;
  }

  function toast(text, ms = 2800) {
    const el = $('#toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // --- screens / routing ---------------------------------------------------------------

  function showScreen(name) {
    $$('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
    state.tab = name;
    window.scrollTo({ top: 0 });
  }

  async function route() {
    const hash = (location.hash || '#today').slice(1);
    if (!API.token()) { showScreen('welcome'); renderWelcome(); return; }
    const name = ['today', 'trickle', 'leaders', 'how'].includes(hash) ? hash : 'today';
    const firstLoad = !state.me;
    if (firstLoad) { await loadMe(); if (!API.token()) return; }
    showScreen(name);
    if (name === 'today' && !firstLoad) loadMe();
    if (name === 'trickle') loadTrickle();
    if (name === 'leaders') loadLeaders();
    if (name === 'how') renderHow();
  }

  function setSignedIn(on) {
    $('#tabs').hidden = !on;
    $('#foot').hidden = !on;
    $('#masthead-day').hidden = !on;
  }

  // --- welcome ----------------------------------------------------------------------

  function renderWelcome() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Fake money. Real market. Real charity.</h1>
        <p>Every day you get $100 that isn't real. Carve it up across any stocks or coins you like. Each bet lives 24 hours, and the longer it lives, the harder it hits: your money tracks the real move at the start and climbs to ten times it by the end.</p>
        <p>Collect a win and a quarter of the profit is taxed. The tax hires lobbyists for a charity you pick, a dollar a head. They aren't dollars. The ads on this site earn real money, and every quarter it's split between the charities by how many lobbyists each one has.</p>
        <p>Lose and nothing happens. Win and something does.</p>
        <div class="row-actions">
          <button class="btn primary" id="btn-guest">Play as a guest</button>
          <button class="btn" id="btn-signin">Sign in</button>
        </div>
      </div>`;
    $('#btn-guest').onclick = async () => {
      try {
        const r = await API.post('/auth/guest');
        API.setToken(r.token);
        location.hash = '#today'; route();
      } catch (e) { toast(e.message); }
    };
    $('#btn-signin').onclick = () => openAuth('login');
  }

  // --- today: data ------------------------------------------------------------------

  async function loadMe() {
    try {
      const me = await API.get('/me');
      state.me = me;
      setSignedIn(true);
      renderToday();
      if (me.allowance) {
        tossCoin();
        const bonus = me.allowance.amount - me.rules.daily_base;
        setTimeout(() => toast(bonus > 0
          ? `Day ${me.user.streak} of your streak: ${money(me.allowance.amount, { whole: true })} landed on the coin.`
          : `${money(me.allowance.amount, { whole: true })} of fake money landed on the coin. Carve it up.`), REDUCED ? 0 : 1100);
      }
    } catch (e) {
      if (e.status === 401) { API.setToken(null); route(); return; }
      toast(e.message);
    }
  }

  async function ensureAssets() {
    if (!state.assets.length) state.assets = (await API.get('/assets')).assets;
    if (!state.charities.length) state.charities = (await API.get('/charities')).charities;
  }

  function renderMasthead() {
    const { day, user } = state.me;
    $('#day-number').textContent = `Day ${day.number}`;
    $('#day-countdown').textContent = `New money in ${countdown(day.resets_at)}`;
    $('#foot-user').textContent = user.is_guest ? `Playing as ${user.username}` : `Signed in as ${user.username}`;
    $('#btn-claim').hidden = !user.is_guest;
  }

  // --- today: the coin ------------------------------------------------------------------

  function totalInPlay(me) {
    return me.user.cash + me.positions.reduce((s, p) => s + (p.quote_error ? p.invested : p.value), 0);
  }

  function coinFrontMarkup() {
    const me = state.me;
    const svg = Coin.front({ positions: me.positions, cash: me.user.cash, preview: state.carve > 0 ? { amount: state.carve } : null, grow: state.grow });
    const total = totalInPlay(me);
    let center;
    if (state.carve > 0) {
      center = `<b>${moneySplit(state.carve)}</b><span>slice, ${Math.round(state.carve / me.user.cash * 100)}% of your bills</span>`;
    } else if (me.user.cash >= 0.01) {
      center = `<b>${moneySplit(me.user.cash)}</b><span><span class="free">free to spend</span><br>${money(total)} in play</span>`;
    } else if (total > 0) {
      center = `<b>${moneySplit(total)}</b><span>in play<br>nothing free to spend</span>`;
    } else {
      center = `<b>$0</b><span>Come back tomorrow.</span>`;
    }
    return `${svg}<div class="coin-center">${center}</div><button class="coin-tap" type="button" aria-label="Flip the coin"></button>`;
  }

  function coinBackMarkup() {
    const me = state.me;
    const q = me.user.quarter_donated || 0;
    const svg = Coin.back({ slices: me.donations_by_charity.filter((c) => c.amount > 0).map((c) => ({ name: c.name, amount: c.amount })) });
    return `${svg}<div class="coin-center"><b>${esc(lobbyN(q))}</b><span>lobbyist${round2(q) === 1 ? '' : 's'} this quarter<br>Lobbyfest in ${esc(untilLong(me.day.quarter_ends_at))}</span></div><button class="coin-tap" type="button" aria-label="Flip the coin back"></button>`;
  }

  // Redraw only the coin faces. Keeps the carve panel (and its focus) intact.
  function paintCoin() {
    const front = $('#coin-front'), back = $('#coin-back');
    if (!front) return;
    front.innerHTML = coinFrontMarkup();
    back.innerHTML = coinBackMarkup();
    wireCoin();
  }

  function tipFor(p) {
    const head = `<b>${esc(p.symbol)}</b> ${esc(p.name)}`;
    if (p.quote_error) return `${head}<br>${money(p.invested)} in. Price unavailable right now.`;
    if (p.busted) return `${head}<br>${money(p.invested)} in → <span class="tip-money">$0</span><br>${esc(p.name)} fell ${pct(Math.abs(p.real_pct))} at ${mult(p.multiplier_now)}. It's gone.`;
    const line2 = `${money(p.invested)} in → <span class="tip-money">${money(p.value)}</span> <span class="${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
    const line3 = `real ${pct(p.real_pct)} at ${mult(p.multiplier_now)}`;
    const line4 = p.matured
      ? `<span class="ready">Matured. Collect it, or let it ride.</span>`
      : `<span class="time">${left(p.matures_at)} to maturity, when it hits ${mult(p.multiplier)} and freezes.</span>`;
    const ride = p.ride_count > 0 ? `<br><span class="time">Riding ×${p.ride_count}, started with ${money(p.origin_invested)}.</span>` : '';
    return `${head}<br>${line2}<br>${line3}<br>${line4}${ride}`;
  }

  function showTip(html, ev) {
    const stage = $('.coin-stage'); let tip = $('#coin-tip');
    if (!stage) return;
    if (!tip) { tip = document.createElement('div'); tip.id = 'coin-tip'; tip.className = 'coin-tip'; stage.appendChild(tip); }
    tip.innerHTML = html;
    const r = stage.getBoundingClientRect();
    tip.style.left = `${Math.max(100, Math.min(r.width - 100, ev.clientX - r.left))}px`;
    tip.style.top = `${ev.clientY - r.top}px`;
    tip.hidden = false;
  }
  function hideTip() { const t = $('#coin-tip'); if (t) t.hidden = true; }

  function wireCoin() {
    $$('.coin-tap').forEach((b) => { b.onclick = () => flip(); });
    $$('.wedge[data-id]').forEach((w) => {
      const p = () => state.me.positions.find((x) => x.id === Number(w.dataset.id));
      w.onclick = () => { hideTip(); openSell(Number(w.dataset.id)); };
      w.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSell(Number(w.dataset.id)); } };
      w.onpointerenter = (e) => { if (e.pointerType === 'mouse' && p()) showTip(tipFor(p()), e); };
      w.onpointermove = (e) => { if (e.pointerType === 'mouse' && p()) showTip(tipFor(p()), e); };
      w.onpointerleave = hideTip;
    });
    const cash = $('.cash-sector');
    if (cash) {
      cash.onclick = () => { hideTip(); const i = $('#carve-search'); const u = $('#carve-usd'); if (u && !u.closest('[hidden]')) { u.focus(); u.select(); } else if (i) i.focus(); };
      cash.onpointerenter = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointermove = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointerleave = hideTip;
    }
  }

  function captionMarkup() {
    return state.flipped
      ? `<div class="side-label"><b>Tails.</b> Your lobbyist army. <span class="muted">Heads is your portfolio.</span></div><button class="btn quiet small" id="btn-flip">Flip to portfolio</button>`
      : `<div class="side-label"><b>Heads.</b> Your portfolio. <span class="muted">Tails is your lobbyist army.</span></div><button class="btn quiet small" id="btn-flip">Flip to lobbyists</button>`;
  }

  function flip(to) {
    clearTimeout(state.flipTimer);
    state.flipped = to === undefined ? !state.flipped : to;
    const coin = $('#coin');
    if (coin) coin.classList.toggle('flipped', state.flipped);
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); $('#btn-flip').onclick = () => flip(); }
    hideTip();
    renderUnder();
  }

  // The day's first load: the coin is tossed in and lands.
  function tossCoin() {
    const coin = $('#coin');
    if (!coin || REDUCED) return;
    coin.classList.remove('landing');
    void coin.offsetWidth; // restart the animation if it already ran
    coin.classList.add('landing');
    coin.addEventListener('animationend', () => coin.classList.remove('landing'), { once: true });
  }

  // Animate one wedge from t0 to t1 over ms, then settle.
  function animateWedge(id, t0, t1, ms = 480) {
    if (REDUCED) { state.grow = null; paintCoin(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        state.grow = { id, t: t0 + (t1 - t0) * e };
        paintCoin();
        if (k < 1) requestAnimationFrame(step); else { state.grow = null; paintCoin(); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  // --- today: layout ----------------------------------------------------------------------

  function renderToday() {
    const me = state.me;
    if (!me) return;
    renderMasthead();
    if (state.carve > me.user.cash) state.carve = 0;

    $('#screen-today').innerHTML = `
      <div class="coin-stage">
        <div class="coin ${state.flipped ? 'flipped' : ''}" id="coin">
          <div class="coin-inner">
            <div class="coin-face front" id="coin-front"></div>
            <div class="coin-face back" id="coin-back"></div>
          </div>
        </div>
        <div class="coin-caption">${captionMarkup()}</div>
      </div>
      <div id="under"></div>`;
    paintCoin();
    $('#btn-flip').onclick = () => flip();
    renderUnder();
  }

  function renderUnder() {
    const el = $('#under');
    if (!el) return;
    el.innerHTML = `<div class="under">${state.flipped ? backMarkup() : frontMarkup()}</div>`;
    if (state.flipped) wireBack(); else wireFront();
  }

  // Front: pick → amount → buy, then the legend, crowd, share.
  function frontMarkup() {
    const me = state.me;
    const { user, positions, rules } = me;
    const canCarve = user.cash >= 0.01;
    const ready = positions.filter((p) => p.matured && !p.quote_error).length;
    const nextMoney = money(Math.min(rules.daily_cap, rules.daily_base + rules.streak_bonus * user.streak), { whole: true });
    const head = `
      <div class="side-head">
        <h2>Portfolio</h2>
        <span class="muted">${money(user.cash)} free. ${positions.length} on the coin${ready ? `, ${ready} ready` : ''}. ${user.streak > 1 ? `${user.streak}-day streak, ` : ''}${nextMoney} tomorrow.</span>
      </div>`;
    const carve = canCarve ? `
      <section class="carve">
        <h2>Buy something</h2>
        <div class="hint">${money(user.cash)} in bills on the coin. Pick a stock or coin, then say how much. Each buy lives ${me.rules.hold_hours} hours.</div>
        <div class="picker" id="picker">
          <div class="picked" id="picked" hidden></div>
          <input type="search" id="carve-search" placeholder="Nvidia, BTC, gold, the S&amp;P…" autocomplete="off" spellcheck="false" aria-label="Search for something to buy">
          <ul class="asset-list" id="asset-list" role="listbox" hidden></ul>
        </div>
        <div class="amount-zone" id="amount-zone" hidden>
          <div class="amount-row"><span class="amount-prefix">$</span><input id="carve-usd" type="number" min="0.01" max="${user.cash}" step="0.01" inputmode="decimal" placeholder="0.00" aria-label="Amount in dollars"></div>
          <div class="chips" id="carve-chips">
            <button type="button" data-pct="10">10%</button>
            <button type="button" data-pct="25">25%</button>
            <button type="button" data-pct="50">50%</button>
            <button type="button" data-pct="100">All of it</button>
          </div>
        </div>
        <p class="form-error" id="carve-error" hidden></p>
        <button type="button" class="btn primary wide" id="carve-buy" disabled>Pick something first</button>
      </section>` : `
      <section class="all-in">
        <b>All in.</b>
        <span class="muted">Every bill is on the coin. ${ready ? `${ready} position${ready === 1 ? ' is' : 's are'} ready to collect.` : 'Come back tomorrow for more.'}</span>
      </section>`;

    const legend = positions.length ? `
      <section class="legend">
        <h2>On the coin</h2>
        <ul class="positions">${positions.map(positionRow).join('')}</ul>
      </section>` : '';

    return `${head}${carve}${legend}${crowdStrip(me.crowd)}
      <div class="row-actions">
        <button class="btn quiet small" id="btn-share">Share today</button>
        <a class="btn quiet small" href="#trickle">The lobby</a>
      </div>`;
  }

  function positionRow(p) {
    const cls = ['position'];
    if (p.quote_error) cls.push('stale');
    else if (p.busted) cls.push('busted');
    else cls.push(dir(p.swing_pct));
    if (p.matured) cls.push('matured');
    let value, move, action;
    const riding = p.ride_count > 0 ? ` Riding ×${p.ride_count}, started with ${money(p.origin_invested)}.` : '';
    const bought = `${p.ride_count > 0 ? 'Rode in' : 'Bought'} at ${price(p.entry_price)}, <span data-ago="${esc(p.opened_at)}">${ago(p.opened_at)}</span>.${riding}`;
    if (p.quote_error) {
      value = `${money(p.invested)} → <b>?</b>`;
      move = `${bought} Price unavailable right now; it's still on the coin.`;
      action = `<button class="btn small" disabled>Sell</button>`;
    } else if (p.busted) {
      value = `${money(p.invested)} → <b>${money(0)}</b>`;
      move = `${bought} ${esc(p.name)} fell ${pct(Math.abs(p.real_pct))} at ${mult(p.multiplier_now)}. It's gone.`;
      action = `<button class="btn small" data-sell="${p.id}">Bury it</button>`;
    } else if (p.matured) {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${bought} Matured <span data-ago="${esc(p.matured_at)}">${ago(p.matured_at)}</span> at ${price(p.price)}, ${mult(p.multiplier)}. <span class="ready">Ready to collect, or let it ride.</span>`;
      action = `<button class="btn small primary" data-sell="${p.id}">Collect</button> <button class="btn small" data-ride="${p.id}">Ride</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${bought} Real ${pct(p.real_pct)} at ${mult(p.multiplier_now)}. <span class="time"><span data-left="${esc(p.matures_at)}">${left(p.matures_at)}</span> to ${mult(p.multiplier)}.</span>`;
      action = `<button class="btn small" data-sell="${p.id}">Sell early</button>`;
    }
    return `
      <li class="${cls.join(' ')}" data-id="${p.id}">
        <span class="swatch"></span>
        <div class="ticker"><b>${esc(p.symbol)}</b><span>${esc(p.name)}</span></div>
        <div class="value">${value}</div>
        <div class="move">${move}</div>
        <div class="action">${action}</div>
      </li>`;
  }

  function crowdStrip(crowd) {
    if (!crowd || !crowd.buys) return `<p class="muted" style="font-size:14px">Nobody has bought anything yet today. First mover.</p>`;
    const total = crowd.buys;
    return `<p class="muted" style="font-size:14px">Everyone plays the same market. ${total} buy${total === 1 ? '' : 's'} today from ${crowd.players} player${crowd.players === 1 ? '' : 's'}: ${crowd.picks.map((c) => `<b>${esc(c.symbol)}</b> ${Math.round(c.buys / total * 100)}%`).join(', ')}.</p>`;
  }

  // Refresh the "3h ago" / "21h 12m" bits without rebuilding the panel.
  function tickTimes() {
    $$('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); });
    $$('[data-left]').forEach((el) => { el.textContent = left(el.dataset.left); });
    $$('[data-fest]').forEach((el) => { el.textContent = untilLong(el.dataset.fest); });
  }

  function wireFront() {
    $$('[data-sell]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.sell)); });
    $$('[data-ride]').forEach((b) => { b.onclick = () => ride(Number(b.dataset.ride)); });
    $('#btn-share').onclick = share;
    const search = $('#carve-search');
    if (!search) return;
    const list = $('#asset-list'), usd = $('#carve-usd');
    const cash = state.me.user.cash;

    const setCarve = (dollars, fromInput) => {
      const d = round2(Math.max(0, Math.min(cash, Number(dollars) || 0)));
      state.carve = d;
      if (!fromInput) usd.value = d > 0 ? d : '';
      $$('#carve-chips button').forEach((b) => b.classList.toggle('on', d > 0 && Math.round(d / cash * 100) === Number(b.dataset.pct)));
      paintCoin();
      updateBuyButton();
    };
    usd.addEventListener('input', () => setCarve(usd.value, true));
    $$('#carve-chips button').forEach((b) => {
      b.onclick = () => { setCarve(Number(b.dataset.pct) === 100 ? cash : cash * Number(b.dataset.pct) / 100); usd.focus(); };
    });

    const openList = () => { list.hidden = false; renderAssetList(search.value); };
    search.addEventListener('focus', openList);
    search.addEventListener('input', openList);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') list.hidden = true;
      if (e.key === 'Enter') { const first = $('li[data-symbol]', list); if (first) { e.preventDefault(); selectAsset(first.dataset.symbol); } }
    });
    search.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== search) list.hidden = true; }, 150));
    $('#carve-buy').onclick = submitBuy;

    ensureAssets().then(() => { if (state.selected) showPicked(); }).catch((e) => toast(e.message));
    // Carry an in-progress slice across a refresh.
    if (state.selected) showPicked();
    if (state.carve > 0) setCarve(state.carve);
  }

  function renderAssetList(q) {
    const el = $('#asset-list');
    if (!el || !state.assets.length) return;
    const needle = q.trim().toLowerCase();
    const list = state.assets.filter((a) => !needle || a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle));
    if (!list.length) { el.innerHTML = `<li class="nothing">Not in the game. It's a curated list, on purpose.</li>`; return; }
    el.innerHTML = list.slice(0, 60).map((a) => `
      <li role="option" data-symbol="${esc(a.symbol)}">
        <b>${esc(a.symbol)}</b>
        <span>${esc(a.name)}</span>
        <span class="mood ${esc(a.mood)}">${esc(a.mood)} ${mult(a.multiplier)}</span>
      </li>`).join('');
    $$('li[data-symbol]', el).forEach((li) => {
      // pointerdown beats the search field's blur, so the tap registers.
      li.onpointerdown = (e) => { e.preventDefault(); selectAsset(li.dataset.symbol); };
    });
  }

  async function selectAsset(symbol) {
    state.selected = state.assets.find((a) => a.symbol === symbol) || null;
    state.quote = null;
    showPicked();
    updateBuyButton();
    try {
      const quote = await API.get(`/quote/${encodeURIComponent(symbol)}`);
      if (!state.selected || state.selected.symbol !== symbol) return;
      state.quote = quote;
      showPicked();
      updateBuyButton();
    } catch (e) {
      const pk = $('#picked'); if (pk) pk.querySelector('.q').innerHTML = `<span class="down">${esc(e.message)}</span>`;
    }
  }

  // Swap the search field for the chosen asset, and reveal the amount.
  function showPicked() {
    const pk = $('#picked'), search = $('#carve-search'), list = $('#asset-list'), zone = $('#amount-zone');
    if (!pk) return;
    const a = state.selected, q = state.quote;
    if (!a) { pk.hidden = true; search.hidden = false; zone.hidden = true; return; }
    const qline = !q ? `Getting a price…`
      : `<b>${price(q.price)}</b> right now${q.change_pct == null ? '' : `, today <span class="${dir(q.change_pct)}">${pct(q.change_pct)}</span>`}`;
    pk.innerHTML = `
      <div class="picked-main"><b>${esc(a.symbol)}</b><span>${esc(a.name)}</span><span class="mood ${esc(a.mood)}">${esc(a.mood)} ${mult(a.multiplier)}</span></div>
      <div class="q">${qline}</div>
      <button type="button" class="linkish" id="carve-change">Change</button>`;
    pk.hidden = false; search.hidden = true; list.hidden = true; zone.hidden = false;
    $('#carve-change').onclick = () => {
      state.selected = null; state.quote = null; state.carve = 0;
      const usd = $('#carve-usd'); if (usd) usd.value = '';
      showPicked(); paintCoin(); updateBuyButton();
      search.value = ''; search.focus();
    };
    if (!(state.carve > 0)) { const usd = $('#carve-usd'); if (usd) setTimeout(() => usd.focus(), 30); }
  }

  function updateBuyButton() {
    const btn = $('#carve-buy');
    if (!btn) return;
    const amt = state.carve;
    if (!state.selected) { btn.disabled = true; btn.textContent = 'Pick something first'; return; }
    if (!state.quote) { btn.disabled = true; btn.textContent = `Pricing ${state.selected.symbol}…`; return; }
    if (!(amt > 0)) { btn.disabled = true; btn.textContent = `How much ${state.selected.symbol}?`; return; }
    btn.disabled = false;
    btn.textContent = `Buy ${money(amt)} of ${state.selected.symbol}`;
  }

  async function submitBuy() {
    if (state.busy || !state.selected || !(state.carve > 0)) return;
    const amount = state.carve, asset = state.selected;
    state.busy = true; $('#carve-buy').disabled = true; $('#carve-buy').textContent = 'Buying…';
    try {
      const r = await API.post('/buy', { symbol: asset.symbol, amount });
      state.carve = 0; state.selected = null; state.quote = null;
      toast(`${money(amount)} of ${asset.symbol} at ${price(r.quote.price)}. It matures in ${state.me.rules.hold_hours} hours.`);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
      await animateWedge(r.position.id, 0, 1);
      const s = $('#carve-search'); if (s) s.focus();
    } catch (e) {
      const err = $('#carve-error'); if (err) { err.textContent = e.message; err.hidden = false; }
    } finally {
      state.busy = false; updateBuyButton();
    }
  }

  // Back: this quarter's army, Lobbyfest, career rank, records.
  function backMarkup() {
    const me = state.me;
    const { user, history, day } = me;
    const given = me.donations_by_charity.filter((c) => c.amount > 0);
    const q = user.quarter_donated || 0;
    const badges = user.badges, next = badges.next;
    const have = badges.earned.length ? badges.earned[badges.earned.length - 1] : null;
    const prevAt = have ? have.at : 0;
    const progress = next ? Math.min(100, ((user.total_donated - prevAt) / (next.at - prevAt)) * 100) : 100;
    return `
      <div class="side-head">
        <h2>Lobbyist army</h2>
        <span class="muted">Lobbyfest in <b data-fest="${esc(day.quarter_ends_at)}">${esc(untilLong(day.quarter_ends_at))}</b>.</span>
      </div>
      <section class="records">
        <div class="lobby-row"><b>${esc(lobbyN(q))}</b>${q > 0 ? lobbyists(q) : '<span class="muted">Nobody on the payroll yet this quarter.</span>'}</div>
        <p class="fest">On ${esc(festDate(day.quarter_ends_at))} every lobbyist in the game marches off to Lobbyfest. They vote, the real money is split between the charities by headcount, and everyone's payroll resets to zero. Your rank stays.</p>

        ${given.length ? `<ul class="given">${given.map((c, i) => `
          <li><span><span class="sw" style="background:${CHARITY_COLORS[i % 6]}"></span>${esc(c.name)}</span><span>${lobbyists(c.amount, { mini: true, max: 12 })} <b>${esc(lobbyN(c.amount))}</b></span></li>`).join('')}</ul>` : ''}

        <h2>Career</h2>
        <div class="rank"><b>${have ? esc(have.name) : 'No rank yet'}</b><span class="muted">${have ? `is your rank, for ${esc(lobby(user.total_donated))} hired all time.` : 'Collect a profit and the tax hires your first one.'}</span></div>
        <div class="rank-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
        <div class="rank-line">${next ? `${esc(next.name)} at ${next.at} lobbyists. ${lobbyN(next.at - user.total_donated)} to go.` : 'There is nothing above this.'}</div>

        <h2>Records</h2>
        ${history.length ? `<ul class="history">${history.map((h) => `
          <li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)} <span class="muted">${h.collected ? 'collected' : h.proceeds > 0 ? 'sold early' : 'buried'}</span></span>
            <span class="to">${h.tax > 0 ? `${esc(lobby(h.tax))} for ${esc(h.charity_name)}` : shortDate(h.closed_at)}</span>
          </li>`).join('')}</ul>` : `<p class="muted">Nothing collected yet. The records start when you do.</p>`}
        <div class="row-actions"><button class="btn quiet small" id="btn-flip-back">Flip it back</button><a class="btn quiet small" href="#trickle">The whole lobby</a></div>
      </section>`;
  }

  function wireBack() {
    const b = $('#btn-flip-back'); if (b) b.onclick = () => flip(false);
  }

  // --- collect / sell sheet ----------------------------------------------------------------

  function defaultCharityId() {
    const me = state.me;
    const top = me.donations_by_charity && me.donations_by_charity[0];
    if (top && state.charities.some((c) => c.id === top.id)) return top.id;
    if (me.user.charity_id && state.charities.some((c) => c.id === me.user.charity_id)) return me.user.charity_id;
    return state.charities.length ? state.charities[0].id : null;
  }

  async function openSell(id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || p.quote_error) return;
    try { await ensureAssets(); } catch (e) { toast(e.message); return; }
    state.sell = p;
    const s = p.preview;
    const win = s.profit > 0, bust = p.busted, mat = p.matured;
    const tierClass = bust || s.profit < 0 ? 'loss' : win ? 'win' : '';
    const rate = Math.round(state.me.rules.tax_rate * 100);
    const pre = defaultCharityId();
    const charityOptions = state.charities.map((c) => `<option value="${c.id}" ${c.id === pre ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const verb = bust ? 'Bury it' : mat ? 'Collect' : 'Sell early';

    $('#sell-title').textContent = verb;
    $('#sell-body').innerHTML = `
      <div class="receipt-tier ${tierClass}">${esc(s.tier)}.</div>
      <ul class="receipt">
        <li><span>You put in, ${ago(p.opened_at)} at ${price(p.entry_price)}</span><b>${money(p.invested)}</b></li>
        <li><span>${esc(p.name)} ${mat ? 'moved' : 'has moved'} ${pct(p.real_pct)}${mat ? ` by the time it matured, ${ago(p.matured_at)}` : ''}</span><b class="${dir(p.real_pct)}">${pct(p.real_pct)}</b></li>
        <li><span>${mat ? `Multiplier at maturity` : `Multiplier right now`}${mat ? '' : `, climbing to ${mult(p.multiplier)} in ${left(p.matures_at)}`}</span><b>${mult(p.multiplier_now)}</b></li>
        <li><span>${mat ? 'Frozen at' : 'Worth right now'}</span><b>${money(p.value)} <span class="${dir(p.swing_pct)}" style="font-size:14px">${pct(p.swing_pct, 0)}</span></b></li>
        ${win ? `<li><span>Profit</span><b class="up">${money(s.profit)}</b></li><li><span>Tax, ${rate}% of profit, hires ${esc(lobby(s.tax))}</span><b>${money(s.tax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed. That would be cruel.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        <li class="total"><span>Back onto the coin as bills</span><b>${money(s.net)}</b></li>
      </ul>
      ${win ? `<div class="hire-row">
        <div class="hire-side"><span class="muted">${money(s.tax)} of tax</span>${billsRow(s.tax, { max: 12 })}</div>
        <span class="hire-arrow" aria-hidden="true">→</span>
        <div class="hire-side"><span class="muted">${esc(lobby(s.tax))}</span>${lobbyists(s.tax, { max: 12 })}</div>
      </div>` : ''}
      ${win || (!mat && !bust) ? `<label class="field charity-pick"><span>${win ? `${esc(lobby(s.tax))} for` : 'If it lands as a profit when you tap, the tax hires lobbyists for'}</span><select id="sell-charity">${charityOptions}</select></label>` : ''}
      ${!mat && !bust ? `<p class="muted" style="font-size:13px">These numbers are a snapshot; the sale happens at whatever the market says when you tap. Or wait: in ${left(p.matures_at)} it matures at ${mult(p.multiplier)} and freezes at whatever ${esc(p.name)} is doing then.</p>` : ''}
      ${mat && !bust ? `<div class="ride-box">
        <b>Or let it ride.</b>
        <span>Put the whole ${money(p.value)} back on ${esc(p.name)} at today's price for another ${state.me.rules.hold_hours} hours. No tax, no lobbyists${win ? `, nobody gets hired` : ''}. The multiplier starts over at ${mult(state.me.rules.mult_floor)} and climbs again. It can still go to zero.</span>
        <button type="button" class="btn small" id="sell-ride">Let it ride</button>
      </div>` : ''}
      ${mat && bust ? `<p class="muted" style="font-size:13px">Nothing left to ride. Burying it clears the spot.</p>` : ''}`;
    $('#sell-error').hidden = true;
    $('#sell-submit').disabled = false;
    $('#sell-submit').textContent = bust ? 'Bury it' : mat ? `Collect ${money(s.net)}` : `Sell early for about ${money(s.net)}`;
    const rideBtn = $('#sell-ride');
    if (rideBtn) rideBtn.onclick = () => { $('#dlg-sell').close(); ride(p.id); };
    $('#dlg-sell').showModal();
  }

  async function ride(id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/ride', { position_id: id });
      toast(`Riding. ${money(r.rolled.value)} back on ${p.name} at ${price(r.quote.price)} for another ${state.me.rules.hold_hours} hours. Nobody got hired.`, 4000);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
    } catch (e) { toast(e.message, 4000); }
    finally { state.busy = false; }
  }

  async function submitSell(ev) {
    ev.preventDefault();
    if (state.busy || !state.sell) return;
    const p = state.sell;
    const sel = $('#sell-charity');
    const charity_id = sel ? Number(sel.value) : undefined;
    state.busy = true; $('#sell-submit').disabled = true; $('#sell-submit').textContent = p.matured ? 'Collecting…' : 'Selling…';
    try {
      const r = await API.post('/sell', { position_id: p.id, charity_id });
      $('#dlg-sell').close();
      const rc = r.receipt;
      // Shrink the wedge back into bills, then refresh.
      await animateWedge(p.id, 1, 0, 420);
      await loadMe();
      const how = rc.collected ? 'Collected' : rc.busted ? 'Buried' : 'Sold early';
      if (rc.tax > 0) {
        toast(`${rc.tier}. ${how}: ${money(rc.tax)} of tax hired ${lobby(rc.tax)} for ${rc.charity.name}.`, 4200);
        flip(true);
        await hireAnimation(rc.tax);
        state.flipTimer = setTimeout(() => { if (state.flipped) flip(false); }, 3200);
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${how} for ${money(rc.net)}, back on the coin.`);
      }
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // Bills fly out of the coin into the payroll row and turn into lobbyists on the way.
  async function hireAnimation(n) {
    const coin = $('#coin');
    const row = $('#under .lobby-row .lobbyists');
    if (!coin || !row) return;
    const count = Math.min(12, Math.ceil(n - 1e-9));
    const targets = $$('.lobbyist', row).slice(-count);
    if (REDUCED || !targets.length) return;
    targets.forEach((t) => t.classList.add('arriving'));
    await new Promise((r) => setTimeout(r, 650)); // let the flip finish
    const c = coin.getBoundingClientRect();
    const x0 = c.left + c.width / 2 - 8, y0 = c.top + c.height / 2 - 16;
    const flights = targets.map((t, i) => new Promise((resolve) => {
      const r = t.getBoundingClientRect();
      const fly = document.createElement('div');
      fly.className = 'flyer';
      fly.innerHTML = `<span class="fly-bill">${BILL}</span><span class="fly-person">${LOBBYIST}</span>`;
      fly.style.left = `${x0}px`; fly.style.top = `${y0}px`;
      document.body.appendChild(fly);
      const dx = r.left - x0, dy = r.top - y0;
      const delay = i * 70, dur = 950;
      const path = fly.animate(
        [
          { transform: 'translate(0,0) scale(1.2)', opacity: 0, offset: 0 },
          { transform: `translate(${dx * 0.1}px, ${dy * 0.1 - 40}px) scale(1.25)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${dx * 0.55}px, ${dy * 0.45 - 70}px) scale(1.1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1, offset: 1 },
        ],
        { duration: dur, delay, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' },
      );
      // Mid-flight: the bill folds away, the person unfolds.
      fly.querySelector('.fly-bill').animate(
        [{ transform: 'rotateY(0deg)', opacity: 1, offset: 0 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.4 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 0.58 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      fly.querySelector('.fly-person').animate(
        [{ transform: 'rotateY(-90deg)', opacity: 0, offset: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.56 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.74 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      path.finished.then(() => { t.classList.remove('arriving'); fly.remove(); resolve(); }).catch(() => { t.classList.remove('arriving'); fly.remove(); resolve(); });
    }));
    await Promise.all(flights);
  }

  // --- share --------------------------------------------------------------------------------

  async function share() {
    const me = state.me;
    if (!me) return;
    const emoji = (p) => (p.busted ? '💀' : p.swing_pct > 0 ? '📈' : p.swing_pct < 0 ? '📉' : '➖');
    const open = me.positions.map((p) => `${emoji(p)} ${p.symbol} ${p.busted ? 'RIP' : pct(p.swing_pct, 0)}${p.matured ? ' (ready)' : ''}`);
    const locked = me.history.filter((h) => h.closed_day === me.day.key)
      .map((h) => `🔒 ${h.symbol} ${h.tier}${h.tax > 0 ? ` → ${lobby(h.tax)} for ${h.charity_name}` : ''}`);
    const lines = [
      `Trickle Down #${me.day.number}`,
      me.today_donated > 0 ? `🕴️ ${lobby(me.today_donated)} hired today` : '🕴️ No lobbyists hired yet today',
      ...locked.slice(0, 4),
      ...open.slice(0, 5),
      me.user.streak > 1 ? `🔥 ${me.user.streak}-day streak` : null,
      SITE,
    ].filter(Boolean);
    const text = lines.join('\n');
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Copied. Go brag.'); }
    } catch (e) { /* user cancelled */ }
  }

  // --- the lobby --------------------------------------------------------------------------------

  async function loadTrickle() {
    const el = $('#screen-trickle');
    el.innerHTML = `<h1>The lobby</h1><p class="lede">Loading…</p>`;
    try {
      const t = await API.get('/trickle');
      const max = Math.max(...t.charities.map((c) => c.share), 0.0001);
      el.innerHTML = `
        <h1>The lobby</h1>
        ${t.demo ? `<div class="note warn">This is a demo. The charities below are made up, the ad pool is a placeholder, and no real money is moving anywhere.</div>` : ''}
        <div class="trickle-head">
          <div class="big">${esc(lobbyN(t.quarter_total))}</div>
          <div class="muted">lobbyists hired this quarter (${esc(t.quarter)}) by ${t.quarter_donors} player${t.quarter_donors === 1 ? '' : 's'}. Headcount decides the split below.</div>
        </div>
        <div class="fest-banner">
          <div><b>Lobbyfest in <span data-fest="${esc(t.quarter_ends_at)}">${esc(untilLong(t.quarter_ends_at))}</span></b><span>${esc(festDate(t.quarter_ends_at))} at midnight Central. Every lobbyist in the game marches off, the pool is split by headcount, and everyone starts the next quarter at zero.</span></div>
        </div>
        <div class="pool">
          <div><b>${money(t.pool_usd, { whole: true })}</b><span>${t.demo ? 'pretend' : 'real'} ad money in this quarter's pool</span></div>
          <div><b>${esc(lobbyN(t.all_time))}</b><span>lobbyists hired since the game began</span></div>
        </div>
        <ul class="charities">
          ${t.charities.map((c) => `
            <li class="charity">
              <div class="charity-top">
                ${c.url ? `<a class="name" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : `<span class="name">${esc(c.name)}</span>`}
                <b>${Math.round(c.share * 100)}%</b>
              </div>
              <div class="charity-bar"><i style="--w:${(c.share / max * 100).toFixed(1)}%"></i></div>
              <div class="charity-sub">
                <span>${lobbyists(c.quarter_total, { mini: true, max: 16 })} ${esc(lobby(c.quarter_total))} from ${c.quarter_donors} player${c.quarter_donors === 1 ? '' : 's'}</span>
                <span>${t.pool_usd > 0 ? `would get ${money(c.est_usd)}` : 'share pending ad revenue'}</span>
              </div>
              <p class="blurb">${esc(c.blurb)}</p>
            </li>`).join('')}
        </ul>
        <div class="note">
          Every collected profit pays a tax in play money, and every dollar of it hires one lobbyist for a charity the player picks. Lobbyists aren't dollars. At the end of each quarter, the real money the ads on this site earned is split between the charities by headcount. Receipts get posted here when that happens.
        </div>`;
    } catch (e) {
      el.innerHTML = `<h1>The lobby</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- leaders ----------------------------------------------------------------------------------

  async function loadLeaders() {
    const el = $('#screen-leaders');
    el.innerHTML = `<h1>Leaders</h1><p class="lede">Loading…</p>`;
    try {
      const b = await API.get('/leaderboard');
      const meName = state.me ? state.me.user.username : null;
      const rowCls = (u) => (u === meName ? 'me' : '');
      el.innerHTML = `
        <h1>Leaders</h1>
        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Lobbyfest standings, ${esc(b.quarter)}. Marching in ${esc(untilLong(b.quarter_ends_at))}.</h2>
        ${b.all_time.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th class="num">This quarter</th><th class="num">Career</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${esc(r.username)}</td><td class="num">${esc(lobbyN(r.quarter || 0))}</td><td class="num muted">${esc(lobbyN(r.donated))}</td><td class="num">${r.streak}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">Nobody has collected a profit yet. The board is yours.</p>`}

        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Best cash-out, last 24 hours</h2>
        ${b.last_24h.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th>Trade</th><th class="num">Gain</th></tr></thead>
          <tbody>${b.last_24h.map((r, i) => `
            <tr>
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${esc(r.username)}</td>
              <td><span class="tier">${esc(r.tier)}</span>${esc(r.symbol)} ${money(r.invested)} → ${money(r.proceeds)}</td>
              <td class="num ${dir(r.gain_pct)}">${pct(r.gain_pct, 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">No cash-outs in the last day.</p>`}`;
    } catch (e) {
      el.innerHTML = `<h1>Leaders</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- how -----------------------------------------------------------------------------------------

  function renderHow() {
    const me = state.me;
    const rules = me ? me.rules : { daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, mult_floor: 1, demo: true };
    const earned = me ? me.user.badges.earned.map((b) => b.name) : [];
    const badgeList = [
      { at: 1, name: 'Intern' }, { at: 10, name: 'Staffer' }, { at: 50, name: 'Consultant' }, { at: 250, name: 'Lobbyist' },
      { at: 1000, name: 'Fixer' }, { at: 5000, name: 'Kingmaker' }, { at: 25000, name: 'Shadow Cabinet' },
    ];
    $('#screen-how').innerHTML = `
      <h1>How it works</h1>
      ${rules.demo ? `<div class="note warn">Demo. The charities are fictional and no real money moves. The game is real; the philanthropy isn't yet.</div>` : ''}
      <div class="rules">
        <h2>The coin</h2>
        <p>Every day you show up, ${money(rules.daily_base, { whole: true })} in bills lands on your coin. It isn't real. Keep showing up and it grows: ${money(rules.streak_bonus, { whole: true })} more for each day of your streak, up to ${money(rules.daily_cap, { whole: true })} a day. Miss a day and you're back to ${money(rules.daily_base, { whole: true })}.</p>

        <h2>Buying</h2>
        <p>Pick any stock, crypto, or fund in the list, then say how much: a dollar amount, or a slice of what's free. You buy at the live price and the slice becomes a wedge on the coin. Bills you don't spend roll over.</p>

        <h2>The ${rules.hold_hours} hours</h2>
        <p>Every buy lives ${rules.hold_hours} hours. It moves with the real market, and the longer it lives the harder it hits: the multiplier starts at ${mult(rules.mult_floor)} the moment you buy and climbs steadily to ${mult(10)} for stocks and ${mult(5)} for crypto at the ${rules.hold_hours}-hour mark. At that moment it matures: the value freezes at whatever the price is then, and it's ready to collect. Nvidia up 1.5% over the full day means your wedge is up 15%. A wedge can shrink to nothing. It cannot go below nothing. We checked.</p>

        <h2>Collecting, riding, selling early</h2>
        <p>Tap a wedge. A matured one collects in full: a profit is taxed ${Math.round(rules.tax_rate * 100)}%, a loss isn't, and the rest turns back into bills on the coin. Or let it ride: the whole frozen value goes back on the same stock at today's price for another ${rules.hold_hours} hours, untaxed, with the multiplier starting over. Nobody gets hired, and it can still go to zero. A live wedge can be sold early at the current price and the current, smaller multiplier, if you'd rather not find out.</p>

        <h2>Lobbyists</h2>
        <p>Every dollar of tax hires one lobbyist for a charity you pick. They are not dollars. You can hire a fraction of a lobbyist; it looks about how you'd expect. Flip the coin to see your payroll, your rank, and every cash-out on record.</p>

        <h2>Lobbyfest</h2>
        <p>At midnight Central on the last day of every quarter, every lobbyist in the game marches off to Lobbyfest. The ads on this site earn real dollars, and that's when all of it is split between the charities on the Lobby page by headcount: a charity with a third of the lobbyists gets a third of the money. Then every payroll resets to zero and the next quarter starts. Your fake tax is a vote on where the real money goes. Nothing you do here costs you anything. That's the whole point.</p>

        <h2>Ranks</h2>
        <p>Ranks are for your career: every lobbyist you've ever hired, across every Lobbyfest.</p>
        <ul class="badges">
          ${badgeList.map((b) => `<li class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b>${b.at} lobbyist${b.at === 1 ? '' : 's'}</li>`).join('')}
        </ul>

        <h2>Fine print</h2>
        <p class="muted">Prices come from Finnhub and CoinGecko and can be a minute or so behind. Stocks don't trade on weekends; a stock bought Friday afternoon mostly sits still until it matures. Crypto never sleeps. The game day rolls over at midnight Central. None of this is investment advice. Obviously.</p>
      </div>`;
  }

  // --- auth sheet ----------------------------------------------------------------------------------

  function openAuth(mode) {
    state.authMode = mode;
    const title = { login: 'Sign in', register: 'Create an account', claim: 'Keep this account' }[mode];
    const blurb = {
      login: 'Pick up where you left off.',
      register: 'A username and a password. That\'s it.',
      claim: 'Give your guest account a name and a password so it follows you to other devices.',
    }[mode];
    $('#auth-title').textContent = title;
    $('#auth-blurb').textContent = blurb;
    $('#auth-submit').textContent = title;
    $('#auth-switch').hidden = mode === 'claim';
    $('#auth-switch').textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
    $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-error').hidden = true;
    $('#auth-user').value = ''; $('#auth-pass').value = '';
    $('#dlg-auth').showModal();
    setTimeout(() => $('#auth-user').focus(), 50);
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const username = $('#auth-user').value.trim();
    const password = $('#auth-pass').value;
    const path = { login: '/auth/login', register: '/auth/register', claim: '/auth/claim' }[state.authMode];
    state.busy = true; $('#auth-submit').disabled = true;
    try {
      const r = await API.post(path, { username, password });
      API.setToken(r.token);
      $('#dlg-auth').close();
      toast(state.authMode === 'claim' ? `You're ${r.user.username} now. It'll remember you.` : `Hi, ${r.user.username}.`);
      state.me = null;
      location.hash = '#today'; route();
    } catch (e) {
      $('#auth-error').textContent = e.message; $('#auth-error').hidden = false;
    } finally { state.busy = false; $('#auth-submit').disabled = false; }
  }

  // --- wiring ----------------------------------------------------------------------------------------

  function wire() {
    $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
    $$('dialog.sheet').forEach((d) => { d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); });
    $('#form-sell').addEventListener('submit', submitSell);
    $('#form-auth').addEventListener('submit', submitAuth);
    $('#auth-switch').onclick = () => openAuth(state.authMode === 'login' ? 'register' : 'login');
    $('#btn-claim').onclick = () => openAuth('claim');
    $('#btn-signout').onclick = () => { API.setToken(null); state.me = null; state.flipped = false; location.hash = ''; route(); };
    window.addEventListener('hashchange', route);

    // Keep the clocks honest and the coin fresh while the tab is open, but
    // never yank the carve panel out from under someone mid-slice.
    const carving = () => state.carve > 0 || state.selected || ['carve-usd', 'carve-search'].includes(document.activeElement && document.activeElement.id);
    setInterval(() => {
      if (!state.me) return;
      $('#day-countdown').textContent = `New money in ${countdown(state.me.day.resets_at)}`;
      tickTimes();
      if (new Date(state.me.day.resets_at) <= Date.now() && state.tab === 'today' && !carving()) loadMe();
    }, 30_000);
    setInterval(() => {
      if (state.me && state.tab === 'today' && document.visibilityState === 'visible' && !$('#dlg-sell').open && !carving()) loadMe();
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.me && state.tab === 'today' && !carving()) loadMe();
    });
  }

  wire();
  route();
})();
