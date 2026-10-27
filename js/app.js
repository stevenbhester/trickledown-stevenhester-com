// Trickle Down — front end. Plain JS, no build step.
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SITE = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/^https?:\/\//, '');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    me: null,            // response of GET /me
    assets: [],
    charities: [],
    selected: null,      // asset chosen for the slice
    quote: null,
    carve: 0,            // dollars being carved right now (0 = no slice)
    sell: null,          // position being locked in
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
  const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'any second now';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
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
        <p>Every day you get $100 that isn't real. Carve it up across any stocks or coins you like. It moves with the actual market, ten times harder. Lock in a win and a quarter of the profit is taxed.</p>
        <p>The tax hires lobbyists for a charity you pick, a dollar a head. They aren't dollars. The ads on this site earn real money, and every quarter it's split between the charities by how many lobbyists each one has. Your fake tax decides where the real money goes.</p>
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
        const bonus = me.allowance.amount - me.rules.daily_base;
        toast(bonus > 0
          ? `Day ${me.user.streak} of your streak: ${money(me.allowance.amount, { whole: true })} is on the coin.`
          : `${money(me.allowance.amount, { whole: true })} of fake money is on the coin. Carve it up.`);
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
    const center = state.carve > 0
      ? `<b>${moneySplit(state.carve)}</b><span>slice, ${Math.round(state.carve / me.user.cash * 100)}% of your bills</span>`
      : total > 0
        ? `<b>${moneySplit(total)}</b><span>in play</span>`
        : `<b>$0</b><span>Come back tomorrow.</span>`;
    return `${svg}<div class="coin-center">${center}</div><button class="coin-tap" type="button" aria-label="Flip the coin"></button>`;
  }

  function coinBackMarkup() {
    const me = state.me;
    const svg = Coin.back({ slices: me.donations_by_charity.map((c) => ({ name: c.name, amount: c.amount })) });
    return `${svg}<div class="coin-center"><b>${esc(lobbyN(me.user.total_donated))}</b><span>lobbyist${round2(me.user.total_donated) === 1 ? '' : 's'} hired, all time</span></div><button class="coin-tap" type="button" aria-label="Flip the coin back"></button>`;
  }

  // Redraw only the coin faces. Keeps the carve panel (and its focus) intact.
  function paintCoin() {
    const front = $('#coin-front'), back = $('#coin-back');
    if (!front) return;
    front.innerHTML = coinFrontMarkup();
    back.innerHTML = coinBackMarkup();
    wireCoin();
  }

  function wireCoin() {
    $$('.coin-tap').forEach((b) => { b.onclick = () => flip(); });
    $$('.wedge[data-id]').forEach((w) => {
      w.onclick = () => openSell(Number(w.dataset.id));
      w.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSell(Number(w.dataset.id)); } };
    });
    const cash = $('.cash-sector');
    if (cash) cash.onclick = () => { const i = $('#carve-usd'); if (i) { i.focus(); i.select(); } };
  }

  function flip(to) {
    clearTimeout(state.flipTimer);
    state.flipped = to === undefined ? !state.flipped : to;
    const coin = $('#coin');
    if (coin) coin.classList.toggle('flipped', state.flipped);
    const btn = $('#btn-flip');
    if (btn) btn.textContent = state.flipped ? 'Flip it back' : 'Flip the coin';
    renderUnder();
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
    const { user, rules } = me;
    const nextMoney = money(Math.min(rules.daily_cap, rules.daily_base + rules.streak_bonus * user.streak), { whole: true });
    const streakLine = user.streak > 1 ? `${user.streak}-day streak. Tomorrow's coin: ${nextMoney}.` : `Tomorrow's coin: ${nextMoney}.`;
    if (state.carve > user.cash) state.carve = 0;

    $('#screen-today').innerHTML = `
      <div class="coin-stage">
        <div class="coin ${state.flipped ? 'flipped' : ''}" id="coin">
          <div class="coin-inner">
            <div class="coin-face front" id="coin-front"></div>
            <div class="coin-face back" id="coin-back"></div>
          </div>
        </div>
        <div class="coin-caption">
          <span class="streak">${esc(streakLine)}</span>
          <button class="btn quiet small" id="btn-flip">${state.flipped ? 'Flip it back' : 'Flip the coin'}</button>
        </div>
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

  // Front: carve panel + legend + crowd + share.
  function frontMarkup() {
    const me = state.me;
    const { user, positions } = me;
    const canCarve = user.cash >= 0.01;
    const carve = canCarve ? `
      <section class="carve">
        <h2>Carve a slice</h2>
        <div class="hint">${money(user.cash)} in bills on the coin. Take a slice, then pick what it buys. Keep going until the bills are gone.</div>
        <div class="slice-inputs">
          <div class="amount-row"><span class="amount-prefix">$</span><input id="carve-usd" type="number" min="0.01" max="${user.cash}" step="0.01" inputmode="decimal" placeholder="0.00" value="${state.carve > 0 ? state.carve : ''}"></div>
          <div class="amount-row"><input id="carve-pct" class="pct" type="number" min="0" max="100" step="1" inputmode="numeric" placeholder="0" value="${state.carve > 0 ? Math.round(state.carve / user.cash * 100) : ''}"><span class="amount-suffix">%</span></div>
        </div>
        <div class="chips" id="carve-chips">
          <button type="button" data-pct="10">10%</button>
          <button type="button" data-pct="25">25%</button>
          <button type="button" data-pct="50">50%</button>
          <button type="button" data-pct="100">All of it</button>
        </div>
        <label class="field"><span>Buy</span><input type="search" id="carve-search" placeholder="Nvidia, BTC, gold, the S&amp;P…" autocomplete="off" spellcheck="false"></label>
        <ul class="asset-list" id="asset-list" role="listbox"></ul>
        <div class="quote-line" id="carve-quote" hidden></div>
        <p class="form-error" id="carve-error" hidden></p>
        <button type="button" class="btn primary wide" id="carve-buy" disabled>Pick something first</button>
      </section>` : `
      <section class="all-in">
        <b>All in.</b>
        <span class="muted">Every bill is on the board. Tap a wedge to lock it in, or come back tomorrow for more.</span>
      </section>`;

    const legend = positions.length ? `
      <section class="legend">
        <h2>On the coin</h2>
        <ul class="positions">${positions.map(positionRow).join('')}</ul>
      </section>` : '';

    return `${carve}${legend}${crowdStrip(me.crowd)}
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
    let value, move, action;
    if (p.quote_error) {
      value = `${money(p.invested)} → <b>?</b>`;
      move = `Price unavailable right now. It's still on the coin.`;
      action = `<button class="btn small" disabled>Lock in</button>`;
    } else if (p.busted) {
      value = `${money(p.invested)} → <b>${money(0)}</b>`;
      move = `${esc(p.name)} moved <span class="down">${pct(p.real_pct)}</span>, times ${p.multiplier}. It's gone.`;
      action = `<button class="btn small" data-sell="${p.id}">Bury it</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b>`;
      move = `real <span class="${dir(p.real_pct)}">${pct(p.real_pct)}</span><span class="arrow">→</span>×${p.multiplier}<span class="arrow">→</span>yours <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      action = `<button class="btn small ${p.swing_pct > 0 ? 'primary' : ''}" data-sell="${p.id}">Lock in</button>`;
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

  function wireFront() {
    $$('[data-sell]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.sell)); });
    $('#btn-share').onclick = share;
    const usd = $('#carve-usd'), pc = $('#carve-pct');
    if (!usd) return;
    const cash = state.me.user.cash;

    const setCarve = (dollars, from) => {
      let d = round2(Math.max(0, Math.min(cash, Number(dollars) || 0)));
      state.carve = d;
      if (from !== 'usd') usd.value = d > 0 ? d : '';
      if (from !== 'pct') pc.value = d > 0 ? Math.round(d / cash * 100) : '';
      $$('#carve-chips button').forEach((b) => b.classList.toggle('on', d > 0 && Math.round(d / cash * 100) === Number(b.dataset.pct)));
      paintCoin();
      updateBuyButton();
    };
    usd.addEventListener('input', () => setCarve(usd.value, 'usd'));
    pc.addEventListener('input', () => setCarve(cash * (Number(pc.value) || 0) / 100, 'pct'));
    $$('#carve-chips button').forEach((b) => {
      b.onclick = () => setCarve(Number(b.dataset.pct) === 100 ? cash : cash * Number(b.dataset.pct) / 100);
    });
    $('#carve-search').addEventListener('input', (e) => renderAssetList(e.target.value));
    $('#carve-buy').onclick = submitBuy;

    ensureAssets().then(() => { renderAssetList(''); updateBuyButton(); }).catch((e) => toast(e.message));
    if (state.carve > 0) setCarve(state.carve);
  }

  function renderAssetList(q) {
    const el = $('#asset-list');
    if (!el) return;
    const needle = q.trim().toLowerCase();
    const list = state.assets.filter((a) => !needle || a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle));
    if (!list.length) { el.innerHTML = `<li class="nothing">Not in the game. It's a curated list, on purpose.</li>`; return; }
    el.innerHTML = list.slice(0, 60).map((a) => `
      <li role="option" data-symbol="${esc(a.symbol)}" aria-selected="${!!(state.selected && state.selected.symbol === a.symbol)}">
        <b>${esc(a.symbol)}</b>
        <span>${esc(a.name)}</span>
        <span class="mood ${esc(a.mood)}">${esc(a.mood)} ×${a.multiplier}</span>
      </li>`).join('');
    $$('li[data-symbol]', el).forEach((li) => { li.onclick = () => selectAsset(li.dataset.symbol); });
  }

  async function selectAsset(symbol) {
    state.selected = state.assets.find((a) => a.symbol === symbol) || null;
    state.quote = null;
    $$('#asset-list li').forEach((li) => li.setAttribute('aria-selected', li.dataset.symbol === symbol));
    const q = $('#carve-quote');
    q.hidden = false;
    q.innerHTML = `<span>Getting a price for ${esc(state.selected.name)}…</span>`;
    updateBuyButton();
    try {
      const quote = await API.get(`/quote/${encodeURIComponent(symbol)}`);
      if (!state.selected || state.selected.symbol !== symbol) return;
      state.quote = quote;
      q.innerHTML = `
        <span><b>${price(quote.price)}</b> ${esc(state.selected.name)} right now</span>
        <span>${quote.change_pct == null ? '' : `today <span class="${dir(quote.change_pct)}">${pct(quote.change_pct)}</span>, which would be <span class="${dir(quote.change_pct)}">${pct(quote.change_pct * state.selected.multiplier, 0)}</span> for you`}</span>`;
      if (!(state.carve > 0)) { const i = $('#carve-usd'); if (i) { i.focus(); } }
      updateBuyButton();
    } catch (e) {
      q.innerHTML = `<span class="down">${esc(e.message)}</span>`;
    }
  }

  function updateBuyButton() {
    const btn = $('#carve-buy');
    if (!btn) return;
    const amt = state.carve;
    if (!(amt > 0)) { btn.disabled = true; btn.textContent = state.selected ? `How big a slice of ${state.selected.symbol}?` : 'Carve a slice first'; return; }
    if (!state.selected) { btn.disabled = true; btn.textContent = `Pick what ${money(amt)} buys`; return; }
    if (!state.quote) { btn.disabled = true; btn.textContent = `Pricing ${state.selected.symbol}…`; return; }
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
      toast(`${money(amount)} of ${asset.symbol} at ${price(r.quote.price)}. It's on the coin.`);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
      await animateWedge(r.position.id, 0, 1);
      const s = $('#carve-usd'); if (s) s.focus();
    } catch (e) {
      const err = $('#carve-error'); if (err) { err.textContent = e.message; err.hidden = false; }
    } finally {
      state.busy = false; updateBuyButton();
    }
  }

  // Back: rank, donations by charity, records.
  function backMarkup() {
    const me = state.me;
    const { user, history, donations_by_charity: given } = me;
    const badges = user.badges, next = badges.next;
    const have = badges.earned.length ? badges.earned[badges.earned.length - 1] : null;
    const prevAt = have ? have.at : 0;
    const progress = next ? Math.min(100, ((user.total_donated - prevAt) / (next.at - prevAt)) * 100) : 100;
    return `
      <section class="records">
        <h2>Your lobbyists</h2>
        <div class="lobby-row"><b>${esc(lobbyN(user.total_donated))}</b>${user.total_donated > 0 ? lobbyists(user.total_donated) : '<span class="muted">Nobody on the payroll yet.</span>'}</div>
        <div class="rank"><b>${have ? esc(have.name) : 'No rank yet'}</b><span class="muted">${have ? 'is your rank.' : 'Lock in a profit and the tax hires your first one.'}</span></div>
        <div class="rank-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
        <div class="rank-line">${next ? `${esc(next.name)} at ${next.at} lobbyists. ${lobbyN(next.at - user.total_donated)} to go.` : 'There is nothing above this.'}</div>

        ${given.length ? `<ul class="given">${given.map((c, i) => `
          <li><span><span class="sw" style="background:${['#1879A0', '#2C9BC4', '#0F5873', '#63B6D3', '#1B6E8C', '#9ED3E4'][i % 6]}"></span>${esc(c.name)}</span><span>${lobbyists(c.amount, { mini: true, max: 12 })} <b>${esc(lobbyN(c.amount))}</b></span></li>`).join('')}</ul>` : ''}

        <h2>Records</h2>
        ${history.length ? `<ul class="history">${history.map((h) => `
          <li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)}</span>
            <span class="to">${h.tax > 0 ? `${esc(lobby(h.tax))} for ${esc(h.charity_name)}` : shortDate(h.closed_at)}</span>
          </li>`).join('')}</ul>` : `<p class="muted">No lock-ins yet. The records start when you do.</p>`}
        <div class="row-actions"><button class="btn quiet small" id="btn-flip-back">Flip it back</button><a class="btn quiet small" href="#trickle">The whole lobby</a></div>
      </section>`;
  }

  function wireBack() {
    const b = $('#btn-flip-back'); if (b) b.onclick = () => flip(false);
  }

  // --- lock-in sheet ----------------------------------------------------------------------

  async function openSell(id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || p.quote_error) return;
    try { await ensureAssets(); } catch (e) { toast(e.message); return; }
    state.sell = p;
    const s = p.preview;
    const win = s.profit > 0, bust = p.busted;
    const tierClass = bust || s.profit < 0 ? 'loss' : win ? 'win' : '';
    const rate = Math.round(state.me.rules.tax_rate * 100);
    const lastCharity = state.me.user.charity_id;
    const charityOptions = state.charities.map((c) => `<option value="${c.id}" ${c.id === lastCharity ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

    $('#sell-title').textContent = bust ? 'Bury it' : win ? 'Lock it in' : 'Take the loss';
    $('#sell-body').innerHTML = `
      <div class="receipt-tier ${tierClass}">${esc(s.tier)}.</div>
      <ul class="receipt">
        <li><span>You put in</span><b>${money(p.invested)}</b></li>
        <li><span>${esc(p.name)} moved ${pct(p.real_pct)}, times ${p.multiplier}</span><b class="${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</b></li>
        <li><span>Worth right now</span><b>${money(p.value)}</b></li>
        ${win ? `<li><span>Profit</span><b class="up">${money(s.profit)}</b></li><li><span>Tax, ${rate}% of profit, hires ${esc(lobby(s.tax))}</span><b>${money(s.tax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed. That would be cruel.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        <li class="total"><span>Back onto the coin as bills</span><b>${money(s.net)}</b></li>
      </ul>
      ${win ? `<div class="lobby-row"><b>${esc(lobbyN(s.tax))}</b>${lobbyists(s.tax)}</div>
      <label class="field charity-pick"><span>${esc(lobby(s.tax))} for</span><select id="sell-charity">${charityOptions}</select></label>` : ''}
      <p class="muted" style="font-size:13px">Prices move. The final number is whatever the market says when you tap.</p>`;
    $('#sell-error').hidden = true;
    $('#sell-submit').disabled = false;
    $('#sell-submit').textContent = bust ? 'Bury it' : win ? `Lock in ${money(s.net)}` : `Take ${money(s.net)} back`;
    $('#dlg-sell').showModal();
  }

  async function submitSell(ev) {
    ev.preventDefault();
    if (state.busy || !state.sell) return;
    const p = state.sell;
    const sel = $('#sell-charity');
    const charity_id = sel ? Number(sel.value) : undefined;
    state.busy = true; $('#sell-submit').disabled = true; $('#sell-submit').textContent = 'Locking in…';
    try {
      const r = await API.post('/sell', { position_id: p.id, charity_id });
      $('#dlg-sell').close();
      const rc = r.receipt;
      // Shrink the wedge back into bills, then refresh.
      await animateWedge(p.id, 1, 0, 420);
      await loadMe();
      if (rc.tax > 0) {
        toast(`${rc.tier}. ${money(rc.tax)} of tax hired ${lobby(rc.tax)} for ${rc.charity.name}.`, 4200);
        flip(true);
        state.flipTimer = setTimeout(() => { if (state.flipped) flip(false); }, 4200);
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${money(rc.net)} back on the coin.`);
      }
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // --- share --------------------------------------------------------------------------------

  async function share() {
    const me = state.me;
    if (!me) return;
    const emoji = (p) => (p.busted ? '💀' : p.swing_pct > 0 ? '📈' : p.swing_pct < 0 ? '📉' : '➖');
    const open = me.positions.map((p) => `${emoji(p)} ${p.symbol} ${p.busted ? 'RIP' : pct(p.swing_pct, 0)}`);
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

  // --- trickle --------------------------------------------------------------------------------

  async function loadTrickle() {
    const el = $('#screen-trickle');
    el.innerHTML = `<h1>Where it's going</h1><p class="lede">Loading…</p>`;
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
          Every lock-in with a profit pays a tax in play money, and every dollar of it hires one lobbyist for a charity the player picks. Lobbyists aren't dollars. At the end of each quarter, the real money the ads on this site earned is split between the charities by headcount. Receipts get posted here when that happens.
        </div>`;
    } catch (e) {
      el.innerHTML = `<h1>Where it's going</h1><p class="lede">${esc(e.message)}</p>`;
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
        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Most lobbyists hired, all time</h2>
        ${b.all_time.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th class="num">Lobbyists</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${esc(r.username)}</td><td class="num">${esc(lobbyN(r.donated))}</td><td class="num">${r.streak}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">Nobody has locked in a profit yet. The board is yours.</p>`}

        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Best lock-in, last 24 hours</h2>
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
        </table>` : `<p class="muted">No lock-ins in the last day.</p>`}`;
    } catch (e) {
      el.innerHTML = `<h1>Leaders</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- how -----------------------------------------------------------------------------------------

  function renderHow() {
    const me = state.me;
    const rules = me ? me.rules : { daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, demo: true };
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

        <h2>Carving it</h2>
        <p>Take a slice, in dollars or percent, and pick what it buys: any stock, crypto, or fund in the list, at the live price. The slice becomes a wedge. Keep carving until the bills are gone, or don't. Bills roll over.</p>

        <h2>The market</h2>
        <p>Wedges move with the actual market, times ten for stocks and times five for crypto. Nvidia goes up 1.5%, your wedge grows 15%. A wedge can shrink to nothing. It cannot go below nothing. We checked.</p>

        <h2>Locking in</h2>
        <p>Tap a wedge to cash it out whenever you like. A profit is taxed ${Math.round(rules.tax_rate * 100)}%. A loss isn't. Everything else turns back into bills on the coin.</p>

        <h2>Lobbyists</h2>
        <p>Every dollar of tax hires one lobbyist for a charity you pick. They are not dollars. You can hire a fraction of a lobbyist; it looks about how you'd expect. Flip the coin to see your payroll, your rank, and every lock-in on record.</p>

        <h2>The real money</h2>
        <p>The ads on this site earn real dollars. Every quarter, all of it is split between the charities on the Lobby page by headcount: a charity with a third of the lobbyists gets a third of the money. Your fake tax is a vote on where the real money goes. Nothing you do here costs you anything. That's the whole point.</p>

        <h2>Ranks</h2>
        <p>They're for how many lobbyists you've hired, all time.</p>
        <ul class="badges">
          ${badgeList.map((b) => `<li class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b>${b.at} lobbyist${b.at === 1 ? '' : 's'}</li>`).join('')}
        </ul>

        <h2>Fine print</h2>
        <p class="muted">Prices come from Finnhub and CoinGecko and can be a minute or so behind. The game day rolls over at midnight Central. None of this is investment advice. Obviously.</p>
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

    // Keep the countdown honest and the coin fresh while the tab is open, but
    // never yank the carve panel out from under someone mid-slice.
    const carving = () => state.carve > 0 || state.selected || ['carve-usd', 'carve-pct', 'carve-search'].includes(document.activeElement && document.activeElement.id);
    setInterval(() => {
      if (!state.me) return;
      $('#day-countdown').textContent = `New money in ${countdown(state.me.day.resets_at)}`;
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
