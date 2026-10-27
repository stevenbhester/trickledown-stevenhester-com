// Trickle Down — front end. Plain JS, no build step.
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SITE = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/^https?:\/\//, '');

  const state = {
    me: null,          // response of GET /me
    assets: [],
    charities: [],
    selected: null,    // asset chosen in the buy sheet
    quote: null,
    sell: null,        // position being locked in
    authMode: 'login', // 'login' | 'register' | 'claim'
    tab: 'today',
    busy: false,
  };

  // --- formatting ----------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n, opts = {}) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    const v = Math.abs(n);
    const s = v.toLocaleString('en-US', { minimumFractionDigits: opts.whole ? 0 : 2, maximumFractionDigits: opts.whole ? 0 : 2 });
    return `${n < 0 ? '-' : ''}$${s}`;
  };
  const pct = (p, digits = 1) => {
    if (p === null || p === undefined || Number.isNaN(p)) return '—';
    const v = p * 100;
    return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
  };
  const dir = (p) => (p > 0 ? 'up' : p < 0 ? 'down' : '');
  const price = (p) => (p >= 1000 ? money(p, { whole: true }) : p >= 1 ? money(p) : `$${p.toPrecision(3)}`);
  const timeAgoShort = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

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
        <p>Every day you get $100 that isn't real. Put it on any stock or coin. It moves with the actual market, ten times harder. Lock in a win and a quarter of the profit goes to a charity you pick.</p>
        <p>The ads on this site earn real money. Every quarter it goes to those same charities, split the way players split their tax. Your fake tax decides where the real money goes.</p>
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

  // --- today ------------------------------------------------------------------------

  async function loadMe() {
    try {
      const me = await API.get('/me');
      state.me = me;
      setSignedIn(true);
      renderToday();
      if (me.allowance) {
        const bonus = me.allowance.amount - me.rules.daily_base;
        toast(bonus > 0
          ? `Day ${me.user.streak} of your streak: ${money(me.allowance.amount, { whole: true })} is in.`
          : `${money(me.allowance.amount, { whole: true })} of fake money is in. Go.`);
      }
    } catch (e) {
      if (e.status === 401) { API.setToken(null); route(); return; }
      toast(e.message);
    }
  }

  function renderMasthead() {
    const { day, user } = state.me;
    $('#day-number').textContent = `Day ${day.number}`;
    $('#day-countdown').textContent = `New money in ${countdown(day.resets_at)}`;
    $('#foot-user').textContent = user.is_guest ? `Playing as ${user.username}` : `Signed in as ${user.username}`;
    $('#btn-claim').hidden = !user.is_guest;
  }

  function positionRow(p) {
    const cls = ['position'];
    if (p.quote_error) cls.push('stale');
    else if (p.busted) cls.push('busted');
    else cls.push(dir(p.swing_pct));
    let value, move, action;
    if (p.quote_error) {
      value = `${money(p.invested)} → <b>?</b>`;
      move = `<span>Price unavailable right now. It's still in the market.</span>`;
      action = `<button class="btn small" disabled>Lock in</button>`;
    } else if (p.busted) {
      value = `${money(p.invested)} → <b>${money(0)}</b>`;
      move = `<span>${esc(p.name)} moved <span class="down">${pct(p.real_pct)}</span>, times ${p.multiplier}. It's gone.</span>`;
      action = `<button class="btn small" data-sell="${p.id}">Bury it</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b>`;
      move = `real <span class="${dir(p.real_pct)}">${pct(p.real_pct)}</span><span class="arrow">→</span>×${p.multiplier}<span class="arrow">→</span>yours <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      action = `<button class="btn small ${p.swing_pct > 0 ? 'primary' : ''}" data-sell="${p.id}">Lock in</button>`;
    }
    return `
      <li class="${cls.join(' ')}" data-id="${p.id}">
        <div class="ticker"><b>${esc(p.symbol)}</b><span>${esc(p.name)}</span></div>
        <div class="value">${value}</div>
        <div class="move">${move}</div>
        <div class="action">${action}</div>
      </li>`;
  }

  function crowdStrip(crowd) {
    if (!crowd || !crowd.buys) {
      return `<div class="crowd">Nobody has bought anything yet today. First mover.</div>`;
    }
    const total = crowd.buys;
    const bar = crowd.picks.map((c) => `<span style="width:${(c.buys / total * 100).toFixed(1)}%" title="${esc(c.symbol)}"></span>`).join('');
    const legend = crowd.picks.map((c) => `<span><b>${esc(c.symbol)}</b> ${Math.round(c.buys / total * 100)}%</span>`).join('');
    return `
      <div class="crowd">
        Everyone plays the same market. ${total} buy${total === 1 ? '' : 's'} today from ${crowd.players} player${crowd.players === 1 ? '' : 's'}:
        <div class="crowd-bar">${bar}</div>
        <div class="crowd-legend">${legend}</div>
      </div>`;
  }

  function renderToday() {
    const me = state.me;
    if (!me) return;
    renderMasthead();
    const { user, positions, history, rules } = me;
    const badges = user.badges;
    const next = badges.next;
    const prevAt = badges.earned.length ? badges.earned[badges.earned.length - 1].at : 0;
    const progress = next ? Math.min(100, ((user.total_donated - prevAt) / (next.at - prevAt)) * 100) : 100;
    const streakLine = user.streak > 1
      ? `${user.streak}-day streak. Tomorrow's money: ${money(Math.min(rules.daily_cap, rules.daily_base + rules.streak_bonus * user.streak), { whole: true })}.`
      : `Come back tomorrow for ${money(Math.min(rules.daily_cap, rules.daily_base + rules.streak_bonus), { whole: true })}.`;

    const openRows = positions.length
      ? `<ul class="positions">${positions.map(positionRow).join('')}</ul>`
      : `<div class="empty"><span>Nothing in the market. Your money is just sitting there.</span><button class="btn small primary" data-invest>Put money in</button></div>`;

    const hist = history.length
      ? `<ul class="history">${history.slice(0, 6).map((h) => `
          <li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)}</span>
            <span class="to">${h.tax > 0 ? `${money(h.tax)} to ${esc(h.charity_name)}` : timeAgoShort(h.closed_at)}</span>
          </li>`).join('')}</ul>`
      : '';

    $('#screen-today').innerHTML = `
      <div class="spine">
        <section class="node">
          <h2>Your reservoir</h2>
          <div class="reservoir">
            <div>
              <div class="money-big"><small>$</small>${esc(user.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</div>
              <div class="reservoir-sub"><span class="streak">${esc(streakLine)}</span></div>
            </div>
            <button class="btn primary" data-invest ${user.cash < 1 ? 'disabled' : ''}>Put money in</button>
          </div>
          ${crowdStrip(me.crowd)}
        </section>

        <section class="node">
          <h2>In the market</h2>
          ${openRows}
        </section>

        <section class="node basin" id="basin">
          <h2>Down the pipe</h2>
          <div class="basin-total"><b>${money(user.total_donated)}</b><span class="muted">sent to charity by you, all time</span></div>
          <div class="basin-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
          <div class="basin-line">${next
            ? `${badges.earned.length ? `You're a ${esc(badges.earned[badges.earned.length - 1].name)}. ` : ''}${esc(next.name)} at ${money(next.at, { whole: true })}, ${money(next.at - user.total_donated)} to go.`
            : `You're a ${esc(badges.earned[badges.earned.length - 1].name)}. There's nothing above that.`}</div>
          ${hist}
          <div class="row-actions">
            <button class="btn quiet small" id="btn-share">Share today</button>
            <a class="btn quiet small" href="#trickle">See where it goes</a>
          </div>
        </section>
      </div>`;

    $$('[data-invest]').forEach((b) => { b.onclick = openBuy; });
    $$('[data-sell]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.sell)); });
    $('#btn-share').onclick = share;
  }

  // --- buy sheet ----------------------------------------------------------------------

  async function ensureAssets() {
    if (!state.assets.length) state.assets = (await API.get('/assets')).assets;
    if (!state.charities.length) state.charities = (await API.get('/charities')).charities;
  }

  async function openBuy() {
    try { await ensureAssets(); } catch (e) { toast(e.message); return; }
    state.selected = null; state.quote = null;
    $('#buy-search').value = '';
    $('#buy-amount').value = '';
    $('#buy-quote').hidden = true;
    $('#buy-error').hidden = true;
    renderAssetList('');
    updateBuyButton();
    $('#dlg-buy').showModal();
    setTimeout(() => $('#buy-search').focus(), 50);
  }

  function renderAssetList(q) {
    const needle = q.trim().toLowerCase();
    const list = state.assets.filter((a) => !needle || a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle));
    const el = $('#asset-list');
    if (!list.length) { el.innerHTML = `<li class="nothing">Not in the game. It's a curated list, on purpose.</li>`; return; }
    el.innerHTML = list.slice(0, 60).map((a) => `
      <li role="option" data-symbol="${esc(a.symbol)}" aria-selected="${state.selected && state.selected.symbol === a.symbol}">
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
    const q = $('#buy-quote');
    q.hidden = false;
    q.innerHTML = `<span>Getting a price for ${esc(state.selected.name)}…</span>`;
    updateBuyButton();
    try {
      const quote = await API.get(`/quote/${encodeURIComponent(symbol)}`);
      if (!state.selected || state.selected.symbol !== symbol) return;
      state.quote = quote;
      q.innerHTML = `
        <span><b>${price(quote.price)}</b> ${esc(state.selected.name)}</span>
        <span>${quote.change_pct == null ? '' : `today <span class="${dir(quote.change_pct)}">${pct(quote.change_pct)}</span>, which would be <span class="${dir(quote.change_pct)}">${pct(quote.change_pct * state.selected.multiplier, 0)}</span> for you`}</span>`;
      if (!$('#buy-amount').value) $('#buy-amount').value = Math.min(100, Math.floor(state.me.user.cash));
      updateBuyButton();
      $('#buy-amount').focus();
    } catch (e) {
      q.innerHTML = `<span class="down">${esc(e.message)}</span>`;
    }
  }

  function updateBuyButton() {
    const btn = $('#buy-submit');
    const amt = Number($('#buy-amount').value);
    if (!state.selected) { btn.disabled = true; btn.textContent = 'Pick something first'; return; }
    if (!state.quote) { btn.disabled = true; btn.textContent = `Pricing ${state.selected.symbol}…`; return; }
    if (!(amt >= 1)) { btn.disabled = true; btn.textContent = 'How much?'; return; }
    if (amt > state.me.user.cash + 1e-9) { btn.disabled = true; btn.textContent = `You only have ${money(state.me.user.cash)}`; return; }
    btn.disabled = false;
    btn.textContent = `Buy ${money(amt)} of ${state.selected.symbol}`;
  }

  async function submitBuy(ev) {
    ev.preventDefault();
    if (state.busy || !state.selected) return;
    const amount = Number($('#buy-amount').value);
    state.busy = true; $('#buy-submit').disabled = true; $('#buy-submit').textContent = 'Buying…';
    try {
      const r = await API.post('/buy', { symbol: state.selected.symbol, amount });
      $('#dlg-buy').close();
      toast(`Bought ${money(amount)} of ${state.selected.symbol} at ${price(r.quote.price)}.`);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
    } catch (e) {
      $('#buy-error').textContent = e.message; $('#buy-error').hidden = false;
    } finally {
      state.busy = false; updateBuyButton();
    }
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
        ${win ? `<li><span>Profit</span><b class="up">${money(s.profit)}</b></li><li><span>Tax, ${rate}% of profit</span><b>${money(s.tax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed. That would be cruel.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        <li class="total"><span>Back to your reservoir</span><b>${money(s.net)}</b></li>
      </ul>
      ${win ? `<label class="field charity-pick"><span>The ${money(s.tax)} goes to</span><select id="sell-charity">${charityOptions}</select></label>` : ''}
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
      const from = $(`.position[data-id="${p.id}"]`);
      if (rc.tax > 0) {
        toast(`${rc.tier}. ${money(rc.tax)} went down the pipe to ${rc.charity.name}.`, 4000);
        await runDroplet(from);
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${money(rc.net)} back in your reservoir.`);
      }
      await loadMe();
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // A droplet runs down the pipe from the position to the basin.
  function runDroplet(fromEl) {
    const basin = $('#basin');
    const spine = $('.spine');
    if (!fromEl || !basin || !spine || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    const runner = $('#runner');
    const x = spine.getBoundingClientRect().left + 14 + 1 - 6;
    const y1 = fromEl.getBoundingClientRect().top + 10;
    const y2 = basin.getBoundingClientRect().top + 4;
    runner.hidden = false;
    const anim = runner.animate(
      [
        { transform: `translate(${x}px, ${y1}px) scale(0.6)`, opacity: 0 },
        { transform: `translate(${x}px, ${y1 + 8}px) scale(1)`, opacity: 1, offset: 0.15 },
        { transform: `translate(${x}px, ${y2}px) scale(1)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${x}px, ${y2 + 6}px) scale(1.4, 0.5)`, opacity: 0 },
      ],
      { duration: 1100, easing: 'cubic-bezier(.4,0,.8,1)', fill: 'forwards' },
    );
    return anim.finished.then(() => { runner.hidden = true; }).catch(() => { runner.hidden = true; });
  }

  // --- share --------------------------------------------------------------------------------

  async function share() {
    const me = state.me;
    if (!me) return;
    const emoji = (p) => (p.busted ? '💀' : p.swing_pct > 0 ? '📈' : p.swing_pct < 0 ? '📉' : '➖');
    const open = me.positions.map((p) => `${emoji(p)} ${p.symbol} ${p.busted ? 'RIP' : pct(p.swing_pct, 0)}`);
    const locked = me.history.filter((h) => h.closed_day === me.day.key)
      .map((h) => `🔒 ${h.symbol} ${h.tier}${h.tax > 0 ? ` → ${money(h.tax)} to ${h.charity_name}` : ''}`);
    const lines = [
      `Trickle Down #${me.day.number}`,
      me.today_donated > 0 ? `💧 ${money(me.today_donated)} to charity today` : '💧 Nothing down the pipe yet today',
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
        <h1>Where it's going</h1>
        <div class="trickle-head">
          <div class="big"><small>$</small>${esc(t.quarter_total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</div>
          <div class="muted">of play-money tax this quarter (${esc(t.quarter)}), from ${t.quarter_donors} player${t.quarter_donors === 1 ? '' : 's'}. It decides the split below.</div>
        </div>
        <div class="pool">
          <div><b>${money(t.pool_usd, { whole: true })}</b><span>real ad money in this quarter's pool</span></div>
          <div><b>${money(t.all_time)}</b><span>play-money tax since the game began</span></div>
        </div>
        <ul class="charities">
          ${t.charities.map((c) => `
            <li class="charity">
              <div class="charity-top">
                <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>
                <b>${Math.round(c.share * 100)}%</b>
              </div>
              <div class="charity-bar"><i style="--w:${(c.share / max * 100).toFixed(1)}%"></i></div>
              <div class="charity-sub">
                <span>${money(c.quarter_total)} in play tax from ${c.quarter_donors} player${c.quarter_donors === 1 ? '' : 's'}</span>
                <span>${t.pool_usd > 0 ? `would get ${money(c.est_usd)} real` : 'real share pending ad revenue'}</span>
              </div>
              <p class="blurb">${esc(c.blurb)}</p>
            </li>`).join('')}
        </ul>
        <div class="note">
          Every lock-in with a profit pays a tax in play money to a charity the player picks. At the end of each quarter, the real money the ads on this site earned is sent to these charities in the same proportions. Receipts get posted here when that happens.
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
        <h2 class="muted" style="font-size:15px;margin:14px 0 2px">Most sent down the pipe, all time</h2>
        ${b.all_time.length ? `
        <table class="board">
          <thead><tr><th></th><th>Player</th><th class="num">To charity</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${esc(r.username)}</td><td class="num">${money(r.donated)}</td><td class="num">${r.streak}</td></tr>`).join('')}
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
    const rules = me ? me.rules : { daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25 };
    const earned = me ? me.user.badges.earned.map((b) => b.name) : [];
    const badgeList = [
      { at: 1, name: 'Dribble' }, { at: 10, name: 'Drip' }, { at: 50, name: 'Trickle' }, { at: 250, name: 'Stream' },
      { at: 1000, name: 'River' }, { at: 5000, name: 'Flood' }, { at: 25000, name: 'Deluge' },
    ];
    $('#screen-how').innerHTML = `
      <h1>How it works</h1>
      <div class="rules">
        <h2>The money</h2>
        <p>Every day you show up, you get ${money(rules.daily_base, { whole: true })}. It isn't real. Keep showing up and it grows: ${money(rules.streak_bonus, { whole: true })} more for each day of your streak, up to ${money(rules.daily_cap, { whole: true })} a day. Miss a day and you're back to ${money(rules.daily_base, { whole: true })}.</p>

        <h2>The market</h2>
        <p>Put it on any stock, crypto, or fund in the list. You buy at the live price. From then on it moves with the actual market, times ten for stocks and times five for crypto. Nvidia goes up 1.5%, your money goes up 15%. It can go to zero. It cannot go below zero. We checked.</p>

        <h2>Locking in</h2>
        <p>Cash out whenever you like. A profit is taxed ${Math.round(rules.tax_rate * 100)}%, and you pick which charity the tax goes to. A loss isn't taxed. Everything else comes back to your reservoir to go again.</p>

        <h2>The real money</h2>
        <p>The ads on this site earn real dollars. Every quarter, all of it goes to the charities on the Trickle page, split the same way players split their play-money tax. Your fake tax is a vote on where the real money goes. Nothing you do here costs you anything. That's the whole point.</p>

        <h2>Ranks</h2>
        <p>They're for how much you've sent down the pipe, all time.</p>
        <ul class="badges">
          ${badgeList.map((b) => `<li class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b>${money(b.at, { whole: true })}</li>`).join('')}
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
      location.hash = '#today'; route();
    } catch (e) {
      $('#auth-error').textContent = e.message; $('#auth-error').hidden = false;
    } finally { state.busy = false; $('#auth-submit').disabled = false; }
  }

  // --- wiring ----------------------------------------------------------------------------------------

  function wire() {
    $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
    $$('dialog.sheet').forEach((d) => {
      d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    });
    $('#form-buy').addEventListener('submit', submitBuy);
    $('#buy-search').addEventListener('input', (e) => renderAssetList(e.target.value));
    $('#buy-amount').addEventListener('input', updateBuyButton);
    $$('#buy-chips button').forEach((b) => {
      b.onclick = () => {
        const cash = state.me ? state.me.user.cash : 0;
        const v = b.dataset.amt === 'all' ? Math.floor(cash * 100) / 100 : Math.min(Number(b.dataset.amt), cash);
        $('#buy-amount').value = v; updateBuyButton();
      };
    });
    $('#form-sell').addEventListener('submit', submitSell);
    $('#form-auth').addEventListener('submit', submitAuth);
    $('#auth-switch').onclick = () => openAuth(state.authMode === 'login' ? 'register' : 'login');
    $('#btn-claim').onclick = () => openAuth('claim');
    $('#btn-signout').onclick = () => { API.setToken(null); state.me = null; location.hash = ''; route(); };
    window.addEventListener('hashchange', route);

    // Keep the countdown honest and the portfolio fresh while the tab is open.
    setInterval(() => {
      if (!state.me) return;
      $('#day-countdown').textContent = `New money in ${countdown(state.me.day.resets_at)}`;
      if (new Date(state.me.day.resets_at) <= Date.now() && state.tab === 'today') loadMe();
    }, 30_000);
    setInterval(() => {
      if (state.me && state.tab === 'today' && document.visibilityState === 'visible' && !$('#dlg-sell').open && !$('#dlg-buy').open) loadMe();
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.me && state.tab === 'today') loadMe();
    });
  }

  wire();
  route();
})();
