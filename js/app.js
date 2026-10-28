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
  // The multipliers a ride off position p would run at: the new day starts
  // where this one ended and climbs by the asset's base multiplier, up to a cap.
  function rideMults(p) {
    const base = p.asset_type === 'crypto' ? 5 : 10;
    const steps = state.me && state.me.rules.ride_max_steps != null ? state.me.rules.ride_max_steps : 2;
    const cap = base * (1 + steps);
    const floor = Math.min(p.multiplier, cap);
    return { floor, ceiling: Math.min(floor + base, cap), capped: floor >= cap };
  }
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

  const UNCONFIGURED = !API.demo && /YOUR-HEROKU-APP/.test((window.TRICKLE_CONFIG || {}).API_BASE || '');

  async function route() {
    const hash = (location.hash || '#today').slice(1);
    if (UNCONFIGURED) { showScreen('welcome'); renderUnconfigured(); return; }
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

  function renderUnconfigured() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Not connected yet.</h1>
        <p>This copy of Trickle Down doesn't know where its backend lives. In <code>config.js</code>, set <code>API_BASE</code> to your Heroku app's URL (see DEPLOY.md), then reload.</p>
        <p class="muted">Want to see the game without a backend? <a href="?demo">Open the demo</a>: invented prices, made-up charities, nothing saved.</p>
      </div>`;
  }

  function renderWelcome() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Fake money. Real market. Real charity.</h1>
        <p>Every day you get $100 that isn't real. Carve it up across any stocks or coins you like. Each bet lives 24 hours, and the longer it lives, the harder it hits: your money tracks the real move at the start and climbs to ten times it by the end (five for crypto).</p>
        <p>Collect a win and a quarter of the profit is taxed. The tax hires lobbyists for a charity you pick, a dollar a head. They aren't dollars. The ads on this site earn real money, and every quarter it's split between the charities by how many lobbyists each one has.</p>
        <p>Lose and nothing happens. Win and something does.</p>
        <div class="row-actions">
          <button class="btn primary" id="btn-guest">Play as a guest</button>
          <button class="btn" id="btn-signin">Sign in</button>
        </div>
        <button class="linkish" id="btn-orient" style="margin-top:14px">Watch the 60-second orientation</button>
      </div>`;
    $('#btn-orient').onclick = () => Explainer.open({ deck: 'main' });
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
      // The server hands out a fresh token when the current one is past half
      // its life, so a guest who keeps showing up is never signed out.
      if (me.token && !API.demo) API.setToken(me.token);
      setSignedIn(true);
      renderToday();
      if (!Explainer.seen('main') && !state.oriented) {
        state.oriented = true;
        setTimeout(() => Explainer.open({ deck: 'main', rules: me.rules }), me.allowance && !REDUCED ? 1700 : 300);
      }
      if (me.allowance) {
        tossCoin();
        const a = me.allowance;
        const ti = a.town_income || 0;
        const village = ti ? ` (${money(a.base != null ? a.base : a.amount - ti, { whole: true })} stipend ${ti > 0 ? '+' : '−'} ${money(Math.abs(ti), { whole: true })} ${ti > 0 ? 'from' : 'upkeep for'} TrickleTown)` : '';
        const quit = me.town && me.town.report && me.town.report.quit > 0 ? ` ${lobby(me.town.report.quit)} quit overnight.` : '';
        setTimeout(() => toast(`${me.user.streak > 1 ? `Day ${me.user.streak} of your streak: ` : ''}${money(a.amount, { whole: true })} landed on the coin${village}.${quit}`, 4200), REDUCED ? 0 : 1100);
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

  function pendingIssues() {
    const t = state.me && state.me.town;
    return t && t.unlocked ? t.issues.filter((i) => !i.chosen).length : 0;
  }

  // The TrickleTown tour, once, the first time the town is open and nobody's
  // in the middle of another tutorial.
  function maybeTownIntro(delay = 0) {
    setTimeout(() => {
      const me = state.me;
      if (!me || !me.town || !me.town.unlocked || Explainer.seen('town') || Explainer.isOpen()) return;
      if (state.tab !== 'today' || !state.flipped || $('#dlg-hire').open) return;
      Explainer.open({ deck: 'town', onDone: () => { if (!state.flipped) flip(true); setTimeout(() => { const a = $('#agenda'); if (a) a.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }, 500); } });
    }, delay);
  }

  function coinBackMarkup() {
    const me = state.me;
    const q = Math.max(0, me.user.quarter_donated || 0);
    const svg = Coin.village({ town: me.town, pop: round2(q), pending: pendingIssues(), locked: !me.town.unlocked, progress: me.user.total_donated });
    return `${svg}<button class="coin-tap village-tap" type="button" aria-label="Flip the coin back"></button>`;
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
    const ride = p.ride_count > 0 ? `<br><span class="time">Riding ×${p.ride_count}, ${mult(p.mult_floor)} → ${mult(p.multiplier)}, started with ${money(p.origin_invested)}.</span>` : '';
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
    $$('.v-advocate').forEach((g) => { g.style.cursor = 'pointer'; g.onclick = (e) => { e.stopPropagation(); openAdvisors(); }; });
    $$('.v-site').forEach((g) => { g.style.cursor = 'pointer'; g.onclick = (e) => { e.stopPropagation(); if (state.me.town.unlocked) openSite(g.dataset.site); }; });
    const cash = $('.cash-sector');
    if (cash) {
      cash.onclick = () => { hideTip(); const i = $('#carve-search'); const u = $('#carve-usd'); if (u && !u.closest('[hidden]')) { u.focus(); u.select(); } else if (i) i.focus(); };
      cash.onpointerenter = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointermove = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointerleave = hideTip;
    }
  }

  function captionMarkup() {
    const n = pendingIssues();
    const locked = state.me && state.me.town && !state.me.town.unlocked;
    if (locked) {
      return state.flipped
        ? `<div class="side-label"><b>Tails.</b> Under construction. <span class="muted">Heads is your portfolio.</span></div><button class="btn quiet small" id="btn-flip">Flip to portfolio</button>`
        : `<div class="side-label"><b>Heads.</b> Your portfolio. <span class="muted">Tails is a secret.</span></div><button class="btn quiet small" id="btn-flip">Flip the coin</button>`;
    }
    const unmet = !Explainer.seen('town');
    return state.flipped
      ? `<div class="side-label"><b>Tails.</b> TrickleTown, where your lobbyists live. <span class="muted">Heads is your portfolio.</span></div><button class="btn quiet small" id="btn-flip">Flip to portfolio</button>`
      : `<div class="side-label"><b>Heads.</b> Your portfolio. <span class="muted">${unmet ? 'Your lobbyists are waiting on tails.' : 'Tails is your village.'}</span></div><button class="btn small ${n || unmet ? 'primary' : 'quiet'}" id="btn-flip">${unmet ? 'Meet your lobbyists' : n ? `Village: ${n} issue${n === 1 ? '' : 's'}` : 'Flip to village'}</button>`;
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
    // The first visit to an open village gets the tour, after the flip lands.
    if (state.flipped && !state.ceremony && state.me && state.me.town && state.me.town.unlocked && !Explainer.seen('town')) maybeTownIntro(REDUCED ? 100 : 750);
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
    const riding = p.ride_count > 0 ? ` Riding ×${p.ride_count}, ${mult(p.mult_floor)} → ${mult(p.multiplier)}, started with ${money(p.origin_invested)}.` : '';
    const late = p.matured_late ? ` <span class="muted">Froze late: nobody was around at the 24-hour mark, so it froze at the next price we saw.</span>` : '';
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
      move = `${bought} Matured <span data-ago="${esc(p.matured_at)}">${ago(p.matured_at)}</span> at ${price(p.price)}, ${mult(p.multiplier)}.${late} <span class="ready">Ready to collect, or let it ride.</span>`;
      action = `<button class="btn small primary" data-sell="${p.id}">Collect</button> <button class="btn small" data-ride="${p.id}">Ride</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${bought} Real ${pct(p.real_pct)} at ${mult(p.multiplier_now)}. <span class="time"><span data-left="${esc(p.matures_at)}">${left(p.matures_at)}</span> to ${mult(p.multiplier)}.</span>${p.deferred_tax > 0 ? ` <span class="muted">Sell early and ${money(p.deferred_tax)} of deferred ride tax comes due.</span>` : ''}`;
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
    const friends = (crowd.friends || []).filter((f) => f.symbols && f.symbols.length);
    const friendLine = friends.length
      ? `<p class="muted crowd-friends" style="font-size:14px">${friends.slice(0, 4).map((f) => `<a href="#" class="player-link" data-player="${esc(f.username)}">${esc(f.username)}</a> bought ${f.symbols.map((s) => `<b>${esc(s)}</b>`).join(', ')}`).join('; ')}${friends.length > 4 ? `; and ${friends.length - 4} more` : ''}.</p>`
      : '';
    return `<p class="muted" style="font-size:14px">Everyone plays the same market. ${total} buy${total === 1 ? '' : 's'} today from ${crowd.players} player${crowd.players === 1 ? '' : 's'}: ${crowd.picks.map((c) => `<b>${esc(c.symbol)}</b> ${Math.round(c.buys / total * 100)}%`).join(', ')}.</p>${friendLine}`;
  }

  // Refresh the "3h ago" / "21h 12m" bits without rebuilding the panel.
  function tickTimes() {
    $$('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); });
    $$('[data-left]').forEach((el) => { el.textContent = left(el.dataset.left); });
    $$('[data-fest]').forEach((el) => { el.textContent = untilLong(el.dataset.fest); });
  }

  function wireFront() {
    $$('[data-sell]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.sell)); });
    $$('[data-ride]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.ride), { ride: true }); });
    $$('[data-player]').forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openPlayer(a.dataset.player); }; });
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
    const closed = q && a.type !== 'crypto' && q.traded_at && (Date.now() - new Date(q.traded_at)) > 30 * 60e3;
    const qline = !q ? `Getting a price…`
      : `<b>${price(q.price)}</b> ${closed ? `last trade ${ago(q.traded_at)}` : 'right now'}${q.change_pct == null ? '' : `, today <span class="${dir(q.change_pct)}">${pct(q.change_pct)}</span>`}${q.stale ? ' <span class="down">(price feed is lagging)</span>' : ''}${closed ? `<br><span class="muted">Markets look closed. You'd buy at that price, and it won't move until they open.</span>` : ''}`;
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

  // --- Tails: TrickleTown -----------------------------------------------------------------

  const CLUE_LABEL = { allowance: 'Allowance', cash: 'Cash now', happiness: 'Happiness', hiring: 'Hiring cost', health: 'Health' };
  const TIER_LABEL = { bad: 'Extractive', compromise: 'Compromise', good: 'Decent' };
  const WHO = { preston: { name: 'Preston Yield', role: 'Value Extraction Partner' }, dolores: { name: 'Dolores Pike', role: 'Lobbyist for Lobbyists' } };

  // ▲▼ hints, never exact numbers. Green means good for you.
  function clueChips(clues, cls = '') {
    return `<span class="clues ${cls}">${clues.map((c) => {
      const good = c.k === 'hiring' ? c.dir < 0 : c.dir > 0;
      return `<span class="clue ${good ? 'good' : 'bad'}">${esc(CLUE_LABEL[c.k])} ${(c.dir > 0 ? '▲' : '▼').repeat(c.n)}</span>`;
    }).join('')}</span>`;
  }

  // What actually happened, once it has.
  function fxChips(fx) {
    const out = [];
    if (fx.cash) out.push(`<span class="clue ${fx.cash > 0 ? 'good' : 'bad'}">Cash ${fx.cash > 0 ? '+' : '−'}${money(Math.abs(fx.cash), { whole: true })}</span>`);
    if (fx.income) out.push(`<span class="clue ${fx.income > 0 ? 'good' : 'bad'}">Allowance ${fx.income > 0 ? '+' : '−'}${money(Math.abs(fx.income), { whole: true })}/day</span>`);
    if (fx.happy) out.push(`<span class="clue ${fx.happy > 0 ? 'good' : 'bad'}">Happiness ${fx.happy > 0 ? '+' : '−'}${Math.abs(fx.happy)}</span>`);
    if (fx.health) out.push(`<span class="clue ${fx.health > 0 ? 'good' : 'bad'}">Health ${fx.health > 0 ? '+' : '−'}${Math.abs(fx.health)}</span>`);
    return `<span class="clues">${out.join('')}</span>`;
  }

  function meter(label, value, opts = {}) {
    const warn = opts.warnBelow != null && value < opts.warnBelow;
    return `<div class="meter ${warn ? 'warn' : ''}">
      <div class="meter-top"><span>${esc(label)}</span><b>${value}</b></div>
      <div class="meter-bar"><i style="--w:${value}%"></i>${opts.warnBelow != null ? `<s style="--at:${opts.warnBelow}%"></s>` : ''}</div>
      ${opts.note ? `<div class="meter-note">${opts.note}</div>` : ''}
    </div>`;
  }

  function reportLine(r) {
    if (!r || r.first_day) return '';
    const bits = [];
    bits.push(r.income >= 0 ? `TrickleTown paid <b>${money(r.income)}</b> into your allowance` : `TrickleTown's upkeep took <b>${money(-r.income)}</b> from your allowance`);
    if (r.happy_delta) bits.push(`happiness ${r.happy_delta > 0 ? '▲' : '▼'}${Math.abs(r.happy_delta)}`);
    if (r.health_delta) bits.push(`health ${r.health_delta > 0 ? '▲' : '▼'}${Math.abs(r.health_delta)}`);
    let out = `Overnight: ${bits.join(', ')}.`;
    if (r.quit > 0) out += ` <b class="down">${esc(lobby(r.quit))} quit.</b> Reason given: "the conditions."`;
    if (r.ignored) out += ` You left ${r.ignored} card${r.ignored === 1 ? '' : 's'} unplayed yesterday. They noticed.`;
    return `<p class="v-report">${out}</p>`;
  }

  // The construction zone: one tile per plot. Tap to open the Site Office.
  function zoneTile(p) {
    const b = p.building;
    const badge = !b ? '<span class="zone-badge build">Tap to build</span>'
      : p.proposals ? `<span class="zone-badge proposal">${p.proposals} proposal${p.proposals === 1 ? '' : 's'}</span>`
      : '';
    return `<button type="button" class="zone-tile ${b ? `tier-${b.tier}` : 'empty'}" data-site="${esc(p.slot)}">
      ${Coin.buildingIcon(p.key, 150)}
      <span class="zone-text">
        <span class="plot-label">${esc(p.label)}</span>
        <b>${b ? esc(b.name) : 'Empty lot'}</b>
        <small>${b ? `${TIER_LABEL[b.tier]} · day ${p.days + 1}` : 'Zoned for anything.'}</small>
      </span>
      ${badge}
    </button>`;
  }

  function lockedMarkup() {
    const me = state.me;
    const have = Math.max(0, me.user.total_donated || 0);
    const need = me.town.unlock_at || 1;
    return `
      <div class="side-head"><h2>Under construction</h2><span class="muted">Something is being built.</span></div>
      <section class="locked">
        <p><b>Hire your first full lobbyist and this side opens.</b> They'll need somewhere to live.</p>
        <div class="lobby-row"><b>${esc(lobbyN(have))} / ${need}</b>${have > 0 ? lobbyists(have) : ''}</div>
        <div class="rank-bar"><i style="--w:${Math.min(100, (have / need) * 100).toFixed(0)}%"></i></div>
        <p class="muted small">Collect a profit on heads. A quarter of it is taxed, and the tax hires lobbyists.</p>
        <div class="row-actions"><button class="btn quiet small" id="btn-flip-back">Flip to portfolio</button></div>
      </section>`;
  }

  // The collection: every card, with what unlocks it.
  function deckMarkup(deck) {
    const order = { today: 0, played: 1, available: 2, locked: 3 };
    const sorted = [...deck].sort((a, b) => order[a.status] - order[b.status]);
    const counts = deck.reduce((m, d) => { m[d.status] = (m[d.status] || 0) + 1; return m; }, {});
    return `<section class="deck">
      <h3>The deck <span class="muted">${deck.length - (counts.locked || 0)} of ${deck.length} unlocked</span></h3>
      <p class="muted small">Two cards a day: one everyone gets, one from whatever your town has unlocked. The rest are waiting.</p>
      <div class="deck-grid">${sorted.map((d) => `
        <div class="mini-card ${d.status} ${d.general ? 'general' : ''}">
          <span class="mini-status">${{ today: 'In hand', played: 'Played today', available: 'In the pile', locked: 'Locked' }[d.status]}</span>
          <b>${d.status === 'locked' ? '???' : esc(d.title)}</b>
          ${d.consequence ? '<span class="mini-tag">consequences</span>' : d.followup ? '<span class="mini-tag followup">follow-up</span>' : ''}
          <span class="mini-needs">${d.general ? 'Everyone gets this one.' : d.status === 'locked' ? esc(d.needs) : esc(d.needs.replace(/^Unlock:/, 'Unlocked:'))}</span>
          ${d.seen && d.status !== 'played' ? '<span class="mini-seen">✓ played before</span>' : ''}
        </div>`).join('')}</div>
    </section>`;
  }

  function backMarkup() {
    const me = state.me;
    if (!me.town.unlocked) return lockedMarkup();
    const { user, history, day, town } = me;
    const given = me.donations_by_charity.filter((c) => c.amount > 0);
    const q = Math.max(0, user.quarter_donated || 0);
    const badges = user.badges, next = badges.next;
    const have = badges.earned.length ? badges.earned[badges.earned.length - 1] : null;
    const prevAt = have ? have.at : 0;
    const progress = next ? Math.min(100, ((user.total_donated - prevAt) / (next.at - prevAt)) * 100) : 100;
    const pending = pendingIssues();
    const decided = town.issues.length - pending;
    return `
      <div class="side-head">
        <div><h2>TrickleTown</h2><div class="motto">“${esc(town.motto)}”</div></div>
        <span class="muted">Lobbyfest in <b data-fest="${esc(day.quarter_ends_at)}">${esc(untilLong(day.quarter_ends_at))}</b></span>
      </div>

      <div class="lobby-row"><b>${esc(lobbyN(q))}</b>${q > 0 ? lobbyists(q) : '<span class="muted">Nobody lives here yet this quarter.</span>'}</div>
      ${reportLine(town.report)}

      <section class="meters">
        <div class="meter money"><div class="meter-top"><span>Village income</span><b class="${town.income >= 0 ? 'up' : 'down'}">${town.income >= 0 ? '+' : '−'}${money(Math.abs(town.income))}/day</b></div><div class="meter-note">added to tomorrow's allowance</div></div>
        <div class="meter money"><div class="meter-top"><span>Recruiter's rate</span><b>${money(town.hire_cost)}</b></div><div class="meter-note">tax per lobbyist. Happier is cheaper.</div></div>
        ${meter('Happiness', town.happiness)}
        ${meter('Health', town.health, { warnBelow: town.quit_below, note: town.health < town.quit_below ? `<b class="down">They're quitting: about ${Math.round(town.quit_rate * 100)}% a night.</b>` : `Below ${town.quit_below}, they start quitting.` })}
      </section>

      <section class="advisors-cta ${pending ? 'waiting' : ''}">
        <div class="advisors-faces">${Coin.preston(52)}${Coin.dolores(52)}</div>
        <div class="advisors-text">
          <b>${pending ? `${pending} card${pending === 1 ? '' : 's'} on the table` : decided ? "Today's cards are played" : 'Nobody is waiting'}</b>
          <span class="muted">${pending ? 'Preston and Dolores each have a pitch. Pick one per card.' : decided ? 'Come back tomorrow for two more. Or review how it went.' : 'The advisors are out. New cards at midnight.'}</span>
        </div>
        <button type="button" class="btn ${pending ? 'primary' : 'quiet'}" id="btn-advisors">${pending ? 'Speak with your advisors' : 'Review'}</button>
      </section>

      <section class="zone">
        <h3>Construction zone <span class="muted">${town.plots.filter((p) => p.building).length} of ${town.plots.length} lots built</span></h3>
        <div class="zone-grid">${town.plots.map(zoneTile).join('')}</div>
        <p class="muted small">Tap a lot to build on it, or to hear proposals for what's already there. Buildings cost ${money(town.build_cost, { whole: true })}; proposals unlock as the town grows.</p>
      </section>

      ${deckMarkup(town.deck)}

      <section class="records">
        <h3>Payroll</h3>
        <p class="fest">On ${esc(festDate(day.quarter_ends_at))} every lobbyist in the game marches off to Lobbyfest. They vote, the real money is split between the charities by headcount, and every village empties for the next quarter. Your buildings and your rank stay.</p>
        ${given.length ? `<ul class="given">${given.map((c, i) => `
          <li><span><span class="sw" style="background:${CHARITY_COLORS[i % 6]}"></span>${esc(c.name)}</span><span>${lobbyists(c.amount, { mini: true, max: 12 })} <b>${esc(lobbyN(c.amount))}</b></span></li>`).join('')}</ul>` : ''}
        <div class="rank"><b>${have ? esc(have.name) : 'No rank yet'}</b><span class="muted">${have ? `is your rank, for ${esc(lobby(user.total_donated))} hired all time.` : 'Ranks count every lobbyist you ever hire.'}</span></div>
        <div class="rank-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
        <div class="rank-line">${next ? `${esc(next.name)} at ${next.at} lobbyists. ${lobbyN(next.at - user.total_donated)} to go.` : 'There is nothing above this.'}</div>
        <details class="records-more"><summary>Records</summary>
        ${history.length ? `<ul class="history">${history.map((h) => {
          const hired = h.lobbyists != null ? h.lobbyists : h.tax;
          return `<li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)} <span class="muted">${h.rode ? 'rode on, half tax' : h.collected ? 'collected' : h.proceeds > 0 ? 'sold early' : 'buried'}</span></span>
            <span class="to">${hired > 0 ? `${esc(lobby(hired))} for ${esc(h.charity_name)}` : shortDate(h.closed_at)}</span>
          </li>`;
        }).join('')}</ul>` : `<p class="muted">Nothing collected yet. The records start when you do.</p>`}
        </details>
        <div class="row-actions"><button class="btn quiet small" id="btn-flip-back">Flip to portfolio</button><a class="btn quiet small" href="#trickle">The whole lobby</a></div>
      </section>`;
  }

  // After any village change, redraw the coin, the caption and the panel in place.
  function refreshVillage(town, user) {
    clearTimeout(state.flipTimer);
    state.me.town = town;
    if (user) state.me.user = { ...state.me.user, ...user };
    paintCoin();
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); $('#btn-flip').onclick = () => flip(); }
    const y = window.scrollY;
    renderUnder();
    window.scrollTo({ top: y });
  }

  const REACTIONS = {
    preston: ['Preston is delighted. He is already drafting the press release.', 'Preston gives you a thumbs-up and a business card. You already have six.', 'Preston nods. Somewhere, a number went up.', 'Preston says "love that for us." He means him.'],
    dolores: ['Dolores nods once. From her, that is a standing ovation.', 'Dolores writes something on her clipboard. It might be your name. It might be "fine."', 'Dolores says "huh." It is the warmest thing she has said all week.', 'Dolores does not smile, but she does not not smile.'],
  };
  const reaction = (who) => REACTIONS[who][Math.floor(Math.random() * REACTIONS[who].length)];

  async function townPost(path, body, btn) {
    if (state.busy) return null;
    state.busy = true; if (btn) btn.disabled = true;
    try { return await API.post(path, body); }
    catch (e) { toast(e.message, 3600); if (btn) btn.disabled = false; return null; }
    finally { state.busy = false; }
  }

  function wireBack() {
    const b = $('#btn-flip-back'); if (b) b.onclick = () => flip(false);
    const adv = $('#btn-advisors'); if (adv) adv.onclick = () => openAdvisors();
    $$('[data-site]').forEach((btn) => { btn.onclick = () => openSite(btn.dataset.site); });
  }

  // --- The Site Office: build a plot, hear proposals --------------------------------------

  const site = { slot: null, mode: 'office', i: 0, result: null };
  const plotOf = (slot) => state.me.town.plots.find((p) => p.slot === slot);

  function openSite(slot, mode) {
    clearTimeout(state.flipTimer);
    if (!state.flipped) flip(true);
    const p = plotOf(slot);
    if (!p) return;
    site.slot = slot; site.result = null; site.i = 0;
    site.mode = mode || (p.building ? 'office' : 'build');
    renderSite();
    const d = $('#dlg-site');
    if (!d.open) d.showModal();
  }

  function sitePitch(o, who, costLabel, data) {
    const w = WHO[who];
    return `<button type="button" class="adv-pitch ${who}" ${data}>
      <span class="adv-who">${Coin[who](44)}<span><b>${esc(w.name)}</b><small>${esc(w.role)}</small></span></span>
      <span class="option-head"><span class="tier-badge tier-${o.tier}">${TIER_LABEL[o.tier]}</span><b>${esc(o.name)}</b></span>
      <q>${esc(o.pitch.line)}</q>
      ${clueChips(o.clues)}
      <span class="adv-label">${esc(costLabel)}</span>
    </button>`;
  }

  function renderSite() {
    const p = plotOf(site.slot);
    const stage = $('#site-stage');
    $('#site-title').textContent = `Site Office · ${p.label}`;
    const cost = state.me.town.build_cost;
    const cash = state.me.user.cash;

    if (site.mode === 'build') {
      const rebuilding = !!p.building;
      stage.innerHTML = `
        <div class="adv-card" id="site-card">
          <div class="adv-band village">${rebuilding ? 'Rebuilding' : 'Empty lot'} · ${esc(p.label)}</div>
          <h3>${rebuilding ? `What replaces ${esc(p.building.name)}?` : 'What goes here?'}</h3>
          <p>${rebuilding ? `Tearing it down takes its upgrades with it. The new building costs ${money(cost, { whole: true })}.` : `Three proposals on the desk. One costs ${money(cost, { whole: true })} and pays you back. One costs ${money(cost, { whole: true })} and pays them back. One is a compromise, which is a word that means "both are annoyed."`}</p>
          <p class="muted small">You have ${money(cash)} on the coin.</p>
        </div>
        <div class="site-options">
          ${p.options.filter((o) => o.key !== p.key).map((o) => sitePitch(o, o.pitch.who, `Build it (${money(cost, { whole: true })})`, `data-build="${esc(o.key)}" ${cash < cost ? 'disabled' : ''}`)).join('')}
        </div>
        <div class="adv-foot">${rebuilding ? '<button type="button" class="linkish" data-site-mode="office">Keep what\'s there</button>' : '<span></span>'}<span class="muted small">${cash < cost ? `Need ${money(cost - cash)} more.` : ''}</span></div>`;
      wireSite(); return;
    }

    const b = p.building;
    if (site.mode === 'proposal') {
      const avail = b.upgrades.filter((u) => u.status === 'available');
      if (site.result) {
        const r = site.result;
        stage.innerHTML = `
          <div class="adv-card result ${r.who}">
            <div class="adv-band">${esc(b.name)}</div>
            <div class="adv-result-who">${Coin[r.who](56)}<div><b>${esc(r.name)}: built.</b><span>${money(r.cost, { whole: true })}, from the coin</span></div></div>
            <p>${esc(r.line)}</p>
            ${clueChips(r.clues)}
            <p class="muted small">Those arrows push every day from now on.</p>
            <div class="adv-actions"><button type="button" class="btn primary" data-site-mode="office">Back to the office</button></div>
          </div>`;
        wireSite(); return;
      }
      if (!avail.length || site.i >= avail.length) { site.mode = 'office'; renderSite(); return; }
      const u = avail[site.i];
      const who = u.pitch.who, other = who === 'preston' ? 'dolores' : 'preston';
      stage.innerHTML = `
        <div class="adv-card" id="site-card">
          <div class="adv-band village">Proposal · ${esc(b.name)} · ${site.i + 1} of ${avail.length}</div>
          <span class="adv-tag">${TIER_LABEL[u.tier]}</span>
          <h3>${esc(u.name)}</h3>
          <p class="muted">${esc(u.needs.replace(/^(Unlock|Happens when): /, '')).replace(/\.$/, '')}, so it's on the table now.</p>
        </div>
        <div class="adv-pitches">
          <button type="button" class="adv-pitch ${who}" data-upgrade="${esc(u.key)}" ${cash < u.cost ? 'disabled' : ''}>
            <span class="adv-who">${Coin[who](44)}<span><b>${esc(WHO[who].name)}</b><small>proposes</small></span></span>
            <q>${esc(u.pitch.line)}</q>
            ${clueChips(u.clues)}
            <span class="adv-label">Build it <small>(${money(u.cost, { whole: true })})</small></span>
          </button>
          <button type="button" class="adv-pitch ${other}" data-pass="1">
            <span class="adv-who">${Coin[other](44)}<span><b>${esc(WHO[other].name)}</b><small>objects</small></span></span>
            <q>${esc(u.objection)}</q>
            <span class="muted small">Passing keeps it on the table. It isn't going anywhere.</span>
            <span class="adv-label">Not now</span>
          </button>
        </div>
        <div class="adv-foot"><button type="button" class="linkish" data-site-mode="office">Back to the office</button><span class="muted small">${cash < u.cost ? `Need ${money(u.cost - cash)} more.` : `${money(cash)} on the coin`}</span></div>`;
      wireSite(); return;
    }

    // office: the building, what it does, proposals waiting, the rest of the list
    const avail = b.upgrades.filter((u) => u.status === 'available');
    const owned = b.upgrades.filter((u) => u.status === 'owned');
    const locked = b.upgrades.filter((u) => u.status === 'locked');
    stage.innerHTML = `
      <div class="adv-card site-office tier-${b.tier}">
        <div class="adv-band village">${esc(p.label)} · day ${p.days + 1}</div>
        <span class="tier-badge tier-${b.tier}" style="float:right;margin-top:6px">${TIER_LABEL[b.tier]}</span>
        <h3>${esc(b.name)}</h3>
        <p class="plot-sign">${esc(b.sign)}</p>
        <div class="site-icon">${Coin.buildingIcon(b.key, 200)}</div>
        <div class="plot-now">${clueChips(b.clues)}<span class="muted small">per day, with upgrades</span></div>
        ${owned.length ? `<p class="small"><b>Built:</b> ${owned.map((u) => esc(u.name)).join(', ')}.</p>` : ''}
        ${locked.length ? `<ul class="site-locked">${locked.map((u) => `<li><span class="lock">🔒</span> <b>${esc(u.name)}</b> <span class="muted">${esc(u.needs)}</span></li>`).join('')}</ul>` : ''}
        <div class="adv-actions">
          ${avail.length ? `<button type="button" class="btn primary" data-site-mode="proposal">Hear ${avail.length === 1 ? 'the proposal' : `${avail.length} proposals`}</button>` : '<span class="muted small">No proposals today. They arrive as the town grows.</span>'}
          <button type="button" class="btn quiet" data-site-mode="build">Tear down</button>
        </div>
      </div>`;
    wireSite();
  }

  function wireSite() {
    const dlg = $('#dlg-site');
    const p = plotOf(site.slot);
    $$('[data-site-mode]', dlg).forEach((b) => { b.onclick = () => { site.mode = b.dataset.siteMode; site.i = 0; site.result = null; renderSite(); }; });
    $$('[data-pass]', dlg).forEach((b) => { b.onclick = () => { site.i += 1; renderSite(); }; });
    $$('[data-build]', dlg).forEach((b) => {
      b.onclick = async () => {
        const r = await townPost('/town/build', { slot: site.slot, key: b.dataset.build }, b);
        if (!r) return;
        const nb = r.town.plots.find((x) => x.slot === site.slot).building;
        toast(nb.tier === 'bad' ? `${nb.name} is up. Preston is already invoicing.` : nb.tier === 'good' ? `${nb.name} is up. Dolores almost smiled.` : `${nb.name} is up. Nobody is thrilled. Nobody is suing.`, 3600);
        refreshVillage(r.town, r.user);
        site.mode = 'office'; renderSite();
      };
    });
    $$('[data-upgrade]', dlg).forEach((b) => {
      b.onclick = async () => {
        const u = p.building.upgrades.find((x) => x.key === b.dataset.upgrade);
        const card = $('#site-card');
        const r = await townPost('/town/upgrade', { slot: site.slot, key: b.dataset.upgrade }, b);
        if (!r) return;
        if (card && !REDUCED) { card.classList.add(`fly-${u.pitch.who}`); await new Promise((res) => setTimeout(res, 420)); }
        refreshVillage(r.town, r.user);
        site.result = { who: u.pitch.who, name: u.name, cost: u.cost, clues: u.clues, line: reaction(u.pitch.who) };
        renderSite();
      };
    });
  }

  // --- The advisors: cards, one at a time ---------------------------------------------------

  const adv = { cards: [], i: 0, result: null };

  function openAdvisors(startAt = 0) {
    clearTimeout(state.flipTimer); // they're engaged; don't flip the coin back under them
    if (!state.flipped) flip(true);
    const t = state.me.town;
    adv.cards = t.issues.slice();
    adv.i = Math.max(0, Math.min(adv.cards.length, startAt));
    adv.result = null;
    // Start on the first unplayed card, if any.
    const firstOpen = adv.cards.findIndex((c) => !c.chosen);
    if (startAt === 0 && firstOpen > 0) adv.i = firstOpen;
    renderAdvisors();
    const d = $('#dlg-advisors');
    if (!d.open) d.showModal();
  }

  function advisorsSummary() {
    const t = state.me.town;
    const locked = t.deck.filter((d) => d.status === 'locked').length;
    const played = t.issues.filter((c) => c.chosen);
    const p = played.filter((c) => c.chosen === 'preston').length, d = played.filter((c) => c.chosen === 'dolores').length;
    const verdict = !played.length ? 'You played nothing. The advisors have noted it.'
      : p && !d ? 'Preston is buying champagne. Dolores is updating her résumé.'
      : d && !p ? 'Dolores is quietly pleased. Preston is in the parking lot, on the phone, pacing.'
      : 'One each. Preston calls it balance. Dolores calls it a coin flip.';
    return `<div class="adv-card summary">
      <div class="adv-band">That's the table</div>
      <h3>Agenda closed</h3>
      <p>${esc(verdict)}</p>
      <div class="adv-tally"><span>${Coin.preston(32)} ${p}</span><span>${Coin.dolores(32)} ${d}</span></div>
      <p class="muted small">${locked} card${locked === 1 ? '' : 's'} still locked. Build, hire, and spend to meet them.</p>
      <div class="adv-actions"><button type="button" class="btn quiet" data-adv="deck">See the deck</button><button type="button" class="btn primary" data-adv="close">Back to town</button></div>
    </div>`;
  }

  function advisorPitch(i, who, played) {
    const p = i[who], w = WHO[who];
    const mine = i.chosen === who, other = i.chosen && !mine;
    return `<button type="button" class="adv-pitch ${who} ${mine ? 'chosen' : ''} ${other ? 'passed' : ''}" data-pick="${who}" ${played ? 'disabled' : ''}>
      <span class="adv-who">${Coin[who](44)}<span><b>${esc(w.name)}</b><small>${esc(w.role)}</small></span></span>
      <q>${esc(p.line)}</q>
      ${clueChips(p.clues)}
      <span class="adv-label">${mine ? '✓ ' : ''}${esc(p.label)}${p.cost ? ` <small>(${money(p.cost, { whole: true })})</small>` : ''}</span>
    </button>`;
  }

  function renderAdvisors() {
    const stage = $('#adv-stage');
    const n = adv.cards.length;
    if (adv.i >= n) { stage.innerHTML = advisorsSummary(); wireAdvisors(); return; }
    const c = adv.cards[adv.i];
    const played = !!c.chosen;
    if (adv.result && adv.result.id === c.id) {
      const r = adv.result, w = WHO[r.side];
      stage.innerHTML = `
        <div class="adv-card result ${r.side}">
          <div class="adv-band">${esc(c.title)}</div>
          <div class="adv-result-who">${Coin[r.side](56)}<div><b>You went with ${esc(w.name.split(' ')[0])}.</b><span>${esc(c[r.side].label)}</span></div></div>
          <p>${esc(r.line)}</p>
          ${fxChips(r.fx)}
          ${Object.keys(r.fx).length === 0 ? '<p class="muted small">Nothing measurable happened. That is its own kind of outcome.</p>' : ''}
          ${r.noted ? '<p class="adv-noted">Noted. This will come back around.</p>' : ''}
          ${crowdLine(r.crowd, r.side)}
          <div class="adv-actions"><button type="button" class="btn primary" data-adv="next">${adv.i + 1 < n ? 'Next card' : 'Done'}</button></div>
        </div>`;
      wireAdvisors(); return;
    }
    stage.innerHTML = `
      <div class="adv-card ${played ? 'played' : ''}" id="adv-card">
        <div class="adv-band ${c.general ? 'headline' : 'village'}">${c.general ? "Today's headline" : c.followup ? 'It came back around' : 'From your village'} · ${adv.i + 1} of ${n}</div>
        ${c.consequence ? '<span class="adv-tag">Has consequences</span>' : ''}
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.setup)}</p>
        ${played ? `<div class="adv-played">Played. You went with ${esc(WHO[c.chosen].name.split(' ')[0])}: ${esc(c[c.chosen].label)}.</div>` : ''}
      </div>
      <div class="adv-pitches">${advisorPitch(c, 'preston', played)}${advisorPitch(c, 'dolores', played)}</div>
      <div class="adv-foot">
        <button type="button" class="linkish" data-adv="prev" ${adv.i === 0 ? 'disabled' : ''}>Previous</button>
        <span class="adv-dots">${adv.cards.map((x, k) => `<i class="${k === adv.i ? 'on' : ''} ${x.chosen ? 'done' : ''}"></i>`).join('')}</span>
        <button type="button" class="linkish" data-adv="next">${played ? 'Next' : 'Skip for now'}</button>
      </div>`;
    wireAdvisors();
  }

  function wireAdvisors() {
    const dlg = $('#dlg-advisors');
    $$('[data-adv]', dlg).forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.adv;
        if (a === 'close') dlg.close();
        else if (a === 'deck') { dlg.close(); const d = $('.deck'); if (d) d.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }
        else if (a === 'next') { adv.result = null; adv.i += 1; renderAdvisors(); }
        else if (a === 'prev') { adv.result = null; adv.i = Math.max(0, adv.i - 1); renderAdvisors(); }
      };
    });
    const card = $('#adv-card');
    $$('[data-pick]', dlg).forEach((b) => {
      const who = b.dataset.pick;
      b.onpointerenter = () => { if (card) card.classList.add(`lean-${who}`); };
      b.onpointerleave = () => { if (card) card.classList.remove(`lean-${who}`); };
      b.onclick = async () => {
        const c = adv.cards[adv.i];
        $$('[data-pick]', dlg).forEach((x) => { x.disabled = true; });
        const r = await townPost('/town/decide', { issue_id: c.id, side: who }, b);
        if (!r) { $$('[data-pick]', dlg).forEach((x) => { x.disabled = false; }); return; }
        // Fly the card off toward the chosen side, then show the result.
        if (card && !REDUCED) {
          card.classList.remove('lean-preston', 'lean-dolores');
          card.classList.add(`fly-${who}`);
          await new Promise((res) => setTimeout(res, 420));
        }
        c.chosen = who;
        adv.result = { id: c.id, side: who, fx: r.fx || {}, noted: !!(r.noted), crowd: r.crowd || null, line: reaction(who) };
        refreshVillage(r.town, r.user);
        adv.cards = state.me.town.issues.slice();
        renderAdvisors();
      };
    });
  }

  // "61% of players sided with Preston today." Only once a few have answered.
  function crowdLine(crowd, side) {
    if (!crowd) return '';
    const total = (crowd.preston || 0) + (crowd.dolores || 0);
    if (total < 3) return '';
    const mine = crowd[side] || 0;
    const pctMine = Math.round(mine / total * 100);
    const who = side === 'preston' ? 'Preston' : 'Dolores';
    return `<p class="muted small adv-crowd">${pctMine}% of the ${total} landlords who've answered this today went with ${who}${pctMine >= 50 ? '. Company.' : '. You and the brave few.'}</p>`;
  }

  // --- collect / sell sheet ----------------------------------------------------------------

  function defaultCharityId() {
    const me = state.me;
    const top = me.donations_by_charity && me.donations_by_charity[0];
    if (top && state.charities.some((c) => c.id === top.id)) return top.id;
    if (me.user.charity_id && state.charities.some((c) => c.id === me.user.charity_id)) return me.user.charity_id;
    return state.charities.length ? state.charities[0].id : null;
  }

  async function openSell(id, opts = {}) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || p.quote_error) return;
    try { await ensureAssets(); } catch (e) { toast(e.message); return; }
    state.sell = p;
    const s = p.preview;
    const win = s.profit > 0, bust = p.busted, mat = p.matured;
    const tierClass = bust || s.profit < 0 ? 'loss' : win ? 'win' : '';
    const rate = Math.round(state.me.rules.tax_rate * 100);
    const rateNow = state.me.town ? state.me.town.hire_cost : 1;
    // s.tax is the whole bill: tax on this position's own profit, plus any
    // deferred ride tax that comes due because this is an early sell.
    const deferred = s.deferred_tax || 0;
    const ownTax = round2(s.tax - deferred);
    const taxed = s.tax > 0;
    const hired = taxed ? round2(s.tax / rateNow) : 0;
    const rm = mat && !bust ? rideMults(p) : null;
    // Riding a winner is taxed too, at half the rate.
    const rideFactor = state.me.rules.ride_tax_factor != null ? state.me.rules.ride_tax_factor : 0.5;
    const rideRate = Math.round(state.me.rules.tax_rate * rideFactor * 1000) / 10;
    const rideTax = win ? round2(s.profit * state.me.rules.tax_rate * rideFactor) : 0;
    const rideHired = win ? round2(rideTax / rateNow) : 0;
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
        ${win ? `<li><span>Profit</span><b class="up">${money(s.profit)}</b></li><li><span>Tax, ${rate}% of profit${deferred > 0 ? '' : `, hires ${esc(lobby(hired))}`}</span><b>${money(ownTax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed. That would be cruel.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        ${deferred > 0 ? `<li><span>Deferred ride tax, due because this is an early sell${win ? `; with the above, hires ${esc(lobby(hired))}` : `, hires ${esc(lobby(hired))}`}</span><b>${money(deferred)}</b></li>` : ''}
        <li class="total"><span>Back onto the coin as bills</span><b>${money(s.net)}</b></li>
      </ul>
      ${taxed ? `<div class="hire-row">
        <div class="hire-side"><span class="muted">${money(s.tax)} of tax</span>${billsRow(s.tax, { max: 12 })}</div>
        <span class="hire-arrow" aria-hidden="true">→</span>
        <div class="hire-side"><span class="muted">${esc(lobby(hired))}</span>${lobbyists(hired, { max: 12 })}</div>
      </div>
      <p class="muted" style="font-size:13px;margin-top:-6px">The recruiter's rate is ${money(rateNow)} per lobbyist today${rateNow < 1 ? ', because your village is happy' : rateNow > 1 ? ', because your village is miserable and word gets around' : ''}.</p>` : ''}
      ${taxed || (!mat && !bust) ? `<label class="field charity-pick"><span>${taxed ? `${esc(lobby(hired))} for` : 'If it lands as a profit when you tap, the tax hires lobbyists for'}</span><select id="sell-charity">${charityOptions}</select></label>` : ''}
      ${!mat && !bust ? `<p class="muted" style="font-size:13px">These numbers are a snapshot; the sale happens at whatever the market says when you tap. Or wait: in ${left(p.matures_at)} it matures at ${mult(p.multiplier)} and freezes at whatever ${esc(p.name)} is doing then${deferred > 0 ? `, and the ${money(deferred)} of deferred ride tax is forgiven` : ''}.</p>` : ''}
      ${mat && !bust ? `<div class="ride-box">
        <b>Or let it ride.</b>
        <span>${win
          ? `Keep ${esc(p.name)} for another ${state.me.rules.hold_hours} hours at today's price. The profit is taxed at half rate now, ${rideRate}% instead of ${rate}%: ${money(rideTax)} hires ${esc(lobby(rideHired))} and ${money(p.value - rideTax)} rides on. The other ${money(rideTax)} is deferred: sell the ride early and it comes due; hold it to maturity and it's forgiven.`
          : `Put the whole ${money(p.value)} back on ${esc(p.name)} at today's price for another ${state.me.rules.hold_hours} hours. No profit, so no tax and nobody gets hired.`} ${rm.capped ? `The multiplier stays at ${mult(rm.floor)} all day; that's the ceiling.` : `The multiplier keeps climbing: it starts the new day at ${mult(rm.floor)} and reaches ${mult(rm.ceiling)}.`} It can still go to zero, faster.</span>
        <button type="button" class="btn small" id="sell-ride">${win ? `Ride with ${money(p.value - rideTax)}` : 'Let it ride'} at ${mult(rm.floor)}→${mult(rm.ceiling)}</button>
      </div>` : ''}
      ${mat && bust ? `<p class="muted" style="font-size:13px">Nothing left to ride. Burying it clears the spot.</p>` : ''}`;
    $('#sell-error').hidden = true;
    $('#sell-submit').disabled = false;
    $('#sell-submit').textContent = bust ? 'Bury it' : mat ? `Collect ${money(s.net)}` : `Sell early for about ${money(s.net)}`;
    const rideBtn = $('#sell-ride');
    if (rideBtn) rideBtn.onclick = () => { const sel = $('#sell-charity'); $('#dlg-sell').close(); ride(p.id, sel ? Number(sel.value) : undefined); };
    $('#dlg-sell').showModal();
    if (opts.ride && rideBtn) { rideBtn.closest('.ride-box').scrollIntoView({ block: 'center' }); rideBtn.focus(); }
  }

  async function ride(id, charity_id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || state.busy) return;
    if (charity_id === undefined && p.preview && p.preview.profit > 0) charity_id = defaultCharityId() || undefined;
    state.busy = true;
    try {
      const r = await API.post('/ride', { position_id: id, charity_id });
      const ro = r.rolled;
      const hours = state.me.rules.hold_hours;
      const msg = ro.tax > 0
        ? `Riding at ${mult(ro.mult_floor)}→${mult(ro.multiplier)}. ${Math.round(ro.rate * 1000) / 10}% tax on the ${money(ro.profit)} profit hired ${lobby(ro.lobbyists)}${ro.charity ? ` for ${ro.charity.name}` : ''}; ${money(ro.net)} rides on ${p.name} at ${price(r.quote.price)} for another ${hours} hours. ${money(ro.deferred)} deferred.`
        : `Riding at ${mult(ro.mult_floor)}→${mult(ro.multiplier)}. ${money(ro.value)} back on ${p.name} at ${price(r.quote.price)} for another ${hours} hours. No profit, so nobody got hired.`;
      toast(msg, 5000);
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
        const hiredNow = rc.lobbyists != null ? rc.lobbyists : rc.tax;
        const t = state.me.town;
        if (t && t.unlocked && !Explainer.seen('town')) {
          // The hire that opened the town: a ceremony, then a clear "flip the
          // coin" before the tour, so nobody mistakes the tour for orientation.
          openHireCeremony(rc, hiredNow, how);
        } else {
          toast(`${rc.tier}. ${how}: ${money(rc.tax)} of tax hired ${lobby(hiredNow)} for ${rc.charity.name}. They're moving into TrickleTown.`, 4200);
          flip(true);
          await hireAnimation(hiredNow);
          state.flipTimer = setTimeout(() => { if (state.flipped && !$('#dlg-advisors').open && !Explainer.isOpen()) flip(false); }, 3200);
        }
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${how} for ${money(rc.net)}, back on the coin.`);
      }
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // The first lobbyist: the tax walks across the desk and comes out a person,
  // the player reads what just happened, and chooses to flip the coin. The
  // TrickleTown tour opens after the flip, not before.
  function openHireCeremony(rc, hiredNow, how) {
    const count = Math.min(10, Math.max(1, Math.ceil(hiredNow - 1e-9)));
    const dlg = $('#dlg-hire');
    $('#hire-title').textContent = hiredNow >= 2 ? 'Your first lobbyists' : 'Your first lobbyist';
    $('#hire-body').innerHTML = `
      <div class="receipt-tier win">${esc(rc.tier)}.</div>
      <p>${how} ${esc(rc.symbol)}: ${money(rc.profit)} of profit, ${money(rc.tax)} of it taxed. Not to the government. To your recruiter.</p>
      <div class="hire-scene" aria-hidden="true">
        <div class="hire-from">${billsRow(Math.max(1, rc.tax), { max: count })}</div>
        <div class="hire-desk"><b>RECRUITER</b><span>${money(rc.hire_cost || 1)} a head</span></div>
        <div class="hire-to">${lobbyists(hiredNow, { max: count })}</div>
      </div>
      <p class="hire-line"><b>${esc(lobby(hiredNow))}</b> hired for <b>${esc(rc.charity.name)}</b>. They've moved into <b>TrickleTown</b>, the company town on the other side of your coin. You own it. They'd like a word.</p>
      <button type="button" class="btn primary wide" id="hire-flip">Flip the coin to meet them</button>
      <button type="button" class="linkish center" id="hire-later">Later. Back to the portfolio.</button>`;
    dlg.showModal();
    const targets = $$('#hire-body .hire-to .lobbyist');
    targets.forEach((t) => t.classList.add('arriving'));
    setTimeout(() => deskAnimation(targets), REDUCED ? 0 : 350);
    $('#hire-later').onclick = () => { dlg.close(); renderUnder(); };
    $('#hire-flip').onclick = async () => {
      dlg.close();
      state.ceremony = true; // the flip must not start the tour; we do, after the bills land
      try { flip(true); await hireAnimation(hiredNow); } finally { state.ceremony = false; }
      maybeTownIntro(300);
    };
  }

  // Inside the ceremony: each bill crosses the desk and unfolds into a person.
  async function deskAnimation(targets) {
    const from = $('#hire-body .hire-from');
    if (!from || !targets.length) return;
    if (REDUCED) { targets.forEach((t) => t.classList.remove('arriving')); return; }
    const bills = $$('.billsvg', from);
    const flights = targets.map((t, i) => new Promise((resolve) => {
      const b = bills[Math.min(i, bills.length - 1)];
      const r0 = b.getBoundingClientRect(), r1 = t.getBoundingClientRect();
      const fly = document.createElement('div');
      fly.className = 'flyer';
      fly.innerHTML = `<span class="fly-bill">${BILL}</span><span class="fly-person">${LOBBYIST}</span>`;
      fly.style.left = `${r0.left}px`; fly.style.top = `${r0.top}px`;
      document.body.appendChild(fly);
      const dx = r1.left - r0.left, dy = r1.top - r0.top;
      const delay = i * 140, dur = 1100;
      const path = fly.animate(
        [{ transform: 'translate(0,0)', opacity: 1, offset: 0 }, { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 26}px) scale(1.15)`, opacity: 1, offset: 0.5 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, offset: 1 }],
        { duration: dur, delay, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' },
      );
      fly.querySelector('.fly-bill').animate(
        [{ transform: 'rotateY(0deg)', opacity: 1, offset: 0 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.42 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 0.58 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      fly.querySelector('.fly-person').animate(
        [{ transform: 'rotateY(-90deg)', opacity: 0, offset: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.56 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.74 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      const done = () => { t.classList.remove('arriving'); fly.remove(); resolve(); };
      path.finished.then(done).catch(done);
    }));
    await Promise.all(flights);
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
      .map((h) => { const hired = h.lobbyists != null ? h.lobbyists : h.tax; return `🔒 ${h.symbol} ${h.tier}${hired > 0 ? ` → ${lobby(hired)} for ${h.charity_name}` : ''}`; });
    const lines = [
      `Trickle Down #${me.day.number}`,
      me.today_donated > 0 ? `🕴️ ${lobby(me.today_donated)} hired today` : '🕴️ No lobbyists hired yet today',
      ...locked.slice(0, 4),
      ...open.slice(0, 5),
      me.user.streak > 1 ? `🔥 ${me.user.streak}-day streak` : null,
      !me.user.is_guest ? `🤝 Add me: ${me.user.username}` : null,
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

  // Leaders: the boards (everyone, or just your friends), and the friends
  // list itself. Adding a friend is one-way: you see them, they don't see you
  // until they add you back. Usernames link to a player sheet.
  const leaders = { scope: 'all' };

  const playerLink = (name, cls = '') => `<a href="#" class="player-link ${cls}" data-player="${esc(name)}">${esc(name)}</a>`;

  async function loadLeaders() {
    const el = $('#screen-leaders');
    el.innerHTML = `<h1>Leaders</h1><p class="lede">Loading…</p>`;
    const signedIn = !!(state.me && API.token());
    try {
      const friendsOnly = leaders.scope === 'friends' && signedIn;
      const [b, f] = await Promise.all([
        API.get(friendsOnly ? '/leaderboard?friends=1' : '/leaderboard'),
        signedIn ? API.get('/friends').catch(() => null) : Promise.resolve(null),
      ]);
      const meName = state.me ? state.me.user.username : null;
      const rowCls = (u) => (u === meName ? 'me' : '');
      const friends = f ? f.friends : [];
      el.innerHTML = `
        <h1>Leaders</h1>
        ${signedIn ? `<div class="scope-toggle" role="tablist">
          <button class="chip ${friendsOnly ? '' : 'on'}" data-scope="all" role="tab">Everyone</button>
          <button class="chip ${friendsOnly ? 'on' : ''}" data-scope="friends" role="tab">Friends${friends.length ? ` (${friends.length + 1})` : ''}</button>
        </div>` : ''}
        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Lobbyfest standings, ${esc(b.quarter)}${friendsOnly ? ', friends only' : ''}. Marching in ${esc(untilLong(b.quarter_ends_at))}.</h2>
        ${b.all_time.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th class="num">This quarter</th><th class="num">Career</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${playerLink(r.username)}</td><td class="num">${esc(lobbyN(r.quarter || 0))}</td><td class="num muted">${esc(lobbyN(r.donated))}</td><td class="num">${r.streak}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">${friendsOnly ? 'None of your friends have hired anyone this quarter. Lead by example.' : 'Nobody has collected a profit yet. The board is yours.'}</p>`}

        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Best cash-out, last 24 hours${friendsOnly ? ', friends only' : ''}</h2>
        ${b.last_24h.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th>Trade</th><th class="num">Gain</th></tr></thead>
          <tbody>${b.last_24h.map((r, i) => `
            <tr>
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${playerLink(r.username)}</td>
              <td><span class="tier">${esc(r.tier)}</span>${esc(r.symbol)} ${money(r.invested)} → ${money(r.proceeds)}</td>
              <td class="num ${dir(r.gain_pct)}">${pct(r.gain_pct, 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">No cash-outs in the last day.</p>`}

        <section class="friends">
          <h2>Friends</h2>
          ${!signedIn ? `<p class="muted">Sign in to add friends and see what they're holding.</p>` : `
          <form class="friend-add" id="friend-add" autocomplete="off">
            <input id="friend-name" type="text" placeholder="Add by username" maxlength="20" spellcheck="false" aria-label="Username to add">
            <button class="btn small primary" type="submit">Add</button>
          </form>
          <p class="muted friend-hint">${f && f.is_guest ? `You're a guest, so nobody can add <i>you</i> back. Claim your account to get a username worth sharing.` : `Your username is <b>${esc(f ? f.your_username : meName)}</b>. ${f && f.added_you ? `${f.added_you} player${f.added_you === 1 ? ' has' : 's have'} added you.` : 'Share it and get added.'} Friends are one-way; they see you only if they add you back.`}</p>
          ${friends.length ? `<ul class="friend-list">${friends.map((u) => `
            <li class="friend" data-player="${esc(u.username)}">
              <div class="friend-main">
                <b>${esc(u.username)}</b>
                <span class="muted">${u.badges && u.badges.earned.length ? esc(u.badges.earned[u.badges.earned.length - 1].name) : 'No rank yet'} · ${esc(lobby(u.quarter_donated))} this quarter · ${u.streak}-day streak</span>
                ${u.town ? `<span class="muted friend-town">Town: ${Math.round(u.town.happiness)} happy, ${Math.round(u.town.health)} healthy. “${esc(u.town.motto)}”</span>` : `<span class="muted friend-town">No village yet.</span>`}
              </div>
              <span class="muted friend-seen">${esc(u.last_seen || '')}</span>
              <button class="btn quiet small" data-unfriend="${esc(u.username)}" title="Remove">×</button>
            </li>`).join('')}</ul>` : `<p class="muted">No friends yet. Ask someone for their username${API.demo ? ' (in the demo, try <b>ravi_k</b> or <b>bagholder_ben</b>)' : ''}.</p>`}`}
        </section>`;
      $$('#screen-leaders [data-scope]').forEach((btn) => { btn.onclick = () => { leaders.scope = btn.dataset.scope; loadLeaders(); }; });
      $$('#screen-leaders .player-link').forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openPlayer(a.dataset.player); }; });
      $$('#screen-leaders .friend').forEach((li) => { li.onclick = (ev) => { if (ev.target.closest('[data-unfriend]')) return; openPlayer(li.dataset.player); }; });
      $$('#screen-leaders [data-unfriend]').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          try { await API.post('/friends/remove', { username: btn.dataset.unfriend }); toast(`${btn.dataset.unfriend} removed. They'll never know.`); await loadLeaders(); } catch (e) { toast(e.message, 4000); }
        };
      });
      const form = $('#friend-add');
      if (form) form.onsubmit = (ev) => { ev.preventDefault(); addFriend($('#friend-name').value.trim()); };
    } catch (e) {
      el.innerHTML = `<h1>Leaders</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  async function addFriend(name) {
    if (!name || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/friends/add', { username: name });
      toast(`${r.username} added. You can see their coin now; they can't see yours until they add you back.`, 4500);
      if (state.me) state.me.friend_count = r.friend_count;
      await loadLeaders();
    } catch (e) { toast(e.message, 4500); }
    finally { state.busy = false; }
  }

  // --- player sheet --------------------------------------------------------------------------------

  async function openPlayer(name) {
    if (!name) return;
    const dlg = $('#dlg-player');
    $('#player-title').textContent = name;
    $('#player-body').innerHTML = `<p class="muted">Loading…</p>`;
    if (!dlg.open) dlg.showModal();
    try {
      const { player: p } = await API.get(`/players/${encodeURIComponent(name)}`);
      renderPlayer(p);
    } catch (e) {
      $('#player-body').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  function renderPlayer(p) {
    const rank = p.badges && p.badges.earned.length ? p.badges.earned[p.badges.earned.length - 1].name : 'No rank yet';
    const open = p.positions || [];
    const coin = Coin.front({ cash: p.cash, positions: open, size: 220, quiet: true });
    const posRows = open.length ? open.map((x) => `
      <li><span><b>${esc(x.symbol)}</b> ${money(x.invested)}${x.ride_count > 0 ? ` <span class="muted">riding ×${x.ride_count}</span>` : ''}${x.matured ? ' <span class="muted">matured</span>' : ''}</span><b class="${x.busted ? 'down' : dir(x.swing_pct)}">${x.busted ? 'RIP' : x.quote_error ? '—' : pct(x.swing_pct, 0)}</b></li>`).join('') : '';
    const town = p.town;
    $('#player-title').textContent = p.is_you ? `${p.username} (you)` : p.username;
    $('#player-body').innerHTML = `
      <div class="player-head">
        <div class="player-coin" aria-hidden="true">${coin}</div>
        <div class="player-facts">
          <div class="player-rank">${esc(rank)}</div>
          <ul class="player-stats">
            <li><span>Hired this quarter</span><b>${esc(lobby(p.quarter_donated))}</b></li>
            <li><span>Hired, career</span><b>${esc(lobby(p.total_donated))}</b></li>
            <li><span>Streak</span><b>${p.streak} day${p.streak === 1 ? '' : 's'}</b></li>
            <li><span>On the coin</span><b>${money(p.in_play)}</b></li>
            ${p.top_charity ? `<li><span>Lobbies for</span><b>${esc(p.top_charity)}</b></li>` : ''}
          </ul>
        </div>
      </div>
      ${open.length ? `<ul class="receipt player-positions">${posRows}</ul>` : `<p class="muted">Nothing on the coin right now. ${money(p.cash)} in bills.</p>`}
      ${town ? `<div class="player-town">
        <b>TrickleTown</b> <span class="muted">${Math.round(town.happiness)} happy · ${Math.round(town.health)} healthy${town.income != null ? ` · ${money(town.income, { whole: true })}/day` : ''}</span>
        <div class="player-buildings">${(town.buildings || []).map((b) => (b.key ? `<span class="chip ${esc(b.tier || '')}">${esc(b.name)}</span>` : `<span class="chip empty">Empty lot</span>`)).join('')}</div>
        <p class="muted" style="margin:6px 0 0">“${esc(town.motto || '')}”</p>
      </div>` : `<p class="muted" style="font-size:13px">No village yet. TrickleTown opens at the first full lobbyist.</p>`}
      <p class="muted" style="font-size:13px">Played ${esc(p.last_seen || 'recently')}.${p.added_you && !p.is_you ? ' Has added you.' : ''}</p>
      <div class="row-actions">
        ${p.is_you ? '' : p.is_friend
          ? `<button class="btn small" id="player-unfriend">Remove friend</button>`
          : (state.me && API.token() ? `<button class="btn small primary" id="player-add">Add friend</button>` : '')}
        <button class="btn quiet small" id="player-close">Close</button>
      </div>`;
    $('#player-close').onclick = () => $('#dlg-player').close();
    const add = $('#player-add'); if (add) add.onclick = async () => { await addFriend(p.username); openPlayer(p.username); };
    const rm = $('#player-unfriend'); if (rm) rm.onclick = async () => { try { await API.post('/friends/remove', { username: p.username }); toast(`${p.username} removed.`); if ($('#screen-leaders').classList.contains('on') || location.hash === '#leaders') loadLeaders(); openPlayer(p.username); } catch (e) { toast(e.message, 4000); } };
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
      <div class="row-actions" style="margin:6px 0 10px"><button class="btn quiet small" id="btn-orient-how">Replay the orientation</button>${me && me.town && me.town.unlocked ? '<button class="btn quiet small" id="btn-town-how">TrickleTown tour</button>' : ''}</div>
      ${rules.demo ? `<div class="note warn">Demo. The charities are fictional and no real money moves. The game is real; the philanthropy isn't yet.</div>` : ''}
      <div class="rules">
        <h2>The coin</h2>
        <p>Every day you show up, ${money(rules.daily_base, { whole: true })} in bills lands on your coin. It isn't real. Keep showing up and it grows: ${money(rules.streak_bonus, { whole: true })} more for each day of your streak, up to ${money(rules.daily_cap, { whole: true })} a day. Miss a day and you're back to ${money(rules.daily_base, { whole: true })}.</p>

        <h2>Buying</h2>
        <p>Pick any stock, crypto, or fund in the list, then say how much: a dollar amount, or a slice of what's free. You buy at the live price and the slice becomes a wedge on the coin. Bills you don't spend roll over.</p>

        <h2>The ${rules.hold_hours} hours</h2>
        <p>Every buy lives ${rules.hold_hours} hours. It moves with the real market, and the longer it lives the harder it hits: the multiplier starts at ${mult(rules.mult_floor)} the moment you buy and climbs steadily to ${mult(10)} for stocks and ${mult(5)} for crypto at the ${rules.hold_hours}-hour mark. At that moment it matures: the value freezes at whatever the price is then, and it's ready to collect. Nvidia up 1.5% over the full day means your wedge is up 15%. A wedge can shrink to nothing. It cannot go below nothing. We checked.</p>

        <h2>Collecting, riding, selling early</h2>
        <p>Tap a wedge. A matured one collects in full: a profit is taxed ${Math.round(rules.tax_rate * 100)}%, a loss isn't, and the rest turns back into bills on the coin. A live wedge can be sold early at the current price and the current, smaller multiplier, if you'd rather not find out.</p>

        <h2>Letting it ride</h2>
        <p>A matured winner can ride instead: the profit so far is taxed at half rate, ${Math.round(rules.tax_rate * (rules.ride_tax_factor != null ? rules.ride_tax_factor : 0.5) * 1000) / 10}%, those lobbyists get hired now, and everything left goes back on the same stock at today's price for another ${rules.hold_hours} hours. The multiplier doesn't start over; it keeps climbing from where it ended, ${mult(10)} to ${mult(20)} on the second day, ${mult(20)} to ${mult(30)} on the third, then flat (crypto ${mult(5)}, ${mult(10)}, ${mult(15)}). The other half of the tax is deferred: hold the ride to maturity and it's forgiven; sell it early and it comes due, on top of the usual tax on anything new, which is exactly what a sell-early deserves. A ride can go to zero, and at ${mult(20)} it takes a 5% dip to do it.</p>

        <h2>Friends</h2>
        <p>Add anyone by username on the Leaders page. You'll see what they bought today, their coin and their village, and the boards can be switched to friends only. It's one-way, like a lobbyist's loyalty: they only see you if they add you back.</p>

        <h2>Lobbyists</h2>
        <p>Your tax hires lobbyists for a charity you pick, at about a dollar a head. They are not dollars. You can hire a fraction of a lobbyist; it looks about how you'd expect.</p>

        <h2>TrickleTown</h2>
        <p>Flip the coin and you'll find where your lobbyists live. You own the village. Each lot holds one building, and every building is a choice: extractive ones (tenements, a casino) pay into your daily allowance and wear your lobbyists down; decent ones (a co-op, a clinic) cost you upkeep and keep them well. Happiness sets the recruiter's rate, from $1.25 a head in a miserable town to 75¢ in a happy one, every point counting, so a well-run village turns the same tax into more lobbyists. Health keeps them around: below 50 they start quitting overnight, a few percent a night at first and a fifth of the payroll at zero, and quitters don't go to Lobbyfest. The Company Store, for what it's worth, takes 20% off anything a card costs. More money to play with, or cheaper lobbyists who stay. Pick, or split the difference.</p>
        <p>Every day Preston Yield, your value extraction partner, and Dolores Pike, lobbyist for your lobbyists, bring two cards to TrickleTown Hall: one everyone gets, one from whatever your own village has unlocked. Each pitch shows which way it will push your allowance, happiness, hiring cost, and health, but not by how much; you see the real numbers once you've played it. Leave a card unplayed and it expires at midnight; once you've built something, the residents notice being ignored (a couple of happiness points a night, never more). Some choices leave a mark, and a later card knocks because of it. The deck shows every card and what unlocks it: a building, an upgrade, a headcount, cash on the coin at dawn, friends, a streak, a town in trouble, or a town doing suspiciously well.</p>
        <p>The construction zone has one lot per plot. Tap a lot to open its Site Office: an empty lot gets three pitches to choose from (${money(40, { whole: true })} to build), and a built one gets proposals for upgrades as they unlock: a few days after building, at a certain headcount or cash on the coin, or when the town is in a certain state. Each proposal is a card, the proposer's pitch against the other advocate's objection. Upgrades push the same four numbers every day, the same way buildings do, and tearing a building down takes its upgrades with it.</p>

        <h2>Lobbyfest</h2>
        <p>At midnight Central on the last day of every quarter, every lobbyist in the game marches off to Lobbyfest. The ads on this site earn real dollars, and that's when all of it is split between the charities on the Lobby page by headcount: a charity with a third of the lobbyists gets a third of the money. Then every payroll resets to zero and the next quarter starts. Your fake tax is a vote on where the real money goes. Nothing you do here costs you anything. That's the whole point.</p>

        <h2>Ranks</h2>
        <p>Ranks are for your career: every lobbyist you've ever hired, across every Lobbyfest.</p>
        <ul class="badges">
          ${badgeList.map((b) => `<li class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b>${b.at} lobbyist${b.at === 1 ? '' : 's'}</li>`).join('')}
        </ul>

        <h2>Fine print</h2>
        <p class="muted">Trickle Down Holdings is a fictional company and a wholly owned subsidiary of Trickle Down Holdings. Prices come from Finnhub and CoinGecko and can be a minute or so behind. Stocks don't trade on weekends; a stock bought Friday afternoon mostly sits still until it matures. Crypto never sleeps. The game day rolls over at midnight Central. Nothing grows while you're away: every wedge freezes at its 24-hour mark whether or not anyone is watching (the price is logged then), and the day's money only lands on days you show up. None of this is investment advice. Obviously.</p>
      </div>`;
    $('#btn-orient-how').onclick = () => Explainer.open({ deck: 'main', rules });
    const tt = $('#btn-town-how'); if (tt) tt.onclick = () => Explainer.open({ deck: 'town' });
  }

  // --- auth sheet ----------------------------------------------------------------------------------

  // Google Identity Services: loaded on demand, only when the server (or
  // config.js) says a client id exists. The button hands us an ID token; the
  // server verifies it against Google's keys and keys the account on `sub`.
  const gsi = { clientId: window.TRICKLE_CONFIG.GOOGLE_CLIENT_ID || '', checked: false, ready: null, intent: 'login' };

  async function googleAvailable() {
    if (!gsi.checked) {
      gsi.checked = true;
      try { const o = await API.get('/auth/options'); if (o && o.google && o.google_client_id) gsi.clientId = o.google_client_id; else if (o && o.google === false) gsi.clientId = ''; } catch (e) { /* keep config.js value */ }
    }
    return !!gsi.clientId;
  }

  function loadGsi() {
    if (gsi.ready) return gsi.ready;
    gsi.ready = new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
      sc.onload = () => resolve(); sc.onerror = () => reject(new Error("Couldn't load Google sign-in."));
      document.head.appendChild(sc);
    }).then(() => {
      window.google.accounts.id.initialize({ client_id: gsi.clientId, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false });
    });
    return gsi.ready;
  }

  // Render (or re-render) the Google button into a container, for a given intent.
  async function mountGoogle(containerId, intent) {
    const slot = $(`#${containerId}`);
    if (!slot) return false;
    if (!(await googleAvailable())) { slot.hidden = true; return false; }
    slot.hidden = false;
    try {
      await loadGsi();
      const target = slot.querySelector('div') || slot;
      target.innerHTML = '';
      gsi.intent = intent;
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', shape: 'pill', width: Math.min(320, target.clientWidth || 320), text: intent === 'link' ? 'continue_with' : 'signin_with' });
      return true;
    } catch (e) {
      slot.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
      return false;
    }
  }

  async function onGoogleCredential(resp) {
    if (!resp || !resp.credential || state.busy) return;
    state.busy = true;
    try {
      const linking = gsi.intent === 'link' && API.token();
      const r = await API.post(linking ? '/auth/link-google' : '/auth/google', { credential: resp.credential });
      API.setToken(r.token);
      if ($('#dlg-auth').open) $('#dlg-auth').close();
      if ($('#dlg-account').open) $('#dlg-account').close();
      toast(linking ? `Linked. You're ${r.user.username} now, on every device.` : r.created ? `Welcome, ${r.user.username}. You can change that name in Account.` : `Hi, ${r.user.username}.`, 4000);
      state.me = null;
      location.hash = '#today'; route();
    } catch (e) {
      const err = $('#dlg-auth').open ? $('#auth-error') : $('#account-error');
      if (err) { err.textContent = e.message; err.hidden = false; } else toast(e.message, 4000);
    } finally { state.busy = false; }
  }

  function openAuth(mode) {
    state.authMode = mode;
    const code = mode === 'code';
    const title = { login: 'Sign in', register: 'Create an account', claim: 'Keep this account', code: 'Use a code' }[mode];
    const blurb = {
      login: 'Pick up where you left off.',
      register: 'A username and a password. That\'s it.',
      claim: 'Give your guest account a name and a password, or link Google, so it follows you to other devices. Everything you\'ve done comes with it.',
      code: 'On the device that\'s already signed in: Account → Use on another device. Type the code it shows here. It works once and lasts 15 minutes.',
    }[mode];
    $('#auth-title').textContent = title;
    $('#auth-blurb').textContent = blurb;
    $('#auth-submit').textContent = code ? 'Sign in with the code' : title;
    $('#auth-fields').hidden = code;
    $('#auth-code-field').hidden = !code;
    $('#auth-user').required = !code; $('#auth-pass').required = !code; $('#auth-code').required = code;
    $('#auth-switch').hidden = mode === 'claim' || code;
    $('#auth-switch').textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
    $('#auth-code-link').hidden = mode === 'claim';
    $('#auth-code-link').textContent = code ? 'Back to username and password' : 'Signed in on another device? Use a code';
    $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-pass').placeholder = mode === 'login' ? '' : 'at least 8 characters';
    $('#auth-error').hidden = true;
    $('#auth-user').value = ''; $('#auth-pass').value = ''; $('#auth-code').value = '';
    $('#dlg-auth').showModal();
    $('#auth-google').hidden = code;
    if (!code) mountGoogle('auth-google', mode === 'claim' ? 'link' : 'login');
    setTimeout(() => (code ? $('#auth-code') : $('#auth-user')).focus(), 50);
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const username = $('#auth-user').value.trim();
    const password = $('#auth-pass').value;
    const path = { login: '/auth/login', register: '/auth/register', claim: '/auth/claim', code: '/auth/redeem-code' }[state.authMode];
    state.busy = true; $('#auth-submit').disabled = true;
    try {
      const r = await API.post(path, state.authMode === 'code' ? { code: $('#auth-code').value.trim() } : { username, password });
      API.setToken(r.token);
      $('#dlg-auth').close();
      toast(state.authMode === 'claim' ? `You're ${r.user.username} now. It'll remember you.` : state.authMode === 'code' ? `This is ${r.user.username}'s coin now, here too.` : `Hi, ${r.user.username}.`);
      state.me = null;
      location.hash = '#today'; route();
    } catch (e) {
      $('#auth-error').textContent = e.message; $('#auth-error').hidden = false;
    } finally { state.busy = false; $('#auth-submit').disabled = false; }
  }

  // --- account sheet ----------------------------------------------------------------------------------

  // "Use on another device": a code the other device types into Sign in.
  const deviceSection = () => `
      <details class="acct-section" id="acct-device">
        <summary>Use on another device</summary>
        <p class="muted small">Get a code here, then on the other device tap Sign in → “Signed in on another device? Use a code.” It works once and lasts 15 minutes. No password needed.</p>
        <button type="button" class="btn small" id="acct-code-btn">Get a code</button>
        <div class="device-code" id="acct-code" hidden></div>
      </details>`;
  const adminSection = (u) => (u.is_admin ? `
      <details class="acct-section admin">
        <summary>Admin</summary>
        <p class="muted small">Testing only. Grants are real rows: the lobbyists go on the boards and into your town.</p>
        <form id="acct-grant-form" class="acct-form">
          <label class="field"><span>Cash to add</span><input id="acct-grant-cash" type="number" min="0" step="1" placeholder="0" inputmode="numeric"></label>
          <label class="field"><span>Lobbyists to add</span><input id="acct-grant-lob" type="number" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
          <button type="submit" class="btn small">Grant</button>
        </form>
        <div class="row-actions" style="margin-top:8px"><button type="button" class="btn quiet small danger" id="acct-reset">Reset my account</button></div>
      </details>` : '');
  function wireShared() {
    const err = (m) => { const e = $('#account-error'); e.textContent = m; e.hidden = false; };
    const codeBtn = $('#acct-code-btn');
    if (codeBtn) codeBtn.onclick = async () => {
      codeBtn.disabled = true;
      try {
        const r = await API.post('/auth/device-code');
        const box = $('#acct-code');
        box.hidden = false;
        box.innerHTML = `<b>${esc(r.code)}</b><span class="muted small">Type this on the other device within ${r.ttl_minutes} minutes.</span>`;
        codeBtn.textContent = 'Get another code';
      } catch (e) { err(e.message); }
      finally { codeBtn.disabled = false; }
    };
    const grant = $('#acct-grant-form');
    if (grant) grant.onsubmit = async (ev) => {
      ev.preventDefault();
      const cash = Number($('#acct-grant-cash').value) || 0, lobbyists = Number($('#acct-grant-lob').value) || 0;
      try {
        const r = await API.post('/admin/grant', { cash, lobbyists });
        toast(`Granted: ${cash ? money(cash) : ''}${cash && lobbyists ? ' and ' : ''}${lobbyists ? lobby(lobbyists) : ''}.`);
        $('#dlg-account').close(); state.me = null; location.hash = '#today'; route();
      } catch (e) { err(e.message); }
    };
    const reset = $('#acct-reset');
    if (reset) reset.onclick = async () => {
      if (reset.dataset.armed !== '1') { reset.dataset.armed = '1'; reset.textContent = 'Tap again to wipe positions, lobbyists and town'; return; }
      try {
        await API.post('/admin/reset');
        toast('Reset. Fresh $100 on the next load.');
        $('#dlg-account').close(); state.me = null; state.flipped = false;
        try { localStorage.removeItem('trickledown.town-intro'); } catch (e) { /* fine */ }
        location.hash = '#today'; route();
      } catch (e) { err(e.message); }
    };
  }

  async function openAccount() {
    const u = state.me && state.me.user;
    if (!u) return;
    const body = $('#account-body');
    if (u.is_guest) {
      body.innerHTML = `
        <p>You're playing as <b>${esc(u.username)}</b>, a guest. It lives in this browser only.</p>
        <p class="muted">Claim it to keep your coin, your lobbyists and TrickleTown on every device.</p>
        <div class="row-actions"><button type="button" class="btn primary" id="acct-claim">Keep this account</button><button type="button" class="btn quiet" id="acct-signout">Sign out</button></div>
        ${deviceSection()}
        ${adminSection(u)}
        <p class="form-error" id="account-error" hidden></p>`;
      $('#dlg-account').showModal();
      $('#acct-claim').onclick = () => { $('#dlg-account').close(); openAuth('claim'); };
      $('#acct-signout').onclick = signOut;
      wireShared();
      return;
    }
    const hasG = await googleAvailable();
    body.innerHTML = `
      <div class="acct-row"><span class="muted">Signed in as</span><b>${esc(u.username)}</b></div>
      ${u.google ? `<div class="acct-row"><span class="muted">Google</span><span>Linked${u.email ? ` · ${esc(u.email)}` : ''}</span></div>` : ''}
      <p class="muted small">Friends add you by that username; it's the only thing about you they can see. <a href="#leaders">Your friends</a>${state.me.friend_count ? ` (${state.me.friend_count})` : ''}.</p>

      <details class="acct-section" open>
        <summary>Change username</summary>
        <form id="acct-username-form" class="acct-form">
          <label class="field"><span>New username</span><input id="acct-username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocapitalize="off" spellcheck="false" required value="${esc(u.username)}"></label>
          <button type="submit" class="btn small">Save</button>
        </form>
      </details>

      <details class="acct-section">
        <summary>${u.has_password ? 'Change password' : 'Set a password'}</summary>
        <form id="acct-password-form" class="acct-form">
          ${u.has_password ? '<label class="field"><span>Current password</span><input id="acct-current" type="password" autocomplete="current-password" required></label>' : '<p class="muted small">You sign in with Google. A password gives you a second way in.</p>'}
          <label class="field"><span>New password</span><input id="acct-new" type="password" autocomplete="new-password" minlength="8" required placeholder="at least 8 characters"></label>
          <button type="submit" class="btn small">Save</button>
          <p class="muted small">Saving signs out every other device.</p>
        </form>
      </details>

      ${hasG && !u.google ? `<details class="acct-section"><summary>Link Google</summary><div class="google-slot" id="account-google"><div id="g-btn-account"></div></div><p class="muted small">Then you can sign in with either.</p></details>` : ''}
      ${deviceSection()}
      ${adminSection(u)}

      <div class="row-actions" style="margin-top:14px">
        <button type="button" class="btn quiet small" id="acct-signout">Sign out</button>
        <button type="button" class="btn quiet small" id="acct-signout-all">Sign out everywhere</button>
      </div>
      <p class="form-error" id="account-error" hidden></p>`;
    $('#dlg-account').showModal();
    wireShared();
    $$('#account-body a[href="#leaders"]').forEach((a) => { a.onclick = () => { $('#dlg-account').close(); }; });
    const err = (m) => { const e = $('#account-error'); e.textContent = m; e.hidden = false; };
    $('#acct-username-form').onsubmit = async (ev) => {
      ev.preventDefault();
      try { const r = await API.post('/auth/username', { username: $('#acct-username').value.trim() }); state.me.user = { ...state.me.user, ...r.user }; renderMasthead(); toast(`You're ${r.user.username} now.`); $('#dlg-account').close(); } catch (e) { err(e.message); }
    };
    $('#acct-password-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const cur = $('#acct-current'); const body2 = { password: $('#acct-new').value };
      if (cur) body2.current = cur.value;
      try { const r = await API.post('/auth/password', body2); API.setToken(r.token); state.me.user = { ...state.me.user, ...r.user }; toast('Password saved. Every other device is signed out.', 4000); $('#dlg-account').close(); } catch (e) { err(e.message); }
    };
    $('#acct-signout').onclick = signOut;
    $('#acct-signout-all').onclick = async () => { try { await API.post('/auth/logout-all'); } catch (e) { /* token may already be dead */ } signOut(); toast('Signed out everywhere.'); };
    if (hasG && !u.google) mountGoogle('account-google', 'link');
  }

  function signOut() {
    API.setToken(null); state.me = null; state.flipped = false;
    if ($('#dlg-account').open) $('#dlg-account').close();
    location.hash = ''; route();
  }

  // --- wiring ----------------------------------------------------------------------------------------

  function wire() {
    $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
    $('#dlg-advisors').addEventListener('close', () => { adv.result = null; });
    $$('dialog.sheet').forEach((d) => { d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); });
    $('#form-sell').addEventListener('submit', submitSell);
    $('#form-auth').addEventListener('submit', submitAuth);
    $('#auth-switch').onclick = () => openAuth(state.authMode === 'login' ? 'register' : 'login');
    $('#auth-code-link').onclick = () => openAuth(state.authMode === 'code' ? 'login' : 'code');
    $('#btn-claim').onclick = () => openAuth('claim');
    $('#btn-account').onclick = openAccount;
    $('#btn-help').onclick = () => Explainer.open({ deck: 'main', rules: state.me ? state.me.rules : undefined });
    $('#btn-signout').onclick = signOut;
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
