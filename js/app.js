// Trickle Down — front end. Plain JS, no build step.
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SITE = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/^https?:\/\//, '');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // This page's build: the ?v= that index.html loaded app.js with.
  const BUILD = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch (e) { return ''; } })();

  // While any popup is open, the page behind it is frozen in place: only the
  // popup scrolls. (Body fixed at its scroll offset; iOS ignores overflow
  // alone.) Unlocks synchronously on close() so a scrollIntoView right after
  // closing still works, and on the close event for Escape and form closes.
  (function lockScrollUnderPopups() {
    const root = document.documentElement;
    let y = 0;
    const lock = () => {
      if (root.classList.contains('popup-open')) return;
      y = window.scrollY;
      document.body.style.top = `-${y}px`;
      root.classList.add('popup-open');
    };
    const unlock = () => {
      if (!root.classList.contains('popup-open') || document.querySelector('dialog[open]')) return;
      root.classList.remove('popup-open');
      document.body.style.top = '';
      window.scrollTo(0, y);
    };
    const show = HTMLDialogElement.prototype.showModal;
    const close = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.showModal = function (...a) { lock(); try { return show.apply(this, a); } catch (e) { unlock(); throw e; } };
    HTMLDialogElement.prototype.close = function (...a) { const r = close.apply(this, a); unlock(); return r; };
    document.addEventListener('close', () => unlock(), true);
  })();

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
    assetSearch: false,  // the server searches a universe too big to ship
    assetCount: 0,
    found: new Map(),    // symbol -> asset, from search results, so selection works off-list
    ticker: null,        // the live-price loop: { timer, step, symbols }
    achShown: new Set(), // achievements already popped this page load
    reviewChecked: false, // the welcome-back review has had its chance this page load
    cameBack: false,     // the tab was away long enough to count as coming back
    awayAt: 0,
    reviewing: false,    // the review is fetching or open
    afterReview: new Map(), // what waits for the review to close, by name
    reviewChart: null,
    trickle: null,       // { at, t }: the last GET /trickle, for "Your team"
    events: null,        // { at, list }: the last GET /events/current
  };

  // --- formatting ----------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Play money is shown in thousands: a unit is $1K, a thousand units is $1M,
  // one decimal at most. Under $0.1K it's shown in plain dollars ($40) rather
  // than rounding a real amount to nothing. Real stock prices use price().
  const fmt1 = (v) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  const moneyParts = (n, opts = {}) => {
    if (n === null || n === undefined || Number.isNaN(n)) return null;
    const a = Math.abs(n), sign = n < 0 ? '−\u2060' : ''; // the word joiner keeps "−" and "$" on one line
    if (a === 0) return { sign, num: '0', unit: '' };
    if (a >= 1000) return { sign, num: fmt1(a / 1000), unit: 'M' };
    if (a < 0.1 && !opts.whole) return { sign, num: String(Math.round(a * 1000)), unit: '' };
    return { sign, num: opts.whole ? String(Math.round(a)) : fmt1(a), unit: 'K' };
  };
  const money = (n, opts = {}) => { const m = moneyParts(n, opts); return m ? `${m.sign}$${m.num}${m.unit}` : '—'; };
  // Real dollars: the charity money on Lobbyfest and the promises. Never play money.
  const usd = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`);
  // A deduction on a receipt (tax): always shown with its minus sign.
  const minus = (n, opts = {}) => money(-Math.abs(n), opts);
  const moneySplit = (n) => { const m = moneyParts(n) || { sign: '', num: '0', unit: '' }; return `${m.sign}<small>$</small>${esc(m.num)}${m.unit ? `<small>${m.unit}</small>` : ''}`; };
  const pct = (p, digits = 1) => {
    if (p === null || p === undefined || Number.isNaN(p)) return '—';
    const v = p * 100, f = Math.abs(v).toFixed(digits);
    return `${Number(f) === 0 ? '' : v > 0 ? '+' : '−'}${f}%`; // a true minus, like money()
  };
  const dir = (p) => (p > 0 ? 'up' : p < 0 ? 'down' : '');
  // Real prices, in real dollars.
  const price = (p) => (p === null || p === undefined || Number.isNaN(p) ? '—' : p >= 1000 ? `$${Math.round(p).toLocaleString('en-US')}` : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(3)}`);
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
    if (name !== 'profile') $('#btn-me').classList.remove('on');
    state.tab = name;
    window.scrollTo({ top: 0 });
  }

  const UNCONFIGURED = !API.demo && /YOUR-HEROKU-APP/.test((window.TRICKLE_CONFIG || {}).API_BASE || '');

  async function route() {
    // An invite link carries ?from= inside the hash; the route is what's before it.
    const hash = (location.hash || '#today').slice(1).split('?')[0] || 'today';
    if (UNCONFIGURED) { showScreen('welcome'); renderUnconfigured(); return; }
    if (!API.token()) {
      // The promises are public: anyone can read them before signing up.
      if (hash === 'promises') { setSignedIn(false); showScreen('promises'); renderPromises(); return; }
      if (hash === 'history') { setSignedIn(false); showScreen('history'); renderHistory(); return; }
      // So is anyone's profile: a shared link shows the town, then the way in.
      if (hash.startsWith('u/')) {
        let who = null;
        try { who = decodeURIComponent(hash.slice(2)); } catch (e) { who = null; }
        if (who) { setSignedIn(false); showScreen('profile'); loadProfile(who); return; }
      }
      showScreen('welcome'); renderWelcome(); return;
    }
    // #u/<name> is someone's profile; #profile is yours. #trickle is the old
    // name for the Lobbyfest page, kept so old links land somewhere.
    let name = hash, who = null;
    if (hash.startsWith('u/')) { name = 'profile'; try { who = decodeURIComponent(hash.slice(2)); } catch (e) { who = null; } }
    if (hash === 'lobby') name = 'trickle';
    if (!['today', 'trickle', 'leaders', 'friends', 'profile', 'how', 'admin', 'promises', 'history'].includes(name)) name = 'today';
    const firstLoad = !state.me;
    if (firstLoad) { await loadMe(); if (!API.token()) return; }
    showScreen(name);
    if (name === 'today' && !firstLoad) loadMe();
    if (name === 'trickle') loadTrickle();
    if (name === 'leaders') loadLeaders();
    if (name === 'friends') loadFriends();
    if (name === 'profile') loadProfile(who || (state.me && state.me.user.username));
    if (name === 'how') renderHow();
    if (name === 'admin') loadAdmin();
    if (name === 'promises') renderPromises();
    if (name === 'history') renderHistory();
  }

  function setSignedIn(on) {
    $('#btn-menu').hidden = !on;
    $('#btn-me').hidden = !on;
    $('#btn-help').hidden = on; // signed in, "How to play" lives in the menu
    $('#foot').hidden = !on;
    $('#masthead-day').hidden = !on;
    $('#btn-trophies').hidden = !on;
    if (!on) hidePeek(true);
    scenery(on ? 'game' : 'landing');
  }

  // --- welcome ----------------------------------------------------------------------

  function renderUnconfigured() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Not connected yet.</h1>
        <p>This copy of Trickle Down doesn't know where its backend lives. In <code>config.js</code>, set <code>API_BASE</code> to your Heroku app's URL (see DEPLOY.md), then reload.</p>
        <p class="muted">Want to see the game without a backend? <a href="?demo">Open the demo</a>: invented prices, nothing saved.</p>
      </div>`;
  }

  // Scenery behind the page: a faint rain of bills in both gutters, always;
  // on the landing page also a tilted heads coin with a sample portfolio on
  // the right and a tails village on the left; in the game, your own
  // lobbyists loitering at the bottom right instead. All inline SVG, so
  // nothing can fail to load; all decorative, hidden from assistive tech and
  // masked away from the text column.
  function scenery(mode) {
    const have = $('.landing-bg');
    if (have && have.dataset.mode === mode) { if (mode === 'game') sceneryCrowd(); return; }
    if (have) have.remove();
    if (mode === 'landing') landingArt(); else gameArt();
    document.body.classList.add('landing');
  }
  function sceneryCrowd() {
    const el = $('.landing-bg .bg-crowd');
    if (!el || !state.me) return;
    const n = Math.max(0, state.me.user.quarter_donated || 0);
    const key = String(Math.round(n * 100));
    if (el.dataset.n === key) return;
    el.dataset.n = key;
    el.innerHTML = n > 0 ? lobbyists(n, { max: 18 }) : '';
    const cap = $('.landing-bg .bg-ground .bg-cap');
    if (cap) cap.textContent = n > 0 ? `${lobby(n)}, loitering` : '';
  }
  function gameArt() {
    const bg = document.createElement('div');
    bg.className = 'landing-bg game';
    bg.dataset.mode = 'game';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = `${rainSvg()}<div class="bg-ground"><div class="bg-crowd"></div><div class="bg-cap"></div></div>`;
    document.body.appendChild(bg);
    sceneryCrowd();
  }
  function rainSvg() {
    return `<svg class="bg-rain" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <defs><pattern id="rain-p" width="150" height="190" patternUnits="userSpaceOnUse">
        <g transform="translate(18 12) rotate(-14)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <g transform="translate(96 54) rotate(11)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <g transform="translate(52 118) rotate(-5)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <path transform="translate(118 140) scale(0.5)" d="M16 4 C16 11 7 15.5 7 21.5 a9 9 0 0 0 18 0 C25 15.5 16 11 16 4Z"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill="url(#rain-p)"/>
    </svg>`;
  }
  // The sample coin, both faces, for the landing page (desktop scenery and the phone hero).
  function landingFaces() {
    const sample = [
      { id: 1, symbol: 'NVDA', invested: 40, value: 54, swing_pct: 0.35, busted: false, matured: false },
      { id: 2, symbol: 'BTC', invested: 25, value: 27.5, swing_pct: 0.1, busted: false, matured: true },
      { id: 3, symbol: 'DOGE', invested: 15, value: 9, swing_pct: -0.4, busted: false, matured: false },
      { id: 4, symbol: 'KO', invested: 10, value: 10.2, swing_pct: 0.02, busted: false, matured: false },
    ];
    const strip = (svg) => svg.replace(/ tabindex="0"/g, '').replace(/ role="button"/g, '');
    const heads = strip(Coin.front({ positions: sample, cash: 30, preview: null, grow: null }));
    const town = { happiness: 72, plots: [{ slot: 'housing', key: 'coop' }, { slot: 'square', key: 'casino' }] };
    const tails = strip(Coin.village({ town, pop: 12, pending: 2 }));
    return { heads, tails };
  }
  function landingArt() {
    const { heads, tails } = landingFaces();
    const bg = document.createElement('div');
    bg.className = 'landing-bg';
    bg.dataset.mode = 'landing';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = `${rainSvg()}
      <div class="bg-coin bg-heads"><div class="bg-face">${heads}</div><div class="bg-cap">heads: the portfolio</div></div>
      <div class="bg-coin bg-tails"><div class="bg-face">${tails}</div><div class="bg-cap">tails: your lobbyists</div></div>
      <div class="bg-ground"><div class="bg-crowd">${lobbyists(9, { max: 9 })}</div></div>`;
    document.body.appendChild(bg);
  }

  function renderWelcome() {
    setSignedIn(false);
    // The phone hero's copy of the coin gets its own SVG ids, so the desktop
    // scenery (hidden on a phone, and vice versa) never borrows a hidden gradient.
    const own = (svg) => svg.replace(/(id="|url\(#|href="#)([A-Za-z][\w-]*)/g, '$1m-$2');
    const { heads, tails } = landingFaces();
    const AGE = "<b>18+ only.</b> By creating an account or playing as a guest, you confirm you're 18 or older.";
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Fake money. Real market. Real charity.</h1>
        <div class="hero-coins" aria-hidden="true">
          <figure class="hc hc-heads"><div class="hc-face">${own(heads)}</div><figcaption>heads: your money</figcaption></figure>
          <figure class="hc hc-tails"><div class="hc-face">${own(tails)}</div><figcaption>tails: your lobbyists</figcaption></figure>
        </div>
        <div class="phone-ways">
          <button class="btn primary wide" id="btn-guest-m" type="button">Play as a guest · no account</button>
          <button class="btn quiet wide" id="btn-register-m" type="button">Create an account</button>
          <button class="linkish center" id="btn-orient-m" type="button">60-second training first</button>
          <p class="age-note">${AGE}</p>
        </div>
        <ul class="pitch">
          <li><b>$100K a day</b> of fake money. Put it on real stocks, hold 24 hours, and the move is multiplied ×10.</li>
          <li><b>Your gains are taxed</b>, never what you put in. The tax hires lobbyists for the charity you pick.</li>
          <li><b>Every quarter</b> this site's real ad money goes to charity (at least $100, every time), split by how many lobbyists each charity has.</li>
        </ul>
        <p class="landing-stats" id="landing-stats" hidden></p>
        <p class="pitch-promise"><a href="#promises">Our mission &amp; promises</a>: where the money goes, in writing.</p>
        <button class="training" id="btn-orient" type="button">
          <span class="training-tag">Step one</span>
          <span class="training-title">Take the employee training</span>
          <span class="training-sub">Four slides. Mandatory. Compensated in knowledge.</span>
        </button>
        <div class="ways-in">
          <button class="btn primary" id="btn-register">Create an account</button>
          <button class="btn primary" id="btn-guest">Play as a guest</button>
        </div>
        <p class="age-note desk-age">${AGE}</p>
        <button class="linkish center" id="btn-signin">Already have an account? Sign in</button>
      </div>`;
    const training = () => Explainer.open({ deck: 'main', finale: true, onFinale: welcomeFinale, rules: { demo: !!API.demo } });
    $('#btn-orient').onclick = training;
    $('#btn-orient-m').onclick = training;
    $('#btn-guest').onclick = startGuest;
    $('#btn-guest-m').onclick = startGuest;
    $('#btn-register').onclick = () => openAuth('register');
    $('#btn-register-m').onclick = () => openAuth('register');
    $('#btn-signin').onclick = () => openAuth('login');
    landingStats();
  }

  // "$100 to charity on January 1 · 31 players lobbying" (the count only from 25 up).
  async function landingStats() {
    try {
      const t = await API.get('/trickle');
      const el = $('#landing-stats');
      if (!el) return;
      const on = new Date(t.quarter_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
      el.innerHTML = `<b>${usd(t.payout_usd != null ? t.payout_usd : 100)}</b> to charity on ${esc(on)}${t.quarter_donors >= 25 ? ` · <b>${t.quarter_donors}</b> players lobbying` : ''}`;
      el.hidden = false;
    } catch (e) { /* the stats row just stays hidden */ }
  }

  // Training taken from the landing page ends in the three ways in.
  const welcomeFinale = (choice) => { if (choice === 'guest') startGuest(); else openAuth(choice); };

  // Invite links: /?from=<name> or /#u/<name>?from=<name>. Remembered for this
  // tab; used once, right after a new account is made (never on sign-in).
  const INVITE_KEY = 'trickledown.from';
  (function captureInvite() {
    const read = (q) => { try { return new URLSearchParams(q).get('from'); } catch (e) { return null; } };
    const from = read(location.search) || read((location.hash.split('?')[1]) || '');
    if (from && /^[A-Za-z0-9_]{3,20}$/.test(from)) { try { sessionStorage.setItem(INVITE_KEY, from); } catch (e) { /* no invite, then */ } }
  })();
  async function useInvite() {
    let from = null;
    try { from = sessionStorage.getItem(INVITE_KEY); sessionStorage.removeItem(INVITE_KEY); } catch (e) { return; }
    if (!from) return;
    try {
      const r = await API.post('/friends/invite', { from });
      // After the welcome's own toasts have had their turn.
      if (r && r.ok) setTimeout(() => toast(`${r.username} is on your friends list. They sent you here, after all.`, 5000), REDUCED ? 1500 : 6000);
    } catch (e) { /* the link was bad; nothing to say */ }
  }

  async function startGuest() {
    if (state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/auth/guest');
      API.setToken(r.token);
      useInvite();
      location.hash = '#today'; route();
    } catch (e) { toast(e.message, 4000); }
    finally { state.busy = false; }
  }

  // --- today: data ------------------------------------------------------------------

  async function loadMe() {
    try {
      const me = await API.get('/me');
      legacyAchievements(me);
      state.me = me;
      checkServer(me);
      // The server hands out a fresh token when the current one is past half
      // its life, so a guest who keeps showing up is never signed out.
      if (me.token && !API.demo) API.setToken(me.token);
      setSignedIn(true);
      renderToday();
      renderTrophyCount();
      updateMenuDot();
      // Back after a while (a fresh page, a new day, the tab away ten minutes)
      // with positions that matured unseen: the performance review comes
      // first, and the rest of the welcome waits until it closes.
      const returning = !state.reviewChecked || state.cameBack || !!me.allowance;
      state.reviewChecked = true; state.cameBack = false;
      // Without positions to replay, a first load of the day with news gets the digest.
      const reviewing = (returning && (maybeReview(me) || maybeDigest(me))) || state.reviewing;
      const after = (name, fn) => { if (reviewing) state.afterReview.set(name, fn); else fn(); };
      after('wall', () => maybeWallToast(state.me));
      after('followers', () => maybeFollowerPeek(state.me));
      after('charity', () => maybeCharityChooser(state.me));
      // The review lists new cards itself.
      if (me.fresh_cards && me.fresh_cards.length && !reviewing) setTimeout(() => announceCards(me.fresh_cards), me.allowance ? 5400 : 800);
      if (!state.justBought) after('achievement', () => maybeAchievement(me.allowance && !REDUCED && !reviewing ? 2600 : 900));
      if (!Explainer.seen('main') && !state.oriented) {
        state.oriented = true;
        setTimeout(() => Explainer.open({ deck: 'main', rules: me.rules }), me.allowance && !REDUCED ? 1700 : 300);
      }
      if (me.allowance && reviewing) {
        // The review says what landed; the coin still lands when it closes.
        after('toss', () => tossCoin());
      } else if (me.allowance) {
        tossCoin();
        const a = me.allowance;
        const ti = a.town_income || 0;
        const village = ti ? ` (${money(a.base != null ? a.base : a.amount - ti, { whole: true })} stipend ${ti > 0 ? '+' : '−'} ${money(Math.abs(ti), { whole: true })} ${ti > 0 ? 'from' : 'upkeep for'} TrickleTown)` : '';
        const quit = '';
        setTimeout(() => toast(`${me.user.streak > 1 ? `Day ${me.user.streak} of your streak: ` : ''}${money(a.amount, { whole: true })} landed on the coin${village}.${quit}`, 4200), REDUCED ? 0 : 1100);
      }
    } catch (e) {
      if (e.status === 401) { API.setToken(null); route(); return; }
      toast(e.message);
    }
  }

  async function ensureAssets() {
    if (!state.assets.length) { const r = await API.get('/assets'); state.assets = r.assets; state.assetSearch = !!r.search; state.assetCount = r.count || r.assets.length; }
    await ensureCharities();
  }
  async function ensureCharities() {
    if (!state.charities.length) state.charities = (await API.get('/charities')).charities;
  }

  // "New money in 6h 31m"; on a narrow phone, "Refill in 6h 31m" (CSS picks).
  const countdownHtml = (at) => `<span class="cd-long">New money in</span><span class="cd-short">Refill in</span> ${esc(countdown(at))}`;

  function renderMasthead() {
    const { day, user } = state.me;
    $('#day-number').textContent = `Day ${user.account_day || day.number}`; // your day, not the site's
    $('#day-countdown').innerHTML = countdownHtml(day.resets_at);
    $('#foot-user').innerHTML = `${user.is_guest ? 'Playing as' : 'Signed in as'} <a href="#profile">${esc(user.username)}</a>`;
    // Your avatar, top right: one tap to your profile.
    const av = $('#me-avatar'); av.textContent = initial(user.username); av.style.setProperty('--av', avColor(user.username));
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
      center = `<b>${moneySplit(me.user.cash)}</b><span><span class="free">free to spend</span><br>${money(total)} ${me.positions.length ? 'in play' : 'on the coin'}</span>`;
    } else if (total > 0) {
      center = `<b>${moneySplit(total)}</b><span>in play<br>nothing free to spend</span>`;
    } else {
      center = `<b><small>$</small>0</b><span>Come back tomorrow.</span>`;
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
      if (state.tab !== 'today' || !state.flipped || $('#dlg-hire').open || $('#dlg-site').open || $('#dlg-advisors').open) return;
      Explainer.open({ deck: 'town', onDone: () => { if (!state.flipped) flip(true); setTimeout(() => { const a = $('#agenda'); if (a) a.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }, 500); } });
    }, delay);
  }

  function coinBackMarkup() {
    const me = state.me;
    const q = Math.max(0, me.user.quarter_donated || 0);
    const svg = Coin.village({ town: me.town, pop: round2(q), pending: pendingIssues(), locked: !me.town.unlocked, progress: me.user.total_donated });
    if (!me.town.unlocked) return `${svg}<button class="coin-tap village-tap" type="button" aria-label="Flip the coin back"></button>`;
    // Tap a building for its Site Office, an advisor for Town Hall; anywhere else flips back.
    const plot = (slot) => me.town.plots.find((p) => p.slot === slot);
    const label = (slot) => { const p = plot(slot); return p && p.building ? `${p.building.name}: open the Site Office` : `Empty lot (${p ? p.label : slot}): build something`; };
    return `${svg}<button class="coin-tap village-tap" type="button" aria-label="Flip the coin back"></button>
      <button type="button" class="coin-hit site-housing" data-coin-site="housing" aria-label="${esc(label('housing'))}"></button>
      <button type="button" class="coin-hit site-square" data-coin-site="square" aria-label="${esc(label('square'))}"></button>
      ${pendingIssues() ? '<button type="button" class="coin-hit adv-a1" data-coin-adv aria-label="Speak with your advisors"></button><button type="button" class="coin-hit adv-a2" data-coin-adv aria-label="Speak with your advisors"></button>' : ''}
      ${me.town.cat ? `<button type="button" class="coin-hit cat" data-coin-cat aria-label="${esc(me.town.cat.name ? `${me.town.cat.name}, the cat: open the wardrobe` : 'The cat: give her a name')}"></button>` : ''}`;
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
    $$('[data-coin-site]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openSite(b.dataset.coinSite); }; });
    $$('[data-coin-adv]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openAdvisors(); }; });
    $$('[data-coin-cat]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openCat(); }; });
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

  // The two sides of the coin, named. Tapping a side flips to it. The side
  // you're not on carries id="btn-flip" so older code and tests that "flip"
  // keep working.
  function captionMarkup() {
    const me = state.me;
    const n = pendingIssues();
    const locked = me && me.town && !me.town.unlocked;
    const tab = (side, label, extra = '') => {
      const on = state.flipped === (side === 'back');
      return `<button type="button" role="tab" aria-selected="${on}" class="side-tab ${on ? 'on' : ''}" data-side="${side}" ${on ? '' : 'id="btn-flip"'}>${label}${extra}</button>`;
    };
    const townExtra = locked ? ' <span class="side-lock" title="Opens with your first lobbyist">🔒</span>'
      : n ? ` <span class="side-badge">${n}</span>` : '';
    return `<div class="side-switch" role="tablist" aria-label="Which side of the coin">
      ${tab('front', 'Portfolio')}
      ${tab('back', 'TrickleTown', townExtra)}
    </div>
    <div class="side-hint muted small">${locked ? 'TrickleTown opens when you hire your first lobbyist.' : state.flipped ? 'Where your lobbyists live.' : n ? `${n} card${n === 1 ? '' : 's'} waiting in TrickleTown.` : ''}</div>`;
  }
  function wireCaption() {
    $$('.side-tab').forEach((b) => { b.onclick = () => { const to = b.dataset.side === 'back'; if (to !== state.flipped) flip(to); }; });
  }

  function flip(to) {
    clearTimeout(state.flipTimer);
    state.flipped = to === undefined ? !state.flipped : to;
    const coin = $('#coin');
    if (coin) coin.classList.toggle('flipped', state.flipped);
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); wireCaption(); }
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
    tickerStart(state.justBought); state.justBought = false;
    sceneryCrowd();
    const me = state.me;
    if (!me) return;
    renderMasthead();
    if (state.carve > me.user.cash) state.carve = 0;

    $('#screen-today').innerHTML = `
      <div id="event-banner" hidden></div>
      <div class="coin-stage">
        <div class="coin ${state.flipped ? 'flipped' : ''}" id="coin">
          <div class="coin-inner">
            <div class="coin-face front" id="coin-front"></div>
            <div class="coin-face back" id="coin-back"></div>
          </div>
        </div>
        <div class="coin-caption">${captionMarkup()}</div>
      </div>
      ${installHintMarkup(me)}
      <div id="under"></div>`;
    paintCoin();
    wireCaption();
    renderUnder();
    wireInstallHint();
    paintEventBanner();
  }

  // --- installing it (3.1) ---------------------------------------------------------------
  // From the third day, until it's dismissed or already on the home screen.
  const INSTALL_KEY = 'trickledown.install-hint';
  const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installHow = () => (IS_IOS ? 'Share → Add to Home Screen.' : 'Browser menu → Add to Home screen.');
  function installHintMarkup(me) {
    if ((me.user.account_day || 0) < 3 || isStandalone()) return '';
    try { if (localStorage.getItem(INSTALL_KEY)) return ''; } catch (e) { return ''; }
    return `<div class="install-hint" id="install-hint" role="note">
      <p><b>Put it on your home screen.</b> ${installHow()} Then it's an app, and the lobbyists can't tell the difference.</p>
      <button type="button" class="close" id="install-hint-x" aria-label="Dismiss">×</button>
    </div>`;
  }
  function wireInstallHint() {
    const x = $('#install-hint-x');
    if (x) x.onclick = () => { try { localStorage.setItem(INSTALL_KEY, '1'); } catch (e) { /* gone for this view */ } const h = $('#install-hint'); if (h) h.remove(); };
  }

  // --- the weekly beat (4.5) ---------------------------------------------------------------
  // A featured charity: lobbyists hired for it count extra while it runs.
  async function currentEvents() {
    if (!state.events || Date.now() - state.events.at > 5 * 60e3) {
      try { state.events = { at: Date.now(), list: (await API.get('/events/current')).events || [] }; } catch (e) { return state.events ? state.events.list : []; }
    }
    return state.events.list;
  }
  const featuredNow = (list) => (list || []).find((e) => e.kind === 'featured_charity' && e.charity_name);
  const multStr = (m) => `×${Number(m || 1.25).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}`;
  const eventBannerHtml = (e) => (e ? `<div class="event-banner"><span class="eb-tag">${esc(e.title || 'Featured charity')}</span><p>This week: <b>${esc(e.charity_name)}</b>. Lobbyists hired for them count ${multStr(e.multiplier)}.${e.blurb ? ` <span class="muted">${esc(e.blurb)}</span>` : ''}</p></div>` : '');
  async function paintEventBanner() {
    const fill = (list) => { const el = $('#event-banner'); if (!el) return; const e = featuredNow(list); el.innerHTML = eventBannerHtml(e); el.hidden = !e; };
    if (state.events) fill(state.events.list);
    fill(await currentEvents());
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
        <span class="muted">${money(user.cash)} free · ${nextMoney} tomorrow${user.streak > 1 ? ` · ${user.streak}-day streak` : ''}</span>
      </div>`;
    const firstTime = isFirstTime(me);
    const fb = achOf(me, 'first_buy');
    const guide = firstTime ? `
      <div class="first-steps" id="first-steps">
        <div class="fs-head"><b>Your first buy</b><span>Three taps.</span></div>
        <ol>
          <li data-step="1"><b>Pick something.</b> A company, a ticker, or a coin.</li>
          <li data-step="2"><b>Say how much.</b> Any slice of your ${money(user.cash)}.</li>
          <li data-step="3"><b>Buy.</b> It rides the real market for ${me.rules.hold_hours} hours.</li>
        </ol>
        <p class="fs-gift">🏆 Your first buy unlocks an achievement and a <b>${money(fb ? fb.gift : 40)} bonus</b> from Mommy &amp; Daddy.</p>
      </div>` : '';
    const carve = canCarve ? `
      <section class="carve">
        <h2>Buy</h2>
        ${guide}
        <div class="picker" id="picker">
          <div class="picked" id="picked" hidden></div>
          <input type="search" id="carve-search" placeholder="Nvidia, BTC, gold, the S&amp;P…" autocomplete="off" spellcheck="false" aria-label="Search for something to buy">
          <ul class="asset-list" id="asset-list" role="listbox" hidden></ul>
        </div>
        <div class="amount-zone" id="amount-zone" hidden>
          <div class="amount-row"><span class="amount-prefix">$</span><input id="carve-usd" type="text" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Amount in thousands of dollars"><span class="amount-suffix" id="carve-k" aria-hidden="true">K</span></div>
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
        <span class="muted">${ready ? `${ready} position${ready === 1 ? ' is' : 's are'} ready to collect.` : 'New money tomorrow.'}</span>
      </section>`;

    const legend = positions.length ? `
      <section class="legend">
        <h2>On the coin <span class="muted">${positions.length} position${positions.length === 1 ? '' : 's'}${ready ? ` · ${ready} ready` : ''}</span></h2>
        <ul class="positions">${positions.map(positionRow).join('')}</ul>
      </section>` : '';

    return `${head}${todoStrip()}${carve}${legend}${crowdStrip(me.crowd)}
      <div class="row-actions">
        <button class="btn quiet small" id="btn-share">Share my day</button>
        <a class="btn quiet small" href="#profile">My profile &amp; trading history</a>
      </div>`;
  }

  // What's worth doing right now, in one glance: collect, play cards, invest,
  // build. When it's all done it says so, and when the next thing lands.
  function todoStrip() {
    const me = state.me;
    if (isFirstTime(me)) return ''; // the first-investment guide is the to-do
    const items = [];
    const ready = me.positions.filter((p) => p.matured && !p.quote_error && !p.busted);
    const buried = me.positions.filter((p) => p.matured && p.busted);
    const town = me.town;
    // Earned, but the popup was closed (or the tab was): the gift is still waiting.
    for (const key of unclaimedKeys(me)) { const a = achOf(me, key); items.push({ k: 'gift', id: key, text: `🏆 <b>${esc(a.title)}</b>: ${esc(a.from)} sent ${money(a.gift, { whole: true })}. Open it` }); }
    if (me.needs_charity) items.push({ k: 'charity', text: '❤️ <b>Choose your charity.</b> Your lobbyists are waiting for a cause' });
    if (me.wall_unread) items.push({ k: 'wall', text: `💬 ${wallWho(me)} on your wall. Read it` });
    if (me.town && me.town.cat && !me.town.cat.name) items.push({ k: 'cat', text: '🐈 The cat is waiting for a <b>name</b>' });
    const nf = me.new_followers || [];
    if (nf.length) items.push({ k: 'friend', text: `👋 <b>${esc(nf[0].username)}</b>${nf.length > 1 ? ` and ${nf.length - 1} other${nf.length > 2 ? 's' : ''}` : ''} added you. Add back?` });
    if (ready.length) items.push({ k: 'collect', id: ready[0].id, text: ready.length === 1 ? `Collect <b>${esc(ready[0].symbol)}</b>, ready at ${pct(ready[0].swing_pct, 0)}` : `Collect <b>${ready.length} matured</b> positions` });
    if (buried.length) items.push({ k: 'collect', id: buried[0].id, text: `Bury <b>${esc(buried[0].symbol)}</b>. It's gone.` });
    const cards = pendingIssues();
    if (town && town.unlocked && cards) items.push({ k: 'cards', text: `Play <b>${cards} card${cards === 1 ? '' : 's'}</b> at TrickleTown Hall` });
    if (me.user.cash >= 1 && !isFirstTime(me)) items.push({ k: 'invest', text: `Invest the <b>${money(me.user.cash)}</b> sitting on the coin` });
    if (town && town.unlocked) {
      const empty = town.plots.find((pl) => !pl.building);
      if (empty) { const cheapest = Math.min(...empty.options.map((o) => o.cost)); items.push({ k: 'site', slot: empty.slot, text: affords(me.user.cash, cheapest) ? `Build on the empty <b>${esc(empty.label.toLowerCase())}</b> lot, from ${money(cheapest, { whole: true })}` : `Save up for the empty <b>${esc(empty.label.toLowerCase())}</b> lot (from ${money(cheapest, { whole: true })})` }); }
      const prop = town.plots.find((pl) => pl.building && pl.proposals);
      if (prop) items.push({ k: 'site', slot: prop.slot, text: `Hear <b>${prop.proposals} upgrade proposal${prop.proposals === 1 ? '' : 's'}</b> at ${esc(prop.building.name)}` });
    }
    if (!items.length) {
      const live = me.positions.filter((p) => !p.matured);
      const soonest = live.length ? live.reduce((a, b) => (new Date(a.matures_at) < new Date(b.matures_at) ? a : b)) : null;
      return `<div class="todo done"><b>All done for today.</b> <span>${soonest ? `${esc(soonest.symbol)} matures in <span data-left="${esc(soonest.matures_at)}">${left(soonest.matures_at)}</span>; ` : ''}new money in <span data-countdown>${countdown(me.day.resets_at)}</span>.</span></div>`;
    }
    return `<div class="todo"><b>To do</b><ul>${items.map((it, i) => `<li><button type="button" class="linkish" data-todo="${esc(it.k)}" data-id="${it.id || ''}" data-slot="${it.slot || ''}">${it.text}</button></li>`).join('')}</ul></div>`;
  }

  function positionRow(p) {
    const cls = ['position'];
    if (p.quote_error) cls.push('stale');
    else if (p.busted) cls.push('busted');
    else cls.push(dir(p.swing_pct));
    if (p.matured) cls.push('matured');
    const opened = new Date(p.opened_at).getTime(), matures = new Date(p.matures_at).getTime();
    const k = p.matured ? 1 : Math.max(0, Math.min(1, (Date.now() - opened) / Math.max(1, matures - opened)));
    const riding = p.ride_count > 0 ? `<span class="tag">Riding ×${p.ride_count}</span>` : '';
    let value, move, action;
    if (p.quote_error) {
      value = `${money(p.invested)} → <b>?</b>`;
      move = `${riding}Price unavailable right now.`;
      action = `<button class="btn small" disabled>Sell</button>`;
    } else if (p.busted) {
      value = `${money(p.invested)} → <b>${money(0)}</b>`;
      move = `${riding}Fell ${pct(Math.abs(p.real_pct))} at ${mult(p.multiplier_now)}. Gone.`;
      action = `<button class="btn small" data-sell="${p.id}">Bury it</button>`;
    } else if (p.matured) {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${riding}<span class="ready">Matured at ${mult(p.multiplier)}.</span> Collect it, or let it ride.${p.matured_late ? ' <span class="muted">(Froze at the next price seen after its 24 hours.)</span>' : ''}`;
      action = `<button class="btn small primary" data-sell="${p.id}">Collect</button> <button class="btn small" data-ride="${p.id}">Ride</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${riding}Real move ${pct(p.real_pct, Math.abs(p.real_pct) < 0.01 ? 2 : 1)}, at ${mult(p.multiplier_now)} now. <span class="time">${mult(p.multiplier)} in <span data-left="${esc(p.matures_at)}">${left(p.matures_at)}</span>.</span>${p.deferred_tax > 0 ? ` <span class="muted">Selling early owes ride tax: ${minus(p.deferred_tax)}.</span>` : ''}`;
      action = `<button class="btn small" data-sell="${p.id}">Sell early</button>`;
    }
    return `
      <li class="${cls.join(' ')}" data-id="${p.id}">
        <span class="swatch"></span>
        <div class="ticker"><b>${esc(p.symbol)}</b><span>${esc(p.name)}</span></div>
        <div class="value">${value}</div>
        <div class="move">${move}</div>
        <div class="action">${action}</div>
        <span class="hold-bar" aria-hidden="true"><i style="--w:${Math.round(k * 100)}%"></i></span>
      </li>`;
  }

  function crowdStrip(crowd) {
    if (!crowd || !crowd.buys) return `<p class="muted" style="font-size:14px">Nobody has bought anything yet today. First mover.</p>`;
    const total = crowd.buys;
    const friends = (crowd.friends || []).filter((f) => f.symbols && f.symbols.length);
    const friendLine = friends.length
      ? `<p class="muted crowd-friends" style="font-size:14px">${friends.slice(0, 4).map((f) => `<a href="#" class="player-link" data-player="${esc(f.username)}">${esc(f.username)}</a> bought ${f.symbols.map((s) => `<b>${esc(s)}</b>`).join(', ')}`).join('; ')}${friends.length > 4 ? `; and ${friends.length - 4} more` : ''}.</p>`
      : '';
    // A small count is more embarrassing than informative.
    return `<p class="muted crowd-line">Today's buys${crowd.players >= 25 ? `, ${crowd.players} players` : ''}: ${crowd.picks.map((c) => `<b>${esc(c.symbol)}</b> ${Math.round(c.buys / total * 100)}%`).join(' · ')}.</p>${friendLine}`;
  }

  // --- The live ticker -------------------------------------------------------------
  //
  // Right after a buy you want to see the thing move. The server's quote
  // cache is a minute; this loop asks for fresher quotes (?fresh=1, up to 4s
  // old) every 3 seconds at first, then backs off to once a minute while the
  // page stays open, and starts over fast on the next buy. Values are
  // recomputed here with the same formula the server uses, so the coin and
  // the rows update without a full reload.
  const TICKER_STEPS = [3000, 3000, 3000, 3000, 5000, 5000, 5000, 8000, 8000, 12000, 15000, 20000, 30000, 45000, 60000];

  function valueLive(p, px) {
    const opened = new Date(p.opened_at).getTime(), matures = new Date(p.matures_at).getTime();
    const k = Math.max(0, Math.min(1, (Date.now() - opened) / Math.max(1, matures - opened)));
    const floor = Math.min(p.mult_floor != null ? p.mult_floor : 1, p.multiplier);
    const m = floor + (p.multiplier - floor) * k;
    const real = (px - p.entry_price) / p.entry_price;
    const swing = m * real;
    const raw = p.invested * (1 + swing);
    const value = round2(Math.max(0, raw));
    const profit = round2(value - p.invested);
    const rate = state.me.rules.tax_rate;
    const own = profit > 0 ? round2(profit * rate) : 0;
    const due = round2(Math.min(Math.max(0, p.deferred_tax || 0), Math.max(0, value - own)));
    const tax = round2(own + due);
    return { price: px, real_pct: real, swing_pct: Math.max(-1, swing), multiplier_now: Math.round(m * 100) / 100, value, busted: raw <= 0,
      preview: { profit, tax, deferred_tax: due, net: round2(value - tax), tier: p.preview ? p.preview.tier : '' } };
  }

  function tickerStart(fast = false) {
    tickerStop();
    if (!state.me || API.demo) return;
    const symbols = [...new Set(state.me.positions.filter((p) => !p.matured && !p.quote_error).map((p) => p.symbol))];
    if (!symbols.length) return;
    state.ticker = { symbols, step: fast ? 0 : 6, timer: null };
    tickerSchedule();
  }
  function tickerStop() { if (state.ticker && state.ticker.timer) clearTimeout(state.ticker.timer); state.ticker = null; }
  function tickerSchedule() {
    const t = state.ticker; if (!t) return;
    t.timer = setTimeout(tickerTick, TICKER_STEPS[Math.min(t.step, TICKER_STEPS.length - 1)]);
  }
  async function tickerTick() {
    const t = state.ticker;
    if (!t || !state.me || state.tab !== 'today' || document.visibilityState !== 'visible') { if (t) tickerSchedule(); return; }
    try {
      const r = await API.get(`/quotes?symbols=${encodeURIComponent(t.symbols.join(','))}&fresh=1`);
      let changed = false;
      for (const p of state.me.positions) {
        const q = r.quotes[p.symbol];
        if (p.matured || !q || !(q.price > 0)) continue;
        const live = valueLive(p, q.price);
        if (live.value !== p.value || live.price !== p.price) changed = true;
        Object.assign(p, live);
      }
      if (changed && !state.flipped && !$('#dlg-sell').open) {
        paintCoin();
        for (const p of state.me.positions) {
          const row = $(`.position[data-id="${p.id}"]`);
          if (!row || p.matured) continue;
          const fresh = document.createElement('div'); fresh.innerHTML = positionRow(p);
          const next = fresh.firstElementChild;
          row.className = next.className;
          row.querySelector('.value').innerHTML = next.querySelector('.value').innerHTML;
          row.querySelector('.move').innerHTML = next.querySelector('.move').innerHTML;
        }
      }
    } catch (e) {
      // An older backend without /quotes: stand down instead of retrying.
      if (e && e.status === 404) { tickerStop(); return; }
    }
    if (state.ticker === t) { t.step++; tickerSchedule(); }
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
    $$('[data-todo]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.todo;
        if (k === 'collect') openSell(Number(b.dataset.id));
        else if (k === 'gift') openAchievement(b.dataset.id);
        else if (k === 'wall') { prof.toWall = true; location.hash = '#profile'; }
        else if (k === 'cat') openCat('name');
        else if (k === 'friend') location.hash = '#friends';
        else if (k === 'charity') openCharityChooser();
        else if (k === 'cards') { flip(true); if (Explainer.seen('town')) setTimeout(() => openAdvisors(), REDUCED ? 50 : 700); }
        else if (k === 'invest') { const sch = $('#carve-search'); if (sch) { sch.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); sch.focus(); } }
        else if (k === 'site') { flip(true); if (Explainer.seen('town')) setTimeout(() => openSite(b.dataset.slot), REDUCED ? 50 : 700); }
      };
    });
    $('#btn-share').onclick = share;
    const search = $('#carve-search');
    if (!search) return;
    const list = $('#asset-list'), usd = $('#carve-usd');
    const cash = state.me.user.cash;

    const setCarve = (dollars, fromInput) => {
      const d = round2(Math.max(0, Math.min(cash, Number(dollars) || 0)));
      state.carve = d;
      if (!fromInput) usd.value = d > 0 ? d : '';
      placeK();
      $$('#carve-chips button').forEach((b) => b.classList.toggle('on', d > 0 && Math.round(d / cash * 100) === Number(b.dataset.pct)));
      paintCoin();
      updateBuyButton();
    };
    // Digits and one decimal point; the K follows the number as it's typed.
    usd.addEventListener('input', () => {
      const clean = usd.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
      if (clean !== usd.value) usd.value = clean;
      setCarve(usd.value, true);
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeK);
    placeK();
    $$('#carve-chips button').forEach((b) => {
      b.onclick = () => { setCarve(Number(b.dataset.pct) === 100 ? cash : cash * Number(b.dataset.pct) / 100); usd.focus(); };
    });

    let searchTimer = null, searchSeq = 0;
    const openList = () => {
      list.hidden = false;
      const q = search.value.trim();
      if (!state.assetSearch || !q) { renderAssetList(q); return; }
      // Server search: the universe is thousands of names. Debounced, and a
      // late answer to an older keystroke is ignored.
      renderAssetList(q, state.lastSearch && state.lastSearch.q === q ? state.lastSearch.assets : null);
      clearTimeout(searchTimer);
      const seq = ++searchSeq;
      searchTimer = setTimeout(async () => {
        try {
          const r = await API.get(`/assets/search?q=${encodeURIComponent(q)}`);
          if (seq !== searchSeq || search.value.trim() !== q) return;
          r.assets.forEach((a) => state.found.set(a.symbol, a));
          state.lastSearch = { q, assets: r.assets };
          if (!list.hidden) renderAssetList(q, r.assets);
        } catch (e) { /* keep whatever is showing */ }
      }, 160);
    };
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
    guideStep();
  }

  const moodChip = (a) => (a.mood ? `<span class="mood ${esc(a.mood)}">${esc(a.mood)} ${mult(a.multiplier)}</span>` : `<span class="mood plain">${a.kind === 'etf' ? 'ETF ' : a.type === 'crypto' ? 'Crypto ' : ''}${mult(a.multiplier)}</span>`);

  // results: a server search's answer, or null to filter the featured list locally.
  function renderAssetList(q, results = null) {
    const el = $('#asset-list');
    if (!el) return;
    const needle = q.trim().toLowerCase();
    let list;
    if (results) list = results;
    else if (!needle) list = state.assets;
    else list = state.assets.filter((a) => a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle));
    if (!list.length) {
      el.innerHTML = results || !state.assetSearch
        ? `<li class="nothing">Nothing by that name. Try the ticker${state.assetSearch ? `; ${state.assetCount.toLocaleString('en-US')} names are in the game` : ''}.</li>`
        : `<li class="nothing">Searching…</li>`;
      return;
    }
    const head = !needle && state.assetSearch ? `<li class="nothing">Featured. Type any US ticker or company name; ${state.assetCount.toLocaleString('en-US')} are in the game.</li>` : '';
    el.innerHTML = head + list.slice(0, 60).map((a) => `
      <li role="option" data-symbol="${esc(a.symbol)}">
        <b>${esc(a.symbol)}</b>
        <span>${esc(a.name)}</span>
        ${moodChip(a)}
      </li>`).join('');
    $$('li[data-symbol]', el).forEach((li) => {
      // pointerdown beats the search field's blur, so the tap registers.
      li.onpointerdown = (e) => { e.preventDefault(); selectAsset(li.dataset.symbol); };
    });
  }

  async function selectAsset(symbol) {
    state.selected = state.assets.find((a) => a.symbol === symbol) || state.found.get(symbol) || null;
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
      <div class="picked-main"><b>${esc(a.symbol)}</b><span>${esc(a.name)}</span>${moodChip(a)}</div>
      <div class="q">${qline}</div>
      <button type="button" class="linkish" id="carve-change">Change</button>`;
    pk.hidden = false; search.hidden = true; list.hidden = true; zone.hidden = false;
    $('#carve-change').onclick = () => {
      state.selected = null; state.quote = null; state.carve = 0;
      const usd = $('#carve-usd'); if (usd) usd.value = '';
      showPicked(); paintCoin(); updateBuyButton();
      search.value = ''; search.focus();
    };
    placeK();
    if (!(state.carve > 0)) { const usd = $('#carve-usd'); if (usd) setTimeout(() => usd.focus(), 30); }
  }

  function guideStep() {
    const g = $('#first-steps');
    if (!g) return;
    const step = !state.selected ? 1 : !(state.carve > 0) ? 2 : 3;
    $$('li', g).forEach((li) => { li.classList.toggle('now', Number(li.dataset.step) === step); li.classList.toggle('done', Number(li.dataset.step) < step); });
  }

  function updateBuyButton() {
    guideStep();
    const btn = $('#carve-buy');
    if (!btn) return;
    const amt = state.carve;
    if (!state.selected) { btn.disabled = true; btn.textContent = 'Pick something first'; return; }
    if (!state.quote) { btn.disabled = true; btn.textContent = `Pricing ${state.selected.symbol}…`; return; }
    if (!(amt > 0)) { btn.disabled = true; btn.textContent = `How much ${state.selected.symbol}?`; return; }
    btn.disabled = false;
    btn.textContent = `Buy ${money(amt)} of ${state.selected.symbol}`;
  }

  // Sit the "K" right after the typed amount ("$50K", not "$50 ……… K"), so
  // it reads as fifty thousand. Measured with the input's own font.
  function placeK() {
    const inp = $('#carve-usd'), k = $('#carve-k');
    if (!inp || !k || !inp.clientWidth) return; // hidden until something is picked
    const cs = getComputedStyle(inp);
    const c = placeK.c || (placeK.c = document.createElement('canvas').getContext('2d'));
    c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // The "$" sits at 12px; start the digits just past it, whatever the font.
    const pad = Math.round(12 + c.measureText('$').width + 2);
    if (inp.style.paddingLeft !== `${pad}px`) inp.style.paddingLeft = `${pad}px`;
    const text = inp.value || inp.placeholder;
    const x = pad + parseFloat(cs.borderLeftWidth) + c.measureText(text).width + 1;
    k.style.left = `${Math.min(x, inp.clientWidth - 16)}px`;
    k.classList.toggle('empty', !inp.value);
  }

  async function submitBuy() {
    if (state.busy || !state.selected || !(state.carve > 0)) return;
    const amount = state.carve, asset = state.selected;
    state.busy = true; $('#carve-buy').disabled = true; $('#carve-buy').textContent = 'Buying…';
    try {
      const r = await API.post('/buy', { symbol: asset.symbol, amount });
      state.carve = 0; state.selected = null; state.quote = null; state.justBought = true;
      toast(`${money(amount)} of ${asset.symbol} at ${price(r.quote.price)}. It matures in ${state.me.rules.hold_hours} hours.`);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
      await animateWedge(r.position.id, 0, 1);
      // Day one: the first buy is the first achievement.
      if (unclaimedKeys(state.me).length) { maybeAchievement(REDUCED ? 100 : 700); return; }
      const s = $('#carve-search'); if (s) s.focus();
    } catch (e) {
      const err = $('#carve-error'); if (err) { err.textContent = e.message; err.hidden = false; }
    } finally {
      state.busy = false; updateBuyButton();
    }
  }

  // --- Tails: TrickleTown -----------------------------------------------------------------

  const CLUE_LABEL = { allowance: 'Profit', cash: 'Cash now', happiness: 'Happiness' };
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
    if (fx.income) out.push(`<span class="clue ${fx.income > 0 ? 'good' : 'bad'}">Profit ${fx.income > 0 ? '+' : '−'}${money(Math.abs(fx.income), { whole: true })}/day</span>`);
    if (fx.happy) out.push(`<span class="clue ${fx.happy > 0 ? 'good' : 'bad'}">Happiness ${fx.happy > 0 ? '+' : '−'}${Math.abs(fx.happy)}</span>`);
    return `<span class="clues">${out.join('')}</span>`;
  }

  // Where you stand, pinned to the top of Town Hall and the Site Office, so
  // every choice is made with the numbers in view. After a choice, each stat
  // that moved shows by how much.
  function statSnapshot() {
    const t = state.me.town, u = state.me.user;
    return { cash: u.cash, income: t.income, happiness: t.happiness, hire: t.hire_cost };
  }
  function renderStats(id) {
    const el = $(id); if (!el || !state.me || !state.me.town) return;
    const s = statSnapshot(), prev = state.statPrev, t = state.me.town;
    const delta = (k, fmt, upIsGood = true) => {
      if (!prev || Math.abs(s[k] - prev[k]) < 0.005) return '';
      const up = s[k] > prev[k];
      return `<em class="${up === upIsGood ? 'good' : 'bad'}">${up ? '+' : '−'}${fmt(Math.abs(s[k] - prev[k]))}</em>`;
    };
    const bar = (v) => `<span class="ss-bar"><i style="--w:${Math.max(0, Math.min(100, v))}%"></i></span>`;
    const m = (v) => money(v);
    const moved = !!prev && ['cash', 'income', 'happiness', 'hire'].some((k) => Math.abs(s[k] - prev[k]) >= 0.005);
    // Labelled as the player's own numbers, so nobody reads them as what the
    // card below costs or pays.
    el.innerHTML = `
      <div class="ss-cap"><span class="ss-cap-ico" aria-hidden="true">${T_ICON.vitals}</span><b>Your stats right now</b>${moved ? '<span class="ss-cap-note">tags show what that pick changed</span>' : ''}</div>
      <div class="ss"><span>Cash on hand</span><b>${money(s.cash)}</b>${delta('cash', m)}</div>
      <div class="ss"><span>Profit</span><b class="${s.income < 0 ? 'down' : ''}">${s.income >= 0 ? '+' : '−'}${money(Math.abs(s.income), { whole: true })}<small>/day</small></b>${delta('income', m)}</div>
      <div class="ss"><span>Happiness</span><b>${s.happiness}</b>${bar(s.happiness)}${delta('happiness', String)}</div>
      <div class="ss ss-price" title="Lobbyist price: the tax it takes to hire one lobbyist. Happier towns pay less."><span>Lobbyist price</span><b>${money(s.hire)}</b>${delta('hire', m, false)}</div>`;
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
    bits.push(r.income >= 0 ? `TrickleTown's profit added <b>${money(r.income)}</b> to your allowance` : `TrickleTown's losses took <b>${money(-r.income)}</b> from your allowance`);
    if (r.happy_delta) bits.push(`happiness ${r.happy_delta > 0 ? '▲' : '▼'}${Math.abs(r.happy_delta)}`);
    let out = `Overnight: ${bits.join(', ')}.`;
    if (r.ignored) out += ` You left ${r.ignored} card${r.ignored === 1 ? '' : 's'} unplayed yesterday. They noticed.`;
    return `<p class="v-report">${out}</p>`;
  }

  // One small line icon per town section, so each reads as its own place.
  const T_ICON = {
    vitals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
    hall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-5 9 5"/><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9"/><path d="M3 20h18"/></svg>',
    zone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4h12"/><path d="M6 8l4-4"/><path d="M16 4v5"/><rect x="13.5" y="9" width="5" height="4" rx="1"/><path d="M3 21h8"/></svg>',
    deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="11" height="15" rx="2" transform="rotate(-8 8.5 13.5)"/><rect x="10" y="3" width="11" height="15" rx="2"/></svg>',
    payroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  };
  const tHead = (icon, title, sub = '') => `<h3 class="t-h"><span class="t-ico">${T_ICON[icon]}</span><span class="t-title">${title}</span>${sub ? ` <span class="muted">${sub}</span>` : ''}</h3>`;

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
        ${b ? `<small>${b.total.income ? `${b.total.income > 0 ? '+' : '−'}${money(Math.abs(b.total.income), { whole: true })} profit` : 'no profit'} · ${b.total.happy >= 0 ? '+' : '−'}${Math.abs(b.total.happy)} happiness</small>`
          : `<small>${money(Math.min(...p.options.map((o) => o.cost)), { whole: true })}–${money(Math.max(...p.options.map((o) => o.cost)), { whole: true })} · three choices</small>`}
      </span>
      ${badge}
    </button>`;
  }

  function lockedMarkup() {
    const me = state.me;
    const have = Math.max(0, me.user.total_donated || 0);
    const need = me.town.unlock_at || 1;
    return `
      <div class="side-head"><h2>TrickleTown</h2><span class="muted">Under construction</span></div>
      <section class="locked">
        <p><b>Your lobbyists will live here.</b> Hire your first one and the town opens.</p>
        <div class="lobby-row"><b>${esc(lobbyN(have))} / ${need}</b>${have > 0 ? lobbyists(have) : ''}</div>
        <div class="rank-bar"><i style="--w:${Math.min(100, (have / need) * 100).toFixed(0)}%"></i></div>
        <p class="muted small">Win on a position, or take your first-buy bonus: the tax on it hires lobbyists.</p>
      </section>`;
  }

  // The collection: every card, with what unlocks it. Locked cards that open
  // with days played get a "coming up" line, so the deck reads as a road
  // ahead rather than a wall of question marks.
  function deckComing(deck) {
    const gated = deck.filter((d) => d.status === 'locked').map((d) => {
      const m = /^Unlock: play (\d+) days? \(you: (\d+)\)\.$/.exec(d.needs || '');
      return m ? Number(m[1]) - Number(m[2]) : null;
    }).filter((n) => n != null && n > 0);
    if (!gated.length) return '';
    const soon = Math.min(...gated), k = gated.filter((n) => n === soon).length, rest = gated.length - k;
    const when = soon === 1 ? 'the next day you play' : `after ${soon} more days of play`;
    return `<p class="deck-coming"><b>Coming up:</b> ${k} new card${k === 1 ? '' : 's'} ${k === 1 ? 'unlocks' : 'unlock'} ${when}${rest ? `, and ${rest} more after that just for showing up` : ''}. The rest open with what you build, hire, earn and who you bring.</p>`;
  }
  function deckMarkup(deck) {
    const order = { today: 0, played: 1, available: 2, locked: 3 };
    // Same status: the town's own cards before the headlines, so the first
    // rows show what's particular to you.
    const sorted = [...deck].sort((a, b) => order[a.status] - order[b.status] || (a.general ? 1 : 0) - (b.general ? 1 : 0));
    const counts = deck.reduce((m, d) => { m[d.status] = (m[d.status] || 0) + 1; return m; }, {});
    const heads = deck.filter((d) => d.general), headsSeen = heads.filter((d) => d.seen || d.status === 'played').length;
    const needs = (d) => (d.general ? `Everyone gets one of these ${heads.length} a day.`
      : d.status === 'locked' || d.forced ? d.needs : d.needs.replace(/^Unlock:/, 'Unlocked:'));
    return `
      <p class="muted small"><b>${deck.length - (counts.locked || 0)} of ${deck.length} unlocked.</b> Every day: one of ${heads.length} headlines everyone gets (you've played ${headsSeen}), plus two or more from what your town has unlocked.</p>
      ${deckComing(deck)}
      <div class="deck-grid">${sorted.map((d) => {
        // Anything you've played opens to show the situation and your pick.
        const open = d.seen || d.status === 'played';
        const tag = open ? 'button' : 'div';
        return `
        <${tag} ${open ? `type="button" data-deck-card="${esc(d.id)}" aria-label="${esc(d.title)}: see what you chose"` : ''} class="mini-card ${d.status} ${d.general ? 'general' : ''} ${open ? 'openable' : ''}">
          <span class="mini-status">${{ today: 'In hand', played: 'Played today', available: 'In the pile', locked: 'Locked' }[d.status]}</span>
          <b>${d.status === 'locked' ? '???' : esc(d.title)}</b>
          ${d.consequence ? '<span class="mini-tag">consequences</span>' : d.followup ? '<span class="mini-tag followup">follow-up</span>' : d.general ? '<span class="mini-tag headline">headline</span>' : ''}
          <span class="mini-needs">${esc(needs(d))}</span>
          ${d.forced && d.status !== 'locked' ? '<span class="mini-tag admin">opened by admin</span>' : ''}
          ${open ? `<span class="mini-seen">${d.choice ? `✓ You sided with ${d.choice.side === 'preston' ? 'Preston' : 'Dolores'}` : '✓ Played before'} ›</span>` : ''}
        </${tag}>`;
      }).join('')}</div>`;
  }

  // A card you've played, looked back on: the situation, both pitches, and
  // which one you took (and when). Card text comes from the rules file the
  // page already has; the server only says which side you chose.
  function deckStory(d) {
    const i = ((window.TownRules && window.TownRules.ISSUES) || []).find((x) => x.id === d.id);
    if (!i) return `<button type="button" class="linkish deck-back" data-deck-back>← Back to the deck</button><p class="muted">That card isn't in this version of the deck.</p>`;
    const c = d.choice, when = c ? c.day : d.last;
    const later = c && window.TownRules.laterOf ? window.TownRules.laterOf(i[c.side]) : null;
    const say = (x) => (window.TownRules.catWords ? window.TownRules.catWords(state.me.town.cat, x) : x);
    const pitch = (k) => {
      const w = WHO[k], p = i[k], mine = !!c && c.side === k;
      return `<div class="adv-pitch ${k} story-pitch ${mine ? 'chosen' : c ? 'passed' : ''}">
        <span class="adv-who">${Coin[k](40)}<span><b>${esc(w.name)}</b><small>${esc(w.role)}</small></span>${mine ? '<span class="story-pick">Your pick</span>' : ''}</span>
        <q>${quoted(say(p.line))}</q>
        ${window.TownRules.clues ? clueChips(window.TownRules.clues(p.fx || {})) : ''}
        <span class="adv-label">${mine ? '✓ ' : ''}${esc(say(p.label))}</span>
      </div>`;
    };
    return `
      <button type="button" class="linkish deck-back" data-deck-back>← Back to the deck</button>
      <div class="adv-card story">
        <div class="adv-band ${d.general ? 'headline' : 'village'}">${d.general ? 'Headline' : 'From your village'}${when ? ` · played ${esc(dayLabel(when))}` : ''}</div>
        <h3>${esc(say(i.title))}</h3>
        <p>${esc(say(i.setup))}</p>
        ${i.ask ? `<p><b>${esc(say(i.ask))}</b></p>` : ''}
      </div>
      <p class="story-verdict">${c ? `You went with <b>${c.side === 'preston' ? 'Preston' : 'Dolores'}</b>: ${esc(say(i[c.side].label))}.` : `You played this${when ? ` on ${esc(dayLabel(when))}` : ''}, before the deck kept track of which side you took. Here's what each of them offered.`}</p>
      ${pitch('preston')}${pitch('dolores')}
      ${later ? `<p class="later later-${later}">${{ good: '✨ That choice could pay off later.', bad: '⚠️ That choice could come back to bite.', mixed: '🔮 Something comes of that choice later.' }[later]}</p>` : ''}
      <p class="muted small">The arrows show which way each choice pushes. ${d.status === 'played' ? 'You played it today.' : 'It may come around again.'}</p>`;
  }

  function openDeck() {
    const t = state.me && state.me.town; if (!t) return;
    const body = $('#deck-body'), dlg = $('#dlg-deck');
    const list = () => {
      body.innerHTML = deckMarkup(state.me.town.deck);
      $$('[data-deck-card]', body).forEach((b) => {
        b.onclick = () => {
          const d = state.me.town.deck.find((x) => x.id === b.dataset.deckCard); if (!d) return;
          const y = dlg.querySelector('.sheet-body').scrollTop;
          body.innerHTML = deckStory(d);
          dlg.querySelector('.sheet-body').scrollTop = 0;
          $('[data-deck-back]', body).onclick = () => { list(); dlg.querySelector('.sheet-body').scrollTop = y; };
        };
      });
    };
    list();
    if (!dlg.open) dlg.showModal();
  }
  // One line for the town panel: how many unlocked, what's next.
  function deckLine(deck) {
    const unlocked = deck.filter((d) => d.status !== 'locked').length;
    const soon = deck.filter((d) => d.status === 'locked').map((d) => { const m = /^Unlock: play (\d+) days? \(you: (\d+)\)\.$/.exec(d.needs || ''); return m ? Number(m[1]) - Number(m[2]) : null; }).filter((n) => n != null && n > 0);
    const next = soon.length ? Math.min(...soon) : null;
    return `${unlocked} of ${deck.length} cards unlocked${next ? ` · ${soon.filter((n) => n === next).length} more ${next === 1 ? 'tomorrow' : `in ${next} days`}` : ''}`;
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
    const defaultName = (() => {
      const id = user.charity_id; if (!id) return null;
      const c = state.charities.find((x) => x.id === id);  // a retired default isn't one
      return c ? c.name : null;
    })();
    const r = town.report;
    return `
      <div class="side-head">
        <div><h2>TrickleTown</h2><div class="motto">“${esc(town.motto)}”</div></div>
        <span class="muted">Lobbyfest in <b data-fest="${esc(day.quarter_ends_at)}">${esc(untilLong(day.quarter_ends_at))}</b></span>
      </div>

      <div class="t-stats" aria-label="Town scores">
        <div class="ss"><span>Profit</span><b class="${town.income < 0 ? 'down' : 'up'}">${town.income >= 0 ? '+' : '−'}${money(Math.abs(town.income), { whole: true })}<small>/day</small></b><em class="ss-note">to your allowance</em></div>
        <div class="ss"><span>Happiness</span><b>${town.happiness}</b><span class="ss-bar"><i style="--w:${town.happiness}%"></i></span></div>
        <div class="ss"><span>Lobbyist price</span><b>${money(town.hire_cost)}</b><em class="ss-note">happier is cheaper</em></div>
        <div class="ss"><span>Lobbyists</span><b>${esc(lobbyN(q))}</b><em class="ss-note">this quarter</em></div>
      </div>
      ${r && !r.first_day && (r.income || r.happy_delta || r.ignored) ? `<p class="t-overnight">Overnight: ${[r.income ? `profit ${r.income > 0 ? '+' : '−'}${money(Math.abs(r.income), { whole: true })}` : '', r.happy_delta ? `happiness ${r.happy_delta > 0 ? '▲' : '▼'}${Math.abs(r.happy_delta)}` : '', r.ignored ? `${r.ignored} card${r.ignored === 1 ? '' : 's'} left unplayed` : ''].filter(Boolean).join(' · ')}.</p>` : ''}

      ${town.cat ? `<button type="button" class="t-pet ${town.cat.name ? '' : 'unnamed'}" data-cat-open>
        ${Coin.catPortrait(town.cat, 46)}
        <span><b>${town.cat.name ? esc(town.cat.name) : 'A cat'}</b><small>${town.cat.name ? `Wardrobe worth ${money(town.cat.spent || 0, { whole: true })}. Tap to dress ${catP(town.cat).him}.` : `Waiting for a name. Tap to name ${catP(town.cat).him}.`}</small></span>
        <i aria-hidden="true">›</i>
      </button>` : ''}

      <section class="t-section t-panel t-hall ${pending ? 'waiting' : ''}">
        ${tHead('hall', 'Town Hall')}
        <div class="advisors-cta ${pending ? 'waiting' : ''}">
          <div class="advisors-faces">${Coin.preston(52)}${Coin.dolores(52)}</div>
          <div class="advisors-text">
            <b>${pending ? `${pending} card${pending === 1 ? '' : 's'} to play` : decided ? "Today's cards are played" : 'No cards today'}</b>
            <span class="muted">${pending ? 'Preston wants profit. Dolores wants happiness. Pick a side on each.' : 'More tomorrow, or when you unlock something.'}</span>
          </div>
          <button type="button" class="btn ${pending ? 'primary' : 'quiet'}" id="btn-advisors">${pending ? 'Play the cards' : 'Review'}</button>
        </div>
        <button type="button" class="linkish t-deck-link" id="btn-deck">${deckLine(town.deck)} ›</button>
      </section>

      <section class="t-section t-panel t-zone zone">
        ${tHead('zone', 'Construction zone', `${town.plots.filter((p) => p.building).length} of ${town.plots.length} lots built`)}
        <div class="zone-grid">${town.plots.map(zoneTile).join('')}</div>
      </section>

      <section class="t-section t-panel t-payroll records">
        ${tHead('payroll', 'Payroll', `marches to Lobbyfest on ${esc(festDate(day.quarter_ends_at))}`)}
        ${given.length ? `<ul class="given">${given.map((c, i) => `
          <li><span><span class="sw" style="background:var(--ch${i % 6})"></span>${esc(c.name)}${c.id === user.charity_id && c.active !== false ? ' <em class="default-tag">default</em>' : ''}</span><span>${lobbyists(c.amount, { mini: true, max: 12 })} <b>${esc(lobbyN(c.amount))}</b></span></li>`).join('')}</ul>` : '<p class="muted small">Nobody on the payroll this quarter yet.</p>'}
        <p class="small payroll-default">${defaultName ? `New lobbyists go to <b>${esc(defaultName)}</b>. ` : ''}The charity with the most lobbyists at Lobbyfest gets the biggest share of the real money.</p>
        <div id="payroll-team" hidden></div>
        <button type="button" class="btn primary wide" id="btn-assign">Assign lobbyists</button>
        <div class="rank-row">
          <span><b>${have ? esc(have.name) : 'Unranked'}</b> <span class="muted">${next ? `· ${esc(next.name)} at ${next.at} lobbyists (${lobbyN(Math.max(0, next.at - user.total_donated))} to go)` : '· top rank'}</span></span>
          ${me.achievements ? `<button type="button" class="linkish" id="btn-badge-trophies">🏆 ${me.achievements.earned} of ${me.achievements.total}</button>` : ''}
        </div>
        <div class="rank-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
        <details class="records-more"><summary>Records</summary>
        ${history.length ? `<ul class="history">${history.map((h) => {
          const hired = h.lobbyists != null ? h.lobbyists : h.tax;
          if (h.gift) return `<li>
            <span><span class="tier">🏆 Gift</span> &nbsp;${esc(h.name)} <span class="muted">from Mommy &amp; Daddy, ${money(h.proceeds)}</span></span>
            <span class="to">${hired > 0 ? `${esc(lobby(hired))} for ${esc(h.charity_name || 'your charity')}` : shortDate(h.closed_at)}</span>
          </li>`;
          return `<li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)} <span class="muted">${h.vested ? 'vested, sold per policy' : h.rode ? 'rode on, half tax' : h.collected ? 'collected' : h.proceeds > 0 ? 'sold early' : 'buried'}</span></span>
            <span class="to">${hired > 0 ? `${esc(lobby(hired))} for ${esc(h.charity_name)}` : shortDate(h.closed_at)}</span>
          </li>`;
        }).join('')}</ul>` : `<p class="muted">Nothing collected yet.</p>`}
        </details>
      </section>`;
  }

  // After any village change, redraw the coin, the caption and the panel in place.
  function refreshVillage(town, user) {
    clearTimeout(state.flipTimer);
    state.me.town = town;
    if (user) state.me.user = { ...state.me.user, ...user };
    paintCoin();
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); wireCaption(); }
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
    const adv = $('#btn-advisors'); if (adv) adv.onclick = () => openAdvisors();
    const dk = $('#btn-deck'); if (dk) dk.onclick = openDeck;
    const asg = $('#btn-assign'); if (asg) asg.onclick = () => openAssign();
    paintTeam();
    const bt = $('#btn-badge-trophies'); if (bt) bt.onclick = () => openTrophies();
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
    site.slot = slot; site.result = null; site.i = 0; state.statPrev = null;
    site.mode = mode || (p.building ? 'office' : 'build');
    renderSite();
    const d = $('#dlg-site');
    if (!d.open) d.showModal();
  }

  // "Every day: +$18K profit · −4 happiness". Buildings and
  // upgrades show their real numbers; only the advisors' cards keep arrows.
  function effectChips(e, { perDay = true } = {}) {
    if (!e) return '';
    const items = [];
    const chip = (good, text) => `<span class="clue num ${good ? 'good' : 'bad'}">${text}</span>`;
    if (e.income) items.push(chip(e.income > 0, `${e.income > 0 ? '+' : '−'}${money(Math.abs(e.income), { whole: true })} profit`));
    if (e.happy) items.push(chip(e.happy > 0, `${e.happy > 0 ? '+' : '−'}${Math.abs(e.happy)} happiness`));
    if (!items.length) items.push(`<span class="clue num">no daily effect</span>`);
    return `<span class="clues">${perDay ? '<span class="clue-label">Every day:</span>' : ''}${items.join('')}</span>`;
  }

  const quoted = (line) => esc(String(line || '').replace(/"([^"]*)"/g, '‘$1’'));
  // The price is always in plain sight, top right, whether or not you can
  // afford it; short of cash, the button says how much more you need.
  // Same rule as the server (town.js canPay): within a display step of the
  // price is enough, so "$30K" on the coin always buys a $30K building.
  const affords = (cash, cost) => (window.TownRules && TownRules.canPay ? TownRules.canPay(cash, cost) : cash >= cost);
  const priceTag = (cost, cash) => `<span class="price-tag ${affords(cash, cost) ? '' : 'short'}">${money(cost, { whole: true })}</span>`;
  const buyLabel = (verb, cost, cash) => (affords(cash, cost) ? `${verb} for ${money(cost, { whole: true })}` : `Need ${money(cost - cash)} more`);
  function sitePitch(o, who, cash) {
    const w = WHO[who], short = !affords(cash, o.cost);
    return `<button type="button" class="build-option tier-${o.tier} ${short ? 'short' : ''}" data-build="${esc(o.key)}" ${short ? 'disabled' : ''}>
      <span class="bo-head">
        <span class="bo-name"><span class="tier-badge tier-${o.tier}">${TIER_LABEL[o.tier]}</span><b>${esc(o.name)}</b></span>
        <span class="bo-price ${short ? 'short' : ''}">${money(o.cost, { whole: true })}</span>
      </span>
      ${effectChips(o.effects)}
      ${o.perk ? `<span class="bo-perk">Perk: ${esc(o.perk)}.</span>` : ''}
      <span class="bo-pitch">${Coin[who](30)}<span><b>${esc(w.name.split(' ')[0])}:</b> <q>${quoted(o.pitch.line)}</q></span></span>
      <span class="bo-cta">${esc(buyLabel('Build it', o.cost, cash))}</span>
    </button>`;
  }

  const freshLine = (titles) => (titles && titles.length
    ? `<p class="fresh-card">🃏 <b>New card unlocked:</b> ${titles.map((x) => `“${esc(x)}”`).join(', ')}. ${titles.length === 1 ? "It's" : "They're"} on today's agenda.</p>` : '');

  function renderSite() {
    renderStats('#site-stats');
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
          <p>${rebuilding ? 'Tearing it down takes its upgrades with it. ' : ''}Each building pushes two numbers every day for as long as it stands. <b>Extractive</b> ones add <b>profit</b> to your allowance and make your lobbyists unhappy, so every lobbyist you hire costs more. <b>Decent</b> ones cost you profit and make them happier, so every lobbyist costs less. Every building also unlocks a card of its own.</p>
          ${p.options.some((o) => o.key !== p.key && affords(cash, o.cost)) ? '' : `<p class="site-broke">You have ${money(cash)}. Not enough for any of them yet: collect a win, or come back tomorrow for your allowance.</p>`}
        </div>
        <div class="site-options">
          ${p.options.filter((o) => o.key !== p.key).map((o) => sitePitch(o, o.pitch.who, cash)).join('')}
        </div>
        ${rebuilding ? '<div class="adv-foot"><button type="button" class="linkish" data-site-mode="office">Keep what\'s there</button><span></span></div>' : ''}`;
      wireSite(); return;
    }

    const b = p.building;
    if (site.mode === 'built' && site.built) {
      const r = site.built;
      stage.innerHTML = `
        <div class="adv-card result ${r.who} site-built">
          <div class="adv-band village">${esc(p.label)} · built</div>
          <div class="site-icon">${Coin.buildingIcon(r.key, 180)}</div>
          <div class="adv-result-who">${Coin[r.who](56)}<div><b>${esc(r.name)} is up.</b><span>${r.cost != null ? `${money(r.cost, { whole: true })} from the coin. ` : ''}${esc(r.line)}</span></div></div>
          ${effectChips(r.effects)}
          <p class="muted small">It does this every day from tomorrow on. Upgrades get proposed here as the town grows; the lot tile shows a badge when one's waiting.</p>
          ${freshLine(r.fresh)}
          <div class="adv-actions">${r.fresh && r.fresh.length ? '<button type="button" class="btn quiet" data-site-hall>Play it at Town Hall</button>' : ''}<button type="button" class="btn primary" data-site-close>Back to TrickleTown</button></div>
        </div>`;
      wireSite(); return;
    }
    if (site.mode === 'proposal') {
      const avail = b.upgrades.filter((u) => u.status === 'available');
      if (site.result) {
        const r = site.result;
        stage.innerHTML = `
          <div class="adv-card result ${r.who}">
            <div class="adv-band">${esc(b.name)}</div>
            <div class="adv-result-who">${Coin[r.who](56)}<div><b>${esc(r.name)}: built.</b><span>${money(r.cost, { whole: true })}, from the coin</span></div></div>
            <p>${esc(r.line)}</p>
            ${effectChips(r.effects)}
            <p class="muted small">That's on top of the building, every day from now on.</p>
            ${freshLine(r.fresh)}
            <div class="adv-actions">${r.fresh && r.fresh.length ? '<button type="button" class="btn quiet" data-site-hall>Play it at Town Hall</button>' : ''}<button type="button" class="btn primary" data-site-close>Back to TrickleTown</button><button type="button" class="btn quiet" data-site-mode="office">Back to the office</button></div>
          </div>`;
        wireSite(); return;
      }
      if (!avail.length || site.i >= avail.length) { site.mode = 'office'; renderSite(); return; }
      const u = avail[site.i];
      const who = u.pitch.who, other = who === 'preston' ? 'dolores' : 'preston';
      stage.innerHTML = `
        <div class="adv-card" id="site-card">
          <div class="adv-band village">Upgrade for ${esc(b.name)} · ${site.i + 1} of ${avail.length}</div>
          <span class="adv-tag">${TIER_LABEL[u.tier]}</span>
          <h3>${esc(u.name)} ${priceTag(u.cost, cash)}</h3>
          <p>An add-on to ${esc(b.name)} for ${money(u.cost, { whole: true })}, one time. Buy it and it pushes the numbers below every day on top of what the building already does. Pass and it waits.</p>
          ${effectChips(u.effects)}
          <p class="muted small">${esc(u.unlocked_by || '')}</p>
        </div>
        <div class="adv-pitches">
          <button type="button" class="adv-pitch ${who} ${affords(cash, u.cost) ? '' : 'short'}" data-upgrade="${esc(u.key)}" ${affords(cash, u.cost) ? '' : 'disabled'}>
            <span class="adv-who">${Coin[who](44)}<span><b>${esc(WHO[who].name)}</b><small>proposes</small></span>${priceTag(u.cost, cash)}</span>
            <q>${quoted(u.pitch.line)}</q>
            <span class="adv-label">${esc(buyLabel('Buy it', u.cost, cash))}</span>
          </button>
          <button type="button" class="adv-pitch ${other}" data-pass="1">
            <span class="adv-who">${Coin[other](44)}<span><b>${esc(WHO[other].name)}</b><small>objects</small></span></span>
            <q>${quoted(u.objection)}</q>
            <span class="adv-label">Pass for now</span>
          </button>
        </div>
        <div class="adv-foot"><button type="button" class="linkish" data-site-mode="office">Back to the office</button><span class="muted small">${affords(cash, u.cost) ? '' : `Need ${money(u.cost - cash)} more.`}</span></div>`;
      wireSite(); return;
    }

    // office: the building, what it does, proposals waiting, the rest of the list
    const avail = b.upgrades.filter((u) => u.status === 'available');
    const owned = b.upgrades.filter((u) => u.status === 'owned');
    const locked = b.upgrades.filter((u) => u.status === 'locked');
    const age = p.days === 0 ? 'Built today' : `Built ${p.days} day${p.days === 1 ? '' : 's'} ago`;
    const upRow = (u) => `<li class="up-${u.status}">
          <div class="up-top"><b>${u.status === 'owned' ? '✓ ' : u.status === 'locked' ? '🔒 ' : ''}${esc(u.name)}</b><span class="price-inline">${u.status === 'owned' ? 'owned' : money(u.cost, { whole: true })}</span></div>
          ${effectChips(u.effects, { perDay: false })}
          <span class="up-why">${u.status === 'owned' ? 'Built. Its numbers are in the total above.' : u.status === 'available' ? 'Proposed today. Hear the pitch to buy it.' : esc(u.needs)}</span>
        </li>`;
    stage.innerHTML = `
      <div class="adv-card site-office tier-${b.tier}">
        <div class="adv-band village">${esc(p.label)}</div>
        <span class="tier-badge tier-${b.tier}" style="float:right;margin-top:6px">${TIER_LABEL[b.tier]}</span>
        <h3>${esc(b.name)}</h3>
        <p class="plot-sign">“${esc(b.sign)}”</p>
        <div class="site-icon">${Coin.buildingIcon(b.key, 200)}</div>
        <div class="site-sec">
          <div class="site-k">What it does, every day</div>
          <div class="plot-now">${effectChips(b.total, { perDay: false })}${b.perk ? `<span class="muted small">Perk: ${esc(b.perk)}.</span>` : ''}</div>
          <p class="muted small">${age}. Including any upgrades you own.</p>
        </div>
        <div class="site-sec">
          <div class="site-k">Upgrades</div>
          <p class="muted small">Add-ons for this building, bought once. Their numbers stack on top of the building's.</p>
          <ul class="site-ups">${[...avail, ...locked, ...owned].map(upRow).join('')}</ul>
        </div>
        <div class="adv-actions">
          ${avail.length ? `<button type="button" class="btn primary" data-site-mode="proposal">Hear ${avail.length === 1 ? 'the proposal' : `${avail.length} proposals`}</button>` : ''}
          <button type="button" class="btn ${avail.length ? 'quiet' : 'primary'}" data-site-close>Back to TrickleTown</button>
        </div>
      </div>
      <div class="adv-foot site-foot"><span></span><button type="button" class="linkish danger-link" data-site-mode="build">Tear it down and build something else…</button></div>`;
    wireSite();
  }

  function wireSite() {
    const dlg = $('#dlg-site');
    const p = plotOf(site.slot);
    $$('[data-site-mode]', dlg).forEach((b) => { b.onclick = () => { site.mode = b.dataset.siteMode; site.i = 0; site.result = null; state.statPrev = null; renderSite(); }; });
    $$('[data-pass]', dlg).forEach((b) => { b.onclick = () => { site.i += 1; state.statPrev = null; renderSite(); }; });
    $$('[data-site-close]', dlg).forEach((b) => { b.onclick = () => { state.statPrev = null; dlg.close(); }; });
    $$('[data-site-hall]', dlg).forEach((b) => { b.onclick = () => { state.statPrev = null; dlg.close(); openAdvisors(); }; });
    $$('[data-build]', dlg).forEach((b) => {
      b.onclick = async () => {
        const before = statSnapshot();
        const r = await townPost('/town/build', { slot: site.slot, key: b.dataset.build }, b);
        if (!r) return;
        const nb = r.town.plots.find((x) => x.slot === site.slot).building;
        const opt = plotOf(site.slot).options.find((o) => o.key === b.dataset.build);
        state.statPrev = before;
        refreshVillage(r.town, r.user);
        site.built = {
          key: nb.key, name: nb.name, tier: nb.tier, cost: opt ? opt.cost : null, effects: nb.effects || (opt && opt.effects), who: opt ? opt.pitch.who : (nb.tier === 'good' ? 'dolores' : 'preston'),
          line: nb.tier === 'bad' ? 'Preston is already invoicing.' : nb.tier === 'good' ? 'Dolores almost smiled.' : 'Nobody is thrilled. Nobody is suing.',
          fresh: r.fresh_cards || [],
        };
        site.mode = 'built'; renderSite();
        refreshAchievements();
      };
    });
    $$('[data-upgrade]', dlg).forEach((b) => {
      b.onclick = async () => {
        const u = p.building.upgrades.find((x) => x.key === b.dataset.upgrade);
        const card = $('#site-card');
        const before = statSnapshot();
        const r = await townPost('/town/upgrade', { slot: site.slot, key: b.dataset.upgrade }, b);
        if (!r) return;
        if (card && !REDUCED) { card.classList.add(`fly-${u.pitch.who}`); await new Promise((res) => setTimeout(res, 420)); }
        state.statPrev = before;
        refreshVillage(r.town, r.user);
        site.result = { who: u.pitch.who, name: u.name, cost: u.cost, effects: u.effects, line: reaction(u.pitch.who), fresh: r.fresh_cards || [] };
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
    state.statPrev = null;
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
    const cash = state.me.user.cash, short = !played && p.cost > 0 && !affords(cash, p.cost);
    const tag = p.cost > 0 ? `<span class="price-tag cost ${short ? 'short' : ''}">Costs ${money(p.cost, { whole: true })}</span>` : '<span class="price-tag free">Free</span>';
    return `<button type="button" class="adv-pitch ${who} ${mine ? 'chosen' : ''} ${other ? 'passed' : ''} ${short ? 'short' : ''}" data-pick="${who}" ${played || short ? 'disabled' : ''}>
      <span class="adv-who">${Coin[who](44)}<span><b>${esc(w.name)}</b><small>${esc(w.role)}</small></span>${tag}</span>
      <q>${quoted(p.line)}</q>
      ${clueChips(p.clues)}
      ${p.later ? `<span class="later later-${p.later}">${{ good: '✨ Could pay off later', bad: '⚠️ Could come back to bite', mixed: '🔮 Something comes of this later' }[p.later]}</span>` : ''}
      <span class="adv-label">${mine ? '✓ ' : ''}${esc(p.label)}${short ? `<small class="need">Need ${money(p.cost - cash)} more</small>` : ''}</span>
    </button>`;
  }

  function renderAdvisors() {
    renderStats('#adv-stats');
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
          ${c.id === 'cat' ? catAdoptedMarkup() : ''}
          <div class="adv-actions"><button type="button" class="btn primary" data-adv="next">${adv.i + 1 < n ? 'Next card' : 'Done'}</button></div>
        </div>`;
      wireAdvisors(); return;
    }
    stage.innerHTML = `
      <div class="adv-card ${played ? 'played' : ''}" id="adv-card">
        <div class="adv-band ${c.general ? 'headline' : 'village'}">${c.general ? "Today's headline" : c.followup ? 'It came back around' : 'From your village'} · ${adv.i + 1} of ${n}</div>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.setup)}</p>
        ${c.ask ? `<p class="adv-ask">${esc(c.ask)} <span class="muted">Preston and Dolores each have an answer; pick one.</span></p>` : ''}
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
        else if (a === 'deck') { dlg.close(); openDeck(); }
        else if (a === 'next') { adv.result = null; state.statPrev = null; adv.i += 1; renderAdvisors(); }
        else if (a === 'prev') { adv.result = null; state.statPrev = null; adv.i = Math.max(0, adv.i - 1); renderAdvisors(); }
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
        const before = statSnapshot();
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
        state.statPrev = before;
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

  // --- The cat ----------------------------------------------------------------------------------
  //
  // Arrives on day two. You name her (or him) and pick a coat; she lives in
  // TrickleTown (tap her there, or the row on the town panel), shows on your
  // profile, and has a wardrobe of absurdly priced outfits that do nothing.

  const catP = (cat) => (cat && cat.pronoun === 'he' ? { he: 'he', He: 'He', him: 'him', his: 'his' } : { he: 'she', He: 'She', him: 'her', his: 'her' });
  const CAT_COAT_NAMES = { tabby: 'Orange tabby', black: 'Black', gray: 'Gray', calico: 'Calico', white: 'White' };
  const CAT_SLOT_NAMES = { head: 'Head', eyes: 'Eyes', neck: 'Neck', body: 'Body' };
  const catItems = () => (window.TownRules && window.TownRules.CAT_ITEMS) || [];
  const catWearingText = (cat) => {
    const names = Object.values((cat && cat.wearing) || {}).map((id) => (catItems().find((x) => x.id === id) || {}).name).filter(Boolean);
    return names.length ? `Wearing ${names.join(', ').toLowerCase()}` : 'Wearing nothing. Unbothered.';
  };
  const catState = { mode: 'closet', draft: null };

  function openCat(mode) {
    const cat = state.me && state.me.town && state.me.town.cat;
    if (!cat) return;
    catState.mode = mode || (cat.name ? 'closet' : 'name');
    catState.draft = { name: cat.name || '', pronoun: cat.pronoun || 'she', coat: cat.coat || 'tabby' };
    renderCat();
    const d = $('#dlg-cat');
    if (!d.open) d.showModal();
  }

  function renderCat() {
    const cat = state.me.town.cat; if (!cat) return;
    const body = $('#cat-body');
    if (catState.mode === 'name') {
      const dr = catState.draft, pr = catP(dr);
      $('#cat-title').textContent = cat.name ? `Rename ${cat.name}` : 'Name the cat';
      body.innerHTML = `
        <div class="cat-preview">${Coin.catPortrait({ ...cat, ...dr }, 128)}</div>
        <form id="cat-name-form" class="cat-form" autocomplete="off">
          <label class="field"><span>Name</span><input id="cat-name" type="text" maxlength="20" value="${esc(dr.name)}" placeholder="Comptroller" spellcheck="false"></label>
          <div class="cat-opts" role="radiogroup" aria-label="He or she">
            <button type="button" class="chip ${dr.pronoun === 'she' ? 'on' : ''}" data-pron="she" role="radio" aria-checked="${dr.pronoun === 'she'}">She</button>
            <button type="button" class="chip ${dr.pronoun === 'he' ? 'on' : ''}" data-pron="he" role="radio" aria-checked="${dr.pronoun === 'he'}">He</button>
          </div>
          <div class="cat-coats" role="radiogroup" aria-label="Coat">${Object.keys(CAT_COAT_NAMES).map((k) => `<button type="button" class="cat-coat coat-${k} ${dr.coat === k ? 'on' : ''}" data-coat="${k}" role="radio" aria-checked="${dr.coat === k}" title="${CAT_COAT_NAMES[k]}" aria-label="${CAT_COAT_NAMES[k]}"></button>`).join('')}</div>
          <p class="form-error" id="cat-error" hidden></p>
          <button type="submit" class="btn primary wide" id="cat-save">That's ${pr.his} name</button>
          ${cat.name ? '<button type="button" class="linkish center" data-cat-mode="closet">Never mind</button>' : `<p class="muted small center">${pr.He}'ll show up in TrickleTown and on your profile.</p>`}
        </form>`;
      const keep = () => { catState.draft.name = $('#cat-name').value; };
      $$('[data-pron]', body).forEach((b) => { b.onclick = () => { keep(); catState.draft.pronoun = b.dataset.pron; renderCat(); }; });
      $$('[data-coat]', body).forEach((b) => { b.onclick = () => { keep(); catState.draft.coat = b.dataset.coat; renderCat(); }; });
      const back = $('[data-cat-mode]', body); if (back) back.onclick = () => { catState.mode = 'closet'; renderCat(); };
      $('#cat-name-form').onsubmit = async (e) => {
        e.preventDefault(); keep();
        const err = $('#cat-error'); err.hidden = true;
        const r = await townPost('/town/cat/name', { name: catState.draft.name, pronoun: catState.draft.pronoun, coat: catState.draft.coat }, $('#cat-save'));
        if (!r) return;
        const first = !cat.name;
        refreshVillage(r.town, r.user);
        catState.mode = 'closet'; renderCat();
        toast(first ? `Meet ${r.town.cat.name}. ${catP(r.town.cat).He} has taken the good chair, permanently.` : `${r.town.cat.name} it is.`, 4200);
        if ($('#dlg-advisors').open) renderAdvisors();
      };
      const input = $('#cat-name'); if (!cat.name) setTimeout(() => input.focus(), 60);
      return;
    }
    const pr = catP(cat), cash = state.me.user.cash;
    const items = catItems();
    $('#cat-title').textContent = cat.name;
    body.innerHTML = `
      <div class="cat-head">
        ${Coin.catPortrait(cat, 120)}
        <div>
          <p class="cat-sub">${esc(CAT_COAT_NAMES[cat.coat] || 'Cat')} · ${pr.He === 'She' ? 'she/her' : 'he/him'}${cat.since ? ` · since ${esc(dayLabel(cat.since))}` : ''}</p>
          <p class="cat-worth">Wardrobe worth <b>${money(cat.spent || 0, { whole: true })}</b></p>
          <p class="muted small">${esc(catWearingText(cat))}</p>
          <button type="button" class="linkish" data-cat-mode="name">Rename</button>
        </div>
      </div>
      <p class="muted small cat-fine">Outfits do nothing at all. That is what makes them expensive. You have <b>${money(cash)}</b> on the coin.</p>
      <ul class="cat-shop">${items.map((it) => {
        const owned = cat.owned.includes(it.id), on = cat.wearing[it.slot] === it.id;
        const short = !owned && !affords(cash, it.cost);
        const act = on ? `<button type="button" class="btn quiet small" data-cat-wear="${it.id}" data-on="0">Take off</button>`
          : owned ? `<button type="button" class="btn small" data-cat-wear="${it.id}" data-on="1">Wear</button>`
            : `<button type="button" class="btn primary small" data-cat-buy="${it.id}" ${short ? 'disabled' : ''}>${money(it.cost, { whole: true })}</button>${short ? `<small class="need">Need ${money(it.cost - cash)} more</small>` : ''}`;
        return `<li class="${owned ? 'owned' : ''} ${on ? 'on' : ''}">
          <div class="cat-item"><b>${esc(it.name)}</b> <span class="cat-slot">${CAT_SLOT_NAMES[it.slot]}</span><small>${esc(it.blurb)}</small></div>
          <div class="cat-act">${act}</div>
        </li>`;
      }).join('')}</ul>`;
    $('[data-cat-mode]', body).onclick = () => { catState.mode = 'name'; catState.draft = { name: cat.name, pronoun: cat.pronoun, coat: cat.coat }; renderCat(); };
    $$('[data-cat-buy]', body).forEach((b) => {
      b.onclick = async () => {
        const it = items.find((x) => x.id === b.dataset.catBuy);
        const r = await townPost('/town/cat/buy', { item: it.id }, b);
        if (!r) return;
        refreshVillage(r.town, r.user); renderCat();
        toast(`${cat.name} is wearing the ${it.name.toLowerCase()}. It cost ${money(it.cost, { whole: true })}. The lobbyists noticed.`, 4200);
      };
    });
    $$('[data-cat-wear]', body).forEach((b) => {
      b.onclick = async () => {
        const r = await townPost('/town/cat/wear', { item: b.dataset.catWear, on: b.dataset.on === '1' }, b);
        if (!r) return;
        refreshVillage(r.town, r.user); renderCat();
      };
    });
  }

  // What the result screen says after the cat card.
  function catAdoptedMarkup() {
    const cat = state.me.town && state.me.town.cat; if (!cat) return '';
    const pr = catP(cat);
    return `<div class="adv-cat">${Coin.catPortrait(cat, 64)}<div>${cat.name
      ? `<b>Meet ${esc(cat.name)}.</b><span>Tap ${pr.him} in TrickleTown any time. ${pr.He} has expensive taste.</span>`
      : `<b>The cat is staying.</b><span>${pr.He} needs a name.</span><button type="button" class="btn primary small" data-cat-open>Name the cat</button>`}</div></div>`;
  }

  // --- Assign lobbyists: move this quarter's between charities, set the default ---------------

  const assign = { alloc: new Map(), start: new Map(), pool: 0, def: null, startDef: null, order: [] };

  async function openAssign() {
    clearTimeout(state.flipTimer);
    try { await ensureCharities(); } catch (e) { toast(e.message); return; }
    const me = state.me;
    const now = new Map((me.donations_by_charity || []).filter((c) => c.amount > 0).map((c) => [c.id, round2(c.amount)]));
    assign.alloc = new Map(now); assign.start = new Map(now); assign.pool = 0;
    // A retired default isn't one: no radio is checked until they pick a real charity.
    assign.def = state.charities.some((c) => c.id === me.user.charity_id) ? me.user.charity_id : null; assign.startDef = assign.def;
    // Charities with your lobbyists first (biggest first), then the rest in list order.
    const has = [...now.keys()].sort((a, b) => now.get(b) - now.get(a));
    assign.order = [...has, ...state.charities.map((c) => c.id).filter((id) => !now.has(id))].filter((id) => state.charities.some((c) => c.id === id) || now.has(id));
    renderAssign();
    $('#assign-error').hidden = true;
    $('#dlg-assign').showModal();
  }

  // Built once per opening; every change after that repaints in place
  // (paintAssign), so the list never jumps back to the top. Amounts can be
  // typed (decimals too) or stepped by the "Move by" size.
  const ASSIGN_STEPS = [0.1, 1, 5, 10];
  const assignTotal = () => round2([...assign.start.values()].reduce((x, n) => x + n, 0));
  const assignReal = (id) => state.charities.some((c) => c.id === id);
  const assignName = (id) => (state.charities.find((c) => c.id === id) || (state.me.donations_by_charity || []).find((c) => c.id === id) || { name: 'A retired charity' }).name;
  // A retired charity can lose lobbyists but not gain them.
  const assignCap = (id) => { const cap = round2((assign.alloc.get(id) || 0) + assign.pool); return assignReal(id) ? cap : Math.min(cap, assign.start.get(id) || 0); };

  function renderAssign() {
    const total = assignTotal();
    if (!ASSIGN_STEPS.includes(assign.step)) assign.step = 1;
    $('#assign-body').innerHTML = `
      <p class="assign-lede">${total > 0 ? `This quarter you have <b>${esc(lobby(total))}</b>. Move them wherever you like until Lobbyfest on ${esc(festDate(state.me.day.quarter_ends_at))}; after that they march, and the payroll starts fresh.` : `No lobbyists on the payroll this quarter yet. You can still pick where new ones go.`}</p>
      ${total > 0 ? `
      <div class="assign-bar" aria-hidden="true"></div>
      <div class="assign-pool" aria-live="polite"></div>
      <div class="assign-tools">
        <span class="assign-steps" role="radiogroup" aria-label="Move by">Move by ${ASSIGN_STEPS.map((n) => `<button type="button" class="chip" role="radio" data-step="${n}">${n}</button>`).join('')}</span>
        <button type="button" class="linkish" id="assign-reset">Reset</button>
      </div>` : ''}
      <ul class="assign-list">${assign.order.map((id, i) => `
        <li data-al="${id}" style="--sw: var(--ch${i % 6})">
          <div class="al-name">
            <b><i class="al-sw" aria-hidden="true"></i>${esc(assignName(id))}</b>
            ${assignReal(id) ? `<label class="al-default"><input type="radio" name="al-default" value="${id}"> <span></span></label>` : '<span class="al-default muted">Retired: move these to a real charity</span>'}
          </div>
          ${total > 0 ? `<div class="al-step">
            <button type="button" class="al-btn" data-dec="${id}" aria-label="Fewer for ${esc(assignName(id))}">−</button>
            <input class="al-in" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-in="${id}" aria-label="Lobbyists for ${esc(assignName(id))}">
            <button type="button" class="al-btn" data-inc="${id}" aria-label="More for ${esc(assignName(id))}">+</button>
            <button type="button" class="linkish al-all" data-all="${id}">All here</button>
          </div>` : ''}
        </li>`).join('')}</ul>
      <p class="muted small assign-request"><button type="button" class="linkish" data-request-charity>Don't see your charity? Request one.</button></p>`;
    const body = $('#assign-body');
    const move = (id, d) => { if (!d) return; assign.alloc.set(id, round2((assign.alloc.get(id) || 0) + d)); assign.pool = round2(assign.pool - d); paintAssign(); };
    $$('[data-dec]', body).forEach((b) => { b.onclick = () => { const id = Number(b.dataset.dec); move(id, -round2(Math.min(assign.step, assign.alloc.get(id) || 0))); }; });
    $$('[data-inc]', body).forEach((b) => { b.onclick = () => { const id = Number(b.dataset.inc); move(id, round2(Math.min(assign.step, assignCap(id) - (assign.alloc.get(id) || 0)))); }; });
    $$('[data-all]', body).forEach((b) => {
      b.onclick = () => { const id = Number(b.dataset.all); for (const k of assign.order) assign.alloc.set(k, 0); assign.alloc.set(id, total); assign.pool = 0; paintAssign(); };
    });
    $$('[data-in]', body).forEach((inp) => {
      const id = Number(inp.dataset.in);
      inp.onfocus = () => inp.select();
      inp.oninput = () => {
        const raw = inp.value.trim().replace(',', '.');
        let v = raw === '' || raw === '.' ? 0 : Number(raw);
        if (!Number.isFinite(v) || v < 0) return;           // junk: ignore until it's a number (tidied on blur)
        const cur = assign.alloc.get(id) || 0, cap = assignCap(id);
        if (v > cap + 0.004) { v = cap; inp.value = lobbyN(cap); } // can't place more than are waiting
        v = round2(v);
        assign.alloc.set(id, v); assign.pool = round2(assign.pool + cur - v);
        paintAssign(id);
      };
      inp.onblur = () => paintAssign();
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
    });
    $$('input[name="al-default"]', body).forEach((r) => { r.onchange = () => { assign.def = Number(r.value); paintAssign(); }; });
    $$('[data-step]', body).forEach((b) => { b.onclick = () => { assign.step = Number(b.dataset.step); paintAssign(); }; });
    const reset = $('#assign-reset', body);
    if (reset) reset.onclick = () => { assign.alloc = new Map(assign.start); assign.pool = 0; assign.def = assign.startDef; paintAssign(); };
    paintAssign();
  }

  // Everything that changes as lobbyists move, updated where it stands. `typing`
  // is the input being typed in: its text is left alone until it loses focus.
  function paintAssign(typing = null) {
    const body = $('#assign-body'); if (!body) return;
    const total = assignTotal(), pool = assign.pool, open = pool > 0.004;
    const color = new Map(assign.order.map((id, i) => [id, `var(--ch${i % 6})`]));
    for (const li of $$('[data-al]', body)) {
      const id = Number(li.dataset.al), n = round2(assign.alloc.get(id) || 0), real = assignReal(id);
      li.classList.toggle('has', n > 0); li.classList.toggle('is-default', assign.def === id);
      const inp = $('[data-in]', li); if (inp && id !== typing) inp.value = lobbyN(n);
      const dec = $('[data-dec]', li); if (dec) dec.disabled = n <= 0;
      const inc = $('[data-inc]', li); if (inc) inc.disabled = !open || !real;
      const all = $('[data-all]', li); if (all) all.disabled = !real || n >= total - 0.004;
      const r = $('input[name="al-default"]', li);
      if (r) { r.checked = assign.def === id; r.nextElementSibling.textContent = assign.def === id ? 'New hires go here' : 'Make default'; }
    }
    const bar = $('.assign-bar', body);
    if (bar) {
      bar.innerHTML = assign.order.filter((id) => (assign.alloc.get(id) || 0) > 0)
        .map((id) => `<i style="flex-grow:${assign.alloc.get(id)};background:${color.get(id)}" title="${esc(assignName(id))}: ${esc(lobbyN(assign.alloc.get(id)))}"></i>`).join('')
        + (open ? `<i class="pool" style="flex-grow:${pool}" title="Waiting: ${esc(lobbyN(pool))}"></i>` : '');
    }
    const pl = $('.assign-pool', body);
    if (pl) { pl.classList.toggle('open', open); pl.innerHTML = open ? `<b>${esc(lobby(pool))}</b> waiting for a charity` : 'Every lobbyist has a charity'; }
    $$('[data-step]', body).forEach((b) => { const on = Number(b.dataset.step) === assign.step; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    const changed = assign.def !== assign.startDef || assign.order.some((id) => round2(assign.alloc.get(id) || 0) !== round2(assign.start.get(id) || 0));
    const save = $('#assign-save');
    save.disabled = !changed || open;
    save.textContent = open ? `Place ${lobby(pool)} first` : changed ? 'Save' : 'No changes';
  }

  async function saveAssign() {
    const btn = $('#assign-save');
    if (btn.disabled || state.busy) return;
    const moved = assign.order.some((id) => round2(assign.alloc.get(id) || 0) !== round2(assign.start.get(id) || 0));
    const body = {};
    if (moved) body.allocation = assign.order.filter((id) => (assign.alloc.get(id) || 0) > 0).map((id) => ({ charity_id: id, amount: round2(assign.alloc.get(id)) }));
    if (assign.def !== assign.startDef && assign.def != null) body.default_charity_id = assign.def;
    state.busy = true; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await API.post('/lobbyists/assign', body);
      state.me.donations_by_charity = r.donations_by_charity;
      $('#dlg-assign').close();
      refreshVillage(state.me.town, r.user);
      const defName = body.default_charity_id ? (state.charities.find((c) => c.id === body.default_charity_id) || {}).name : null;
      toast([r.moved > 0 ? `Moved ${lobby(r.moved)}.` : '', defName ? `New lobbyists now go to ${defName}.` : ''].filter(Boolean).join(' ') || 'Saved.', 3600);
    } catch (e) {
      const er = $('#assign-error'); er.textContent = e.message; er.hidden = false;
      btn.disabled = false; btn.textContent = 'Save';
    } finally { state.busy = false; }
  }

  // --- collect / sell sheet ----------------------------------------------------------------

  // The player's default charity: picked once, at the first cash-out, and
  // changed only from TrickleTown → Assign lobbyists.
  function defaultCharity() {
    const id = state.me && state.me.user.charity_id;
    return (id && state.charities.find((c) => c.id === id)) || null;
  }

  // Where new lobbyists go. With a default: one line saying so. Without one
  // (the first cash-out): pick it, which also sets it for every hire after.
  function assignBox({ hired, selectId, conditional = false }) {
    const def = defaultCharity();
    const who = hired > 0 ? esc(lobby(hired)) : 'new lobbyists';
    if (def) {
      return `
      <div class="assign assign-default">
        <div class="assign-head"><b>${conditional ? `If it lands as a profit, the lobbyists go to ${esc(def.name)}` : `Your ${who} go to ${esc(def.name)}`}</b></div>
        <p class="muted small">Your default charity. To move lobbyists or change the default, use <b>Assign lobbyists</b> at the bottom of TrickleTown.</p>
      </div>`;
    }
    return `
      <div class="assign assign-first">
        <div class="assign-head"><b>Next: choose your charity</b></div>
        <p>${conditional ? 'If this lands as a profit, the tax hires lobbyists.' : `The tax hires ${who}.`} Right after this, you'll choose the real charity they lobby for.</p>
      </div>`;
  }
  // A first-cash-out picker must be answered before the button works.
  function requirePick(selectId, buttons) {
    const sel = $(`#${selectId}`);
    if (!sel) return;
    const sync = () => buttons.forEach((b) => { if (b) b.disabled = !sel.value; });
    sync();
    sel.onchange = sync;
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
    const verb = bust ? 'Bury it' : mat ? 'Collect' : 'Sell early';
    const feat = featuredNow(state.events && state.events.list);

    $('#sell-title').textContent = verb;
    $('#sell-body').innerHTML = `
      <div class="receipt-tier ${tierClass}">${esc(s.tier)}.</div>
      ${bust ? ripScene(p.symbol) : ''}
      ${taxed && feat ? `<p class="feat-line">Featured charity this week: ${multStr(feat.multiplier)} for ${esc(feat.charity_name)}.</p>` : ''}
      <ul class="receipt">
        <li><span>You put in${mat ? '' : `, ${ago(p.opened_at)}`}</span><b>${money(p.invested)}</b></li>
        <li><span>${esc(p.name)} moved ${pct(p.real_pct)}, at ${mult(p.multiplier_now)}${mat ? '' : ` (${mult(p.multiplier)} in ${left(p.matures_at)})`}</span><b class="${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</b></li>
        <li><span>${mat ? 'Worth at maturity' : 'Worth right now'}</span><b>${money(p.value)}</b></li>
        ${win ? `<li><span>Tax, ${rate}% of the ${money(s.profit)} gain${deferred > 0 ? '' : `. Hires ${esc(lobby(hired))}`}</span><b>${minus(ownTax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        ${deferred > 0 ? `<li><span>Deferred ride tax, due on an early sale. ${win ? 'Together they hire' : 'Hires'} ${esc(lobby(hired))}</span><b>${minus(deferred)}</b></li>` : ''}
        <li class="total"><span>Back onto the coin</span><b>${money(s.net)}</b></li>
      </ul>
      ${taxed ? `<div class="hire-row">
        <div class="hire-side"><span class="muted">Tax ${minus(s.tax)}</span>${billsRow(s.tax, { max: 12 })}</div>
        <span class="hire-arrow" aria-hidden="true">→</span>
        <div class="hire-side"><span class="muted">${esc(lobby(hired))} at ${money(rateNow)} each</span>${lobbyists(hired, { max: 12 })}</div>
      </div>` : ''}
      ${taxed || (!mat && !bust) ? assignBox({ hired, selectId: 'sell-charity', conditional: !taxed }) : ''}
      ${!mat && !bust ? `<p class="muted small">Or wait: in ${left(p.matures_at)} it matures at ${mult(p.multiplier)}${deferred > 0 ? ` and the deferred ride tax (${minus(deferred)}) is forgiven` : ''}. The sale happens at the market price when you tap.</p>` : ''}
      ${mat && !bust ? `<div class="ride-box">
        <b>Or let it ride.</b>
        <div class="ride-lines">${win
          ? `<p class="small">Pay half the tax now: ${minus(rideTax)}, hires ${esc(lobby(rideHired))}.</p>
             <p class="small">${money(p.value - rideTax)} rides on ${esc(p.name)} for ${state.me.rules.hold_hours} more hours, ${mult(rm.floor)} to ${mult(rm.ceiling)}.${rm.capped ? ' That is the ceiling.' : ''}</p>
             <p class="small">The other ${minus(rideTax)} is due if you sell the ride early, forgiven if it matures. It can still go to zero, faster.</p>`
          : `<p class="small">${money(p.value)} rides on ${esc(p.name)} for ${state.me.rules.hold_hours} more hours, ${mult(rm.floor)} to ${mult(rm.ceiling)}.${rm.capped ? ' That is the ceiling.' : ''}</p>
             <p class="small">No profit, so no tax. It can still go to zero, faster.</p>`}</div>
        <button type="button" class="btn small" id="sell-ride">${win ? `Ride with ${money(p.value - rideTax)}` : 'Let it ride'}</button>
      </div>` : ''}
      ${mat && bust ? `<p class="muted small">Nothing left to ride. Burying it clears the spot.</p>` : ''}`;
    $('#sell-error').hidden = true;
    $('#sell-submit').disabled = false;
    $('#sell-submit').textContent = bust ? 'Bury it' : mat ? `Collect ${money(s.net)}` : `Sell early for about ${money(s.net)}`;
    const rideBtn = $('#sell-ride');
    if (rideBtn) rideBtn.onclick = () => { const sel = $('#sell-charity'); $('#dlg-sell').close(); ride(p.id, sel && sel.value ? Number(sel.value) : undefined); };
    requirePick('sell-charity', [$('#sell-submit'), win ? rideBtn : null]);
    $('#dlg-sell').showModal();
    if (opts.ride && rideBtn) { rideBtn.closest('.ride-box').scrollIntoView({ block: 'center' }); rideBtn.focus(); }
  }

  async function ride(id, charity_id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/ride', { position_id: id, charity_id });
      const ro = r.rolled;
      const hours = state.me.rules.hold_hours;
      const msg = ro.tax > 0
        ? `Riding at ${mult(ro.mult_floor)}→${mult(ro.multiplier)}. Tax ${minus(ro.tax)} (${Math.round(ro.rate * 1000) / 10}% of the ${money(ro.profit)} profit) hired ${lobby(ro.lobbyists)}${ro.charity ? ` for ${ro.charity.name}` : ''}${ro.featured ? ` (featured charity this week: ${multStr(ro.featured.multiplier)})` : ''}; ${money(ro.net)} rides on ${p.name} at ${price(r.quote.price)} for another ${hours} hours. The other ${minus(ro.deferred)} is deferred.`
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
    const charity_id = sel && sel.value ? Number(sel.value) : undefined;
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
          toast(`${rc.tier}. ${how}: tax ${minus(rc.tax)} hired ${lobby(hiredNow)} for ${rc.charity.name}.${rc.featured ? ` Featured charity this week: ${multStr(rc.featured.multiplier)}.` : ''} They're moving into TrickleTown.`, 4200);
          // Watch them arrive, then stay: the switch under the coin goes back.
          flip(true);
          await hireAnimation(hiredNow);
        }
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${how} for ${money(rc.net)}, back on the coin.`);
      }
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // --- Achievements --------------------------------------------------------------------------
  //
  // Rare milestones. Each comes with a gift from Mommy & Daddy, taxed like any
  // win (so it hires lobbyists). The server records them as they're earned;
  // the popup is where the player takes the money.
  // A server from before achievements sends `vesting` instead: { available,
  // amount } until the day-one windfall is taken, then null. Read it as the
  // first achievement so the gift still pops and pays (via /vest).
  function legacyAchievements(me) {
    if (!me || me.achievements) return;
    const v = me.vesting;
    const bought = !!((me.positions && me.positions.length) || (me.history && me.history.length));
    const now = new Date().toISOString();
    const earned = v ? !!v.available : bought, claimed = !v && bought;
    const fb = {
      key: 'first_buy', title: 'Skin in the Game', how: 'Make your first investment.', from: 'Daddy',
      note: "Proud of you, champ. Here's a little something so you never have to touch the principal.",
      gift: Number(v && v.amount) || (me.rules && Number(me.rules.vest_amount)) || 0,
      earned_at: earned ? now : null, claimed_at: claimed ? now : null, lobbyists: null,
      progress: earned ? null : { have: 0, need: 1 },
    };
    me.achievements = { list: [fb], unclaimed: earned && !claimed && fb.gift > 0 ? ['first_buy'] : [], earned: earned ? 1 : 0, total: 1, legacy: true };
  }

  // The page and the server ship separately. If the server is older than this
  // page expects, say so to admins, loudly, instead of letting it look like
  // missing features. Players just get the fallbacks.
  const API_WANTS = 14;
  function checkServer(me) {
    if (API.demo || state.serverWarned || (me.api || 0) >= API_WANTS) return;
    state.serverWarned = true;
    console.warn(`Trickle Down: the server is API v${me.api || '7 or older'}; this page wants v${API_WANTS}. Deploy the latest backend.`);
    if (!me.user || !me.user.is_admin) return;
    const bar = document.createElement('div');
    bar.className = 'stale-server'; bar.setAttribute('role', 'alert');
    bar.innerHTML = `<b>Admin: the server is behind this page.</b> It reports API ${me.api ? `v${esc(String(me.api))}` : 'v7 or older'}; the page needs v${API_WANTS}. Upload the latest backend to the Heroku repo and redeploy. Until then, achievements, lobbyist assignment and newer admin tools fall back or fail. <button type="button" class="linkish">Dismiss</button>`;
    bar.querySelector('button').onclick = () => bar.remove();
    document.body.appendChild(bar);
  }

  const achOf = (me, key) => (me && me.achievements ? me.achievements.list.find((a) => a.key === key) : null);
  const unclaimedKeys = (me) => (me && me.achievements ? me.achievements.unclaimed : []);
  // Before the first buy, the first-investment guide owns the screen.
  const isFirstTime = (me) => { const fb = achOf(me, 'first_buy'); return !!fb && !fb.earned_at; };
  const TROPHY = (cls = '') => `<svg class="trophy ${cls}" viewBox="0 0 64 64" aria-hidden="true"><path class="t-cup" d="M18 8h28v14a14 14 0 0 1-28 0V8z"/><path class="t-handle" d="M18 13H9v3a9 9 0 0 0 9 9M46 13h9v3a9 9 0 0 1-9 9"/><path class="t-stem" d="M28 35h8v9h-8z"/><path class="t-base" d="M20 44h24v8H20z"/><path class="t-shine" d="M24 12v9"/></svg>`;

  function renderTrophyCount() {
    const a = state.me && state.me.achievements;
    const btn = $('#btn-trophies');
    if (!btn || !a) return;
    $('#trophy-count').textContent = `${a.earned}/${a.total}`;
    btn.classList.toggle('waiting', a.unclaimed.length > 0);
    btn.setAttribute('aria-label', `Achievements: ${a.earned} of ${a.total}${a.unclaimed.length ? `, ${a.unclaimed.length} gift waiting` : ''}`);
  }

  // Announce the first unclaimed achievement, once per page load per
  // achievement, when nothing else is on screen. Gently: a small card rises
  // from the bottom with no backdrop, and the player opens it when ready. If
  // they wave it off, the to-do strip and the trophy button keep it.
  function maybeAchievement(delay = 0) {
    setTimeout(() => {
      const key = unclaimedKeys(state.me).find((k) => !state.achShown.has(k));
      if (!key || $('dialog[open]') || Explainer.isOpen() || state.tab === 'welcome') return;
      peekAchievement(key);
    }, delay);
  }

  function peekAchievement(key) {
    const a = achOf(state.me, key);
    if (!a || !a.earned_at || a.claimed_at) return;
    state.achShown.add(key);
    hidePeek(true);
    const el = document.createElement('div');
    el.className = 'ach-peek';
    el.setAttribute('role', 'status');
    el.innerHTML = `${TROPHY('ach-peek-trophy')}
      <div class="ach-peek-text"><span>Achievement unlocked</span><b>${esc(a.title)}</b><small>${esc(a.from)} sent a little something.</small></div>
      <button type="button" class="btn small ach-peek-open">Open</button>
      <button type="button" class="ach-peek-x" aria-label="Later">×</button>`;
    el.querySelector('.ach-peek-open').onclick = () => openAchievement(key);
    el.querySelector('.ach-peek-x').onclick = () => hidePeek();
    document.body.appendChild(el);
    const root = document.documentElement;
    root.style.setProperty('--peek-h', `${el.offsetHeight}px`);
    root.classList.add('has-peek');
    // Two frames so the starting position paints before it rises.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }

  function hidePeek(now = false) {
    const el = $('.ach-peek');
    document.documentElement.classList.remove('has-peek');
    if (!el) return;
    if (now || REDUCED) { el.remove(); return; }
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 360);
  }

  // A sheet that eases away instead of vanishing (pairs with .sheet.soft).
  function softClose(dlg) {
    if (!dlg || !dlg.open) return Promise.resolve();
    if (REDUCED) { dlg.close(); return Promise.resolve(); }
    dlg.classList.add('closing');
    return new Promise((res) => setTimeout(() => { dlg.classList.remove('closing'); dlg.close(); res(); }, 240));
  }

  // After something that might have earned one without reloading /me (a
  // building, a friend), ask the server and pop it if so.
  async function refreshAchievements(delay = 600) {
    if (!state.me || state.me.achievements.legacy) return;
    try { state.me.achievements = await API.get('/achievements'); } catch (e) { return; }
    renderTrophyCount();
    maybeAchievement(delay);
  }

  function announceCards(titles) {
    if (!titles || !titles.length) return;
    toast(titles.length === 1 ? `New card unlocked: “${titles[0]}”. It's on today's agenda at Town Hall.` : `${titles.length} new cards unlocked and dealt for today: ${titles.map((x) => `“${x}”`).join(', ')}.`, 4800);
  }

  // --- the welcome-back performance review ------------------------------------------------
  //
  // Positions that matured while you were away get a replay: every position's
  // value from its buy to its 24-hour mark, swept on one clock, live ones
  // riding along until the last maturity. Shown once per position (this
  // browser remembers which), then the rest of the welcome: the coin lands,
  // gifts and peeks get their turn.

  const REVIEWED_KEY = 'trickledown.reviewed';
  const reviewedMem = new Set();
  function reviewedSet() {
    try { (JSON.parse(localStorage.getItem(REVIEWED_KEY) || '[]') || []).forEach((id) => reviewedMem.add(Number(id))); } catch (e) { /* memory only */ }
    return reviewedMem;
  }
  function markReviewed(ids) {
    const seen = reviewedSet();
    ids.forEach((id) => seen.add(id));
    try { localStorage.setItem(REVIEWED_KEY, JSON.stringify([...seen].slice(-300))); } catch (e) { /* memory only */ }
  }
  const unseenMatured = (me) => { const seen = reviewedSet(); return me.positions.filter((p) => p.matured && !seen.has(p.id)).map((p) => p.id); };

  // True when the review is on its way (the caller holds the rest back).
  function maybeReview(me) {
    if (!me || state.reviewing || !Explainer.seen('main') || Explainer.isOpen() || $('dialog[open]')) return false;
    if (['admin', 'welcome'].includes(state.tab)) return false;
    const ids = unseenMatured(me);
    if (!ids.length) return false;
    state.reviewing = true;
    openReview(ids.slice(-40));
    return true;
  }

  function afterReviewCloses() {
    state.reviewing = false;
    if (state.reviewChart) { state.reviewChart.destroy(); state.reviewChart = null; }
    const queued = [...state.afterReview.values()];
    state.afterReview.clear();
    queued.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  async function openReview(ids) {
    markReviewed(ids); // once, even if it's closed straight away
    let data = null;
    try { data = await API.get(`/positions/review?ids=${ids.join(',')}`); } catch (e) { /* skip it */ }
    if (!data || !data.positions || !data.positions.length || !data.end || $('dialog[open]') || !state.me) { afterReviewCloses(); return; }
    renderReview(data);
  }

  const clockAt = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function reviewVerdict(matured) {
    const inv = matured.reduce((a, p) => a + p.invested, 0), out = matured.reduce((a, p) => a + p.final_value, 0);
    const ch = inv > 0 ? (out - inv) / inv : 0;
    const busted = matured.filter((p) => p.final_value <= 0).length;
    let quip;
    if (ch >= 0.25) quip = 'The board is thrilled and has voted itself a bonus.';
    else if (ch >= 0.02) quip = 'Up. Analysts are calling it “genius,” as they do with anything that went up.';
    else if (ch > -0.02) quip = 'Basically flat. A day of tremendous, historic stability.';
    else if (ch > -0.25) quip = 'Down a bit. The shareholder letter will call it “a learning experience.”';
    else quip = 'Down a lot. Comms is drafting the words “strategic repositioning.”';
    if (busted) quip += ` ${busted === 1 ? 'One' : busted} went to zero, which we're describing as “fully realized.”`;
    const n = matured.length;
    return `<p class="rv-verdict"><b>${n} matured:</b> ${money(inv)} in, <b>${money(out)}</b> out <span class="rv-pct ${dir(ch)}">${pct(ch)}</span>. ${esc(quip)}</p>`;
  }

  // --- "While you were out": one list, two places (3.2, 3.3) ---------------------------------
  //
  // The first load of a day gathers what happened overnight. With positions
  // to replay, it closes the performance review; otherwise it's its own small
  // sheet (the digest), shown instead of the allowance toast and only when
  // there's more to say than the allowance. `news` marks the lines that earn
  // the digest a showing.
  function outLines(me, { review = null } = {}) {
    const L = [];
    const add = (icon, html, news = true) => L.push({ icon, html, news });
    const a = me.allowance;
    // The streak broke: someone was gone a while.
    if (a && a.streak === 1 && (me.user.account_day || 0) > 1) add('👋', 'Welcome back. Preston kept the lights on. Dolores kept the receipts.');
    if (a) add('💵', `<b>${money(a.amount, { whole: true })}</b> landed on the coin${me.user.streak > 1 ? `, day ${me.user.streak} of your streak` : ''}.`, false);
    if (review) {
      const ready = review.filter((p) => p.final_value > 0).length;
      if (ready) add('🪙', `${ready === 1 ? 'It’s' : `All ${ready} are`} waiting on the coin to be collected.`, false);
    } else {
      const since = me.user.last_seen_at ? new Date(me.user.last_seen_at).getTime() : 0;
      const fresh = (me.positions || []).filter((p) => p.matured && p.matured_at && new Date(p.matured_at).getTime() > since);
      fresh.slice(0, 3).forEach((p) => add('📈', p.busted || !(p.value > 0) ? `<b>${esc(p.symbol)}</b> matured at zero. There's nothing to wait for.` : `<b>${esc(p.symbol)}</b> matured at ${pct(p.swing_pct, 0)}. It's waiting.`));
      if (fresh.length > 3) add('📈', `${fresh.length - 3} more matured. They're waiting too.`);
    }
    const ti = a ? a.town_income || 0 : 0;
    if (ti > 0) add('🏘️', `TrickleTown kicked in <b>${money(ti, { whole: true })}</b>.`);
    else if (ti < 0) add('🏘️', `TrickleTown's upkeep took <b>${money(-ti, { whole: true })}</b>.`);
    const expired = a && me.town ? me.town.expired_yesterday || 0 : 0;
    if (expired) add('🗑️', `${expired} card${expired === 1 ? '' : 's'} expired. The residents noticed.`);
    const yesterday = isoAdd(me.day.key, -1);
    const hiredY = a ? round2((me.history || []).filter((h) => h.closed_day === yesterday).reduce((sum, h) => sum + (h.lobbyists || 0), 0)) : 0;
    if (hiredY > 0) add('💼', `You hired <b>${esc(lobby(hiredY))}</b> yesterday. They've found the coffee.`);
    if (me.wall_unread) add('💬', `${wallWho(me)} on your wall.`);
    const nf = me.new_followers || [];
    if (nf.length) add('👋', `<b>${esc(nf[0].username)}</b>${nf.length > 1 ? ` and ${nf.length - 1} other${nf.length > 2 ? 's' : ''}` : ''} added you.`);
    // Today's business: on the list, but not a reason to stop someone.
    const town = me.town, cards = pendingIssues();
    const freshCards = me.fresh_cards || [];
    if (town && town.unlocked && (cards || freshCards.length)) {
      const news = freshCards.length ? `${freshCards.length === 1 ? 'a new one' : `${freshCards.length} new ones`}: ${freshCards.map((x) => `“${esc(x)}”`).join(', ')}` : '';
      add('🃏', cards ? `<b>${cards} card${cards === 1 ? '' : 's'}</b> on today's agenda at Town Hall${news ? `, including ${news}` : ''}.` : `New card${freshCards.length === 1 ? '' : 's'} unlocked: ${news.replace(/^[^:]*: /, '')}.`, false);
    }
    const gifts = unclaimedKeys(me).length;
    if (gifts) add('🏆', `${gifts === 1 ? 'A gift is' : `${gifts} gifts are`} waiting from Mommy &amp; Daddy.`, false);
    return L;
  }
  const outList = (lines) => `<ul class="out-list">${lines.map((l) => `<li><span class="out-ico" aria-hidden="true">${l.icon}</span><span>${l.html}</span></li>`).join('')}</ul>`;

  function reviewAlso(me, matured) {
    const lines = outLines(me, { review: matured });
    return lines.length ? `<div class="rv-also"><b>Also while you were out</b>${outList(lines)}</div>` : '';
  }

  // True when the digest opened (the caller holds the rest of the welcome back).
  function maybeDigest(me) {
    if (!me || !me.allowance || state.reviewing || !Explainer.seen('main') || Explainer.isOpen() || $('dialog[open]')) return false;
    if (['admin', 'welcome'].includes(state.tab)) return false;
    const lines = outLines(me);
    if (!lines.some((l) => l.news)) return false;
    state.reviewing = true;
    $('#digest-body').innerHTML = outList(lines);
    $('#digest-go').onclick = () => softClose($('#dlg-digest'));
    $('#dlg-digest').showModal();
    return true;
  }

  function renderReview(data) {
    const me = state.me;
    const dlg = $('#dlg-review');
    const ms = (d) => new Date(d).getTime();
    const matured = data.positions.filter((p) => p.matured).sort((a, b) => ms(a.opened_at) - ms(b.opened_at));
    const live = data.positions.filter((p) => !p.matured).sort((a, b) => ms(a.opened_at) - ms(b.opened_at));
    // Eight colours in a fixed order: every matured position first (they're
    // the point), then the biggest live ones. Past eight, the rest are thin
    // grey lines without labels; each still has its own row below.
    const MAXC = 8;
    let list = [...matured, ...live];
    if (list.length > MAXC) {
      const byValue = (a, b) => b.final_value - a.final_value;
      const keep = new Set([...[...matured].sort(byValue), ...[...live].sort(byValue)].slice(0, MAXC).map((p) => p.id));
      list = [...list.filter((p) => keep.has(p.id)), ...list.filter((p) => !keep.has(p.id))];
    }
    const colorOf = (p, i) => (i >= MAXC ? 'var(--s-other)' : `var(--s${i + 1})`);

    const rows = list.map((p, i) => {
      const ch = p.invested > 0 ? (p.final_value - p.invested) / p.invested : 0;
      const pos = me.positions.find((x) => x.id === p.id);
      const status = p.matured ? (p.final_value > 0 ? 'Matured · ready to collect' : 'Matured · gone') : `Still riding · ${pos ? `matures in ${left(pos.matures_at)}` : 'live'}`;
      return `<li class="rv-row" data-rv-row="${i}" style="--c:${colorOf(p, i)}">
        <i class="rv-key" aria-hidden="true"></i>
        <span class="rv-sym"><b>${esc(p.symbol)}</b><small>${esc(p.name || '')}</small></span>
        <span class="rv-val"><small>${money(p.invested)} →</small> <b class="rv-now">${money(p.invested)}</b></span>
        <span class="rv-state">${esc(status)}</span>
        <span class="rv-pct rv-final ${dir(ch)}">${pct(ch)}</span>
      </li>`;
    }).join('');

    $('#review-body').innerHTML = `
      <p class="rv-sub">${esc(clockAt(data.start))} to ${esc(clockAt(data.end))}, replayed at a more convenient speed.</p>
      <div class="rv-card">
        <div class="rv-readout"><span class="rv-clock" aria-hidden="true">${esc(clockAt(data.start))}</span><span class="rv-total"><small>Total</small> <b>${money(0)}</b></span></div>
        <div class="rv-chart" id="rv-chart"></div>
        <div class="rv-ctl"><button type="button" class="linkish" data-rv="skip">Skip to the end</button><button type="button" class="linkish" data-rv="replay" hidden>↺ Replay</button></div>
      </div>
      <ul class="rv-rows">${rows}</ul>
      <div class="rv-after">
        ${reviewVerdict(matured)}
        ${reviewAlso(me, matured)}
      </div>
      <div class="rv-actions">
        ${me.town && me.town.unlocked && pendingIssues() ? `<button type="button" class="btn quiet" data-rv="hall">Town Hall</button>` : ''}
        <button type="button" class="btn primary" data-rv="done">Back to the coin</button>
      </div>`;

    dlg.classList.remove('landed');
    if (!dlg.open) dlg.showModal();
    $('.sheet-body', dlg).scrollTop = 0;

    const rowEls = $$('[data-rv-row]', dlg).map((r) => $('.rv-now', r));
    const clock = $('.rv-clock', dlg), total = $('.rv-total b', dlg);
    const chart = Review.chart($('#rv-chart'), {
      start: data.start,
      end: data.end,
      series: list.map((p, i) => ({ label: p.symbol, color: colorOf(p, i), points: p.points, ended: p.matured, quiet: i >= MAXC })),
    }, {
      money: (v) => money(v),
      reduced: REDUCED,
      label: `${list.length} positions from ${clockAt(data.start)} to ${clockAt(data.end)}. The list below has each one's numbers.`,
      onTick: (t, values) => {
        clock.textContent = clockAt(t);
        total.textContent = money(values.reduce((a, v) => a + (v || 0), 0));
        values.forEach((v, i) => { if (rowEls[i]) rowEls[i].textContent = v == null ? '—' : money(v); });
      },
      onDone: () => {
        dlg.classList.add('landed');
        $('[data-rv="skip"]', dlg).hidden = true;
        $('[data-rv="replay"]', dlg).hidden = false;
      },
    });
    state.reviewChart = chart;
    $('[data-rv="skip"]', dlg).onclick = () => chart.finish();
    $('[data-rv="replay"]', dlg).onclick = () => { $('[data-rv="replay"]', dlg).hidden = true; $('[data-rv="skip"]', dlg).hidden = false; chart.play(); };
    $('[data-rv="done"]', dlg).onclick = () => softClose(dlg);
    const hall = $('[data-rv="hall"]', dlg);
    if (hall) hall.onclick = async () => { await softClose(dlg); flip(true); if (Explainer.seen('town')) setTimeout(() => openAdvisors(), REDUCED ? 50 : 700); };
    // Let the sheet slide up before the clock starts.
    setTimeout(() => { if (dlg.open && state.reviewChart === chart) chart.play(); }, REDUCED ? 0 : 380);
  }

  async function openAchievement(key) {
    const a = achOf(state.me, key);
    hidePeek();
    if (!a || !a.earned_at || a.claimed_at || $('#dlg-ach').open) return;
    state.achShown.add(key);
    try { await ensureCharities(); } catch (e) { /* the picker comes up empty; the server picks */ }
    const rate = state.me.rules.tax_rate, rateNow = state.me.town ? state.me.town.hire_cost : 1;
    const tax = round2(a.gift * rate), net = round2(a.gift - tax), hired = round2(tax / rateNow);
    const n = state.me.achievements.earned;
    $('#ach-body').innerHTML = `
      <div class="ach-burst">
        <div class="ach-rays" aria-hidden="true"></div>
        <div class="ach-confetti" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.18}s;--r:${(i * 53) % 360}deg"></i>`).join('')}</div>
        ${TROPHY('ach-trophy')}
        <div class="ach-eyebrow">Achievement unlocked</div>
        <h2 class="ach-title">${esc(a.title)}</h2>
        <div class="ach-how">${esc(a.how)}</div>
        <div class="ach-count">${n} of ${state.me.achievements.total}</div>
      </div>
      <div class="ach-note">
        <div class="ach-note-head"><span>A little something from Mommy &amp; Daddy</span><b>${money(a.gift, { whole: true })}</b></div>
        <p>“${esc(a.note)}”</p>
        <span class="ach-sign">— ${esc(a.from)}</span>
      </div>
      <ul class="receipt ach-receipt">
        <li><span>The gift. A bonus, pure profit.</span><b class="up">+${money(a.gift)}</b></li>
        <li><span>Tax, ${Math.round(rate * 100)}% of the gain (all of it is gain). Hires ${esc(lobby(hired))}</span><b>${minus(tax)}</b></li>
        <li class="total"><span>Onto your coin as bills</span><b>${money(net)}</b></li>
      </ul>
      ${assignBox({ hired, selectId: 'ach-charity' })}
      <button type="button" class="btn primary wide ach-take" id="ach-claim">Thanks, ${esc(a.from)}</button>
      <p class="muted small ach-fine">Achievements are rare. Each one comes with a gift. Nothing about this is normal; everything about it is legal.</p>`;
    $('#dlg-ach').showModal();
    $('#ach-claim').onclick = () => claimAchievement(key);
    requirePick('ach-charity', [$('#ach-claim')]);
  }

  async function claimAchievement(key) {
    if (state.busy) return;
    state.busy = true;
    const btn = $('#ach-claim'); btn.disabled = true; btn.textContent = 'Depositing…';
    try {
      const sel = $('#ach-charity');
      const charity_id = sel && sel.value ? Number(sel.value) : undefined;
      // An older server only knows the day-one gift, as "/vest".
      const r = state.me.achievements.legacy ? await API.post('/vest', { charity_id }) : await API.post('/achievements/claim', { key, charity_id });
      // Refresh behind the sheet, then move on without flashing the page.
      await loadMe();
      const rc = r.receipt;
      if (rc && !rc.gift) { const a = achOf(state.me, key) || {}; Object.assign(rc, { gift: true, vested: false, name: a.title, tier: 'Gift', achievement: { key, title: a.title, from: a.from } }); }
      const hiredNow = rc.lobbyists || 0;
      const t = state.me.town;
      if (hiredNow > 0 && t && t.unlocked && !Explainer.seen('town')) {
        // Straight from one sheet to the next: the backdrop stays put.
        $('#dlg-ach').close();
        openHireCeremony(rc, hiredNow, 'Gift', { swap: true });
      } else {
        await softClose($('#dlg-ach'));
        if (hiredNow > 0 && state.me.needs_charity) {
          // New lobbyists and no charity yet: the choice comes next, not later.
          toast(`${money(rc.net)} onto the coin, and ${lobby(hiredNow)} hired.`, 3200);
          setTimeout(() => openCharityChooser(), REDUCED ? 100 : 700);
        } else {
          toast(`${money(rc.net)} onto the coin.${hiredNow > 0 && rc.charity ? ` Tax ${minus(rc.tax)} hired ${lobby(hiredNow)} for ${rc.charity.name}.` : ''}`, 4200);
          maybeAchievement(REDUCED ? 300 : 1400); // another one waiting?
        }
      }
    } catch (e) {
      toast(e.message, 4000); btn.disabled = false; btn.textContent = 'Try again';
    } finally { state.busy = false; }
  }

  async function openTrophies() {
    const me = state.me; if (!me || !me.achievements) return;
    const A = me.achievements;
    const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const row = (a) => {
      const status = a.claimed_at ? 'claimed' : a.earned_at ? 'waiting' : 'locked';
      const pr = a.progress && a.progress.need > 1 ? a.progress : null;
      return `<li class="tro ${status}">
        ${TROPHY(status === 'locked' ? 'dim' : '')}
        <div class="tro-main">
          <b>${esc(a.title)}</b>
          <span class="tro-how">${esc(a.how)}</span>
          ${status === 'claimed' ? `<span class="tro-meta">Earned ${date(a.earned_at)} · ${money(a.gift, { whole: true })} from ${esc(a.from)}${a.lobbyists ? ` · hired ${esc(lobby(a.lobbyists))}` : ''}</span>`
            : status === 'waiting' ? `<button type="button" class="btn small primary" data-open-gift="${esc(a.key)}">Open ${esc(a.from)}'s gift: ${money(a.gift, { whole: true })}</button>`
            : `<span class="tro-meta">Gift at today's money: ${money(a.gift, { whole: true })} from ${esc(a.from)}</span>${pr ? `<span class="tro-prog"><i style="--w:${Math.round((pr.have / pr.need) * 100)}%"></i></span><span class="tro-meta">${pr.money ? `${money(pr.have)} of ${money(pr.need)}` : `${pr.have} of ${pr.need}`}</span>` : ''}`}
        </div>
      </li>`;
    };
    const order = [...A.list].sort((x, y) => (x.claimed_at ? 1 : x.earned_at ? 0 : 2) - (y.claimed_at ? 1 : y.earned_at ? 0 : 2));
    $('#trophies-body').innerHTML = `
      <p class="tro-lede"><b>${A.earned} of ${A.total}.</b> Rare on purpose. Each one comes with a gift from Mommy &amp; Daddy, all gain, so it's taxed and hires lobbyists. Past the first few, the gift grows with the money you have in play. The richer you are, the more they send. Naturally.</p>
      <ul class="tro-list">${order.map(row).join('')}</ul>`;
    $$('[data-open-gift]', $('#trophies-body')).forEach((b) => { b.onclick = () => { $('#dlg-trophies').close(); openAchievement(b.dataset.openGift); }; });
    $('#dlg-trophies').showModal();
  }

  // The first lobbyist: the tax walks across the desk and comes out a person,
  // the player reads what just happened, and chooses to flip the coin. The
  // TrickleTown tour opens after the flip, not before.
  function openHireCeremony(rc, hiredNow, how, { swap = false } = {}) {
    const count = Math.min(10, Math.max(1, Math.ceil(hiredNow - 1e-9)));
    // The part after the decimal point gets a job title.
    const shown = round2(hiredNow), part = round2(shown - Math.floor(shown));
    const intern = part > 0 && part < 1 ? ` The ${esc(lobbyN(part))} is an intern.` : '';
    const dlg = $('#dlg-hire');
    const choose = !!(state.me && state.me.needs_charity && state.charities.length);
    dlg.classList.toggle('swap', swap);
    $('#hire-title').textContent = hiredNow >= 2 ? 'Your first lobbyists' : 'Your first lobbyist';
    $('#hire-body').innerHTML = `
      <div class="receipt-tier win">${esc(rc.tier)}.</div>
      <p>${rc.gift ? `${esc(rc.achievement ? rc.achievement.from : 'Daddy')}'s gift for <b>${esc(rc.name)}</b>: ${money(rc.profit)} of pure profit` : rc.vested ? `Your Trickle Down Holdings shares sold for ${money(rc.profit)} of pure profit` : `${how} ${esc(rc.symbol)}: ${money(rc.profit)} of profit`}, tax ${minus(rc.tax)}. Not to the government. To your recruiter.</p>
      <div class="hire-scene" aria-hidden="true">
        <div class="hire-from">${billsRow(Math.max(1, rc.tax), { max: count })}</div>
        <div class="hire-desk"><b>RECRUITER</b><span>${money(rc.hire_cost || 1)} a head</span></div>
        <div class="hire-to">${lobbyists(hiredNow, { max: count })}</div>
      </div>
      ${choose ? `
      <p class="hire-line"><b>${esc(lobby(hiredNow))}</b> hired.${intern} They've moved into <b>TrickleTown</b>, the company town on the other side of your coin. But first, they need a cause.</p>
      <section class="ch-pick">
        <h3>Who do they lobby for?</h3>
        ${charityExplain()}
        ${charityCards()}
        <button type="button" class="linkish ch-request" data-request-charity>Don't see yours? Request a charity</button>
      </section>
      <div class="ch-go"><button type="button" class="btn primary wide" id="hire-flip" disabled>Choose a charity above</button>
      <button type="button" class="linkish center" id="hire-later">Decide later</button></div>` : `
      <p class="hire-line"><b>${esc(lobby(hiredNow))}</b> hired for <b>${esc(rc.charity.name)}</b>.${intern} They've moved into <b>TrickleTown</b>, the company town on the other side of your coin. You own it. They'd like a word.</p>
      <button type="button" class="btn primary wide" id="hire-flip">Meet them in TrickleTown</button>
      <button type="button" class="linkish center" id="hire-later">Later</button>`}`;
    dlg.showModal();
    let picked = null;
    if (choose) {
      wireCharityCards($('#hire-body'), (c) => { picked = c; const b = $('#hire-flip'); b.disabled = false; b.textContent = `Lobby for ${c.name}`; });
      wireRequestLinks($('#hire-body'));
    }
    const targets = $$('#hire-body .hire-to .lobbyist');
    targets.forEach((t) => t.classList.add('arriving'));
    setTimeout(() => deskAnimation(targets), REDUCED ? 0 : 650); // after the sheet settles: the flight is measured from it
    $('#hire-later').onclick = () => { softClose(dlg).then(renderUnder); };
    $('#hire-flip').onclick = async () => {
      if (choose) {
        if (!picked) return;
        const b = $('#hire-flip'); b.disabled = true; b.textContent = 'Signing them up…';
        try { await chooseCharity(picked.id); } catch (e) { toast(e.message, 4000); b.disabled = false; b.textContent = `Lobby for ${picked.name}`; return; }
      }
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

  // --- share ------------------------------------------------------------------------------------
  //
  // The day as a text card for a group chat: one line on how it went, what
  // you cashed out or let ride (% and $), what you bought today, and the
  // link. Trading only: no achievements, no gifts. Previewed in a sheet
  // before it goes anywhere.

  const SITE_LINK = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/\/+$/, '');
  const inviteLink = (name) => `${SITE_LINK}/#u/${encodeURIComponent(name)}?from=${encodeURIComponent(name)}`;

  // Your charity's place this quarter, from /trickle (kept for a minute).
  const ordinal = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
  function standingFrom(t, charityId) {
    const list = (t && t.charities) || [];
    const i = list.findIndex((c) => c.id === charityId);
    if (i < 0) return null;
    return { c: list[i], rank: list[i].rank || i + 1, of: list.length, gap: list[i].gap_to_next || 0, ahead: i > 0 ? list[i - 1] : null };
  }
  async function teamStanding() {
    if (!state.me) return null;
    if (!state.trickle || Date.now() - state.trickle.at > 60e3) {
      try { state.trickle = { at: Date.now(), t: await API.get('/trickle') }; } catch (e) { return state.trickle ? standingFrom(state.trickle.t, state.me.user.charity_id) : null; }
    }
    return standingFrom(state.trickle.t, state.me.user.charity_id);
  }
  // "Your team: Doctors Without Borders, 4th of 18, 7 lobbyists behind Crisis Text Line."
  const teamLine = (s) => `Your team: <b>${esc(s.c.name)}</b>, ${ordinal(s.rank)} of ${s.of}${s.rank === 1 ? ', in the lead' : s.gap > 0 ? `, ${esc(lobby(s.gap))} behind ${esc(s.ahead.name)}` : `, tied with ${esc(s.ahead.name)}`}.`;
  const teamMarkup = (s) => (s ? `<div class="team-line"><p>${teamLine(s)}</p><button type="button" class="btn small quiet" data-share>Recruit</button></div>` : '');
  // The Payroll box: drawn from the cache right away, refreshed when stale.
  async function paintTeam() {
    const slot = $('#payroll-team');
    if (!slot || !state.me) return;
    const fill = (s) => { const el = $('#payroll-team'); if (el) { el.innerHTML = teamMarkup(s); el.hidden = !s; } };
    if (state.trickle) fill(standingFrom(state.trickle.t, state.me.user.charity_id));
    fill(await teamStanding());
  }
  // Mirrors tierFor in the server's src/game.js.
  function tierOf(invested, value) {
    if (value <= 0) return 'Rest in peace';
    const p = (value - invested) / invested;
    if (p <= -0.5) return 'Comically disastrous';
    if (p <= -0.25) return 'Taking on water';
    if (p <= -0.1) return 'Flesh wound';
    if (p < 0) return 'Paper cut';
    if (p < 0.1) return 'Pocket change';
    if (p < 0.25) return 'Respectable';
    if (p < 0.5) return 'Nice';
    if (p < 1) return 'Heater';
    return 'Legend';
  }
  // One per tier, best to worst, so a glance at a line says how it went.
  const TIER_EMOJI = {
    Legend: '🚀', Heater: '🔥', Nice: '📈', Respectable: '👍', 'Pocket change': '🪙',
    'Paper cut': '🩹', 'Flesh wound': '🤕', 'Taking on water': '🌊', 'Comically disastrous': '🤡', 'Rest in peace': '💀',
  };
  // "+$17K" / "−$3K" for the card: whole thousands once it's big enough.
  const cardMoney = (v) => `${v > 0.004 ? '+' : ''}${money(v, Math.abs(v) >= 10 ? { whole: true } : {})}`;

  // A few short lines:
  //   Trickle Down · Day 12 · +$18K
  //   Sold: 📈 NVDA +34% · 🤕 DOGE −12%
  //   Riding: 👍 TSLA +12%
  //   Bought: KO $30K · BTC $15K
  //   https://trickledown.stevenhester.com
  // Day N is how many days the account has been going. The total is what you
  // cashed out or let ride today. Each trade gets its tier's emoji
  // (🚀 🔥 📈 👍 🪙 / 🩹 🤕 🌊 🤡 💀), best first.
  function shareText(me) {
    const today = me.day.key;
    const closes = (me.history || []).filter((h) => h.closed_day === today && !h.gift && !h.vested && h.invested > 0);
    const buys = (me.positions || []).filter((p) => p.opened_day === today && !(p.ride_count > 0));
    const net = round2(closes.reduce((s, h) => s + h.profit, 0));
    const dayN = me.user.account_day || me.day.number; // older servers: the game's day number
    const lines = [`Trickle Down · Day ${dayN}${closes.length ? ` · ${cardMoney(net)}` : ''}`];
    const more = (list, n) => (list.length > n ? ` +${list.length - n} more` : '');
    const trades = (list, n) => list.slice(0, n).map((h) => `${TIER_EMOJI[tierOf(h.invested, h.invested + h.profit)]} ${h.symbol} ${pct(h.profit / h.invested, 0)}`).join(' · ') + more(list, n);
    const best = (list) => [...list].sort((x, y) => y.profit - x.profit);
    const sold = best(closes.filter((h) => !h.rode)), rode = best(closes.filter((h) => h.rode));
    if (sold.length) lines.push(`Sold: ${trades(sold, 4)}`);
    if (rode.length) lines.push(`Riding: ${trades(rode, 3)}`);
    if (buys.length) lines.push(`Bought: ${buys.slice(0, 3).map((p) => `${p.symbol} ${money(p.invested, p.invested >= 10 ? { whole: true } : {})}`).join(' · ')}${more(buys, 3)}`);
    // Today's hires, and for whom.
    const hired = round2((me.history || []).filter((h) => h.closed_day === today).reduce((s, h) => s + (h.lobbyists || 0), 0));
    const charity = (state.charities.find((c) => c.id === me.user.charity_id) || {}).name || null;
    if (hired > 0) lines.push(`Hired ${lobby(hired)}${charity ? ` for ${charity}` : ''}`);
    else if (charity) lines.push(`Lobbying for ${charity}`);
    // A guest's name isn't worth inviting people onto.
    lines.push(`Come lobby with me: ${me.user.is_guest ? SITE_LINK : inviteLink(me.user.username)}`);
    // money() glues "−" to "$" with an invisible word joiner; a chat app
    // doesn't need it, and some show it as a box.
    return lines.join('\n').split(String.fromCharCode(0x2060)).join('');
  }

  async function share() {
    const me = state.me;
    if (!me) return;
    try { await ensureCharities(); } catch (e) { /* the charity line is skipped */ }
    const text = shareText(me);
    const canShare = typeof navigator.share === 'function';
    $('#share-body').innerHTML = `
      <div class="share-bubble"><p class="share-text">${esc(text)}</p></div>
      <div class="share-actions">
        ${canShare ? '<button type="button" class="btn primary" id="share-go">Share</button>' : ''}
        <button type="button" class="btn ${canShare ? 'quiet' : 'primary'}" id="share-copy">Copy</button>
      </div>
      <p class="muted small">Day ${esc(String(me.user.account_day || me.day.number))} of your account. The total is today's sells and rides; each trade's emoji says how it went, 🚀 down to 💀. ${me.user.is_guest ? 'Keep your account and the link will go to your profile.' : 'Anyone who starts playing from your link begins with you on their friends list.'}</p>`;
    const go = $('#share-go');
    if (go) go.onclick = async () => { try { await navigator.share({ text }); softClose($('#dlg-share')); } catch (e) { /* cancelled */ } };
    $('#share-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied. Go brag.'); softClose($('#dlg-share')); }
      catch (e) { toast("Couldn't copy. Select the text and copy it yourself.", 4000); }
    };
    $('#dlg-share').showModal();
  }


  // --- the lobby --------------------------------------------------------------------------------

  async function loadTrickle() {
    const el = $('#screen-trickle');
    el.innerHTML = `${backLink()}<h1>Lobbyfest</h1><p class="lede">Loading…</p>`;
    try {
      const t = await API.get('/trickle');
      state.trickle = { at: Date.now(), t };
      const team = state.me ? standingFrom(t, state.me.user.charity_id) : null;
      const max = Math.max(...t.charities.map((c) => c.share), 0.0001);
      el.innerHTML = `
        ${backLink()}
        <h1>Lobbyfest</h1>
        <p class="lede">Where the real money goes. At Lobbyfest (January 1, April 1, July 1, October 1), ${t.demo ? 'the' : "this site's"} ad money is split between these charities by how many lobbyists each has, and at least ${usd(t.min_usd || 100)} goes out every time. <a href="#promises">Our promises</a> spell out exactly how.</p>
        ${t.demo ? `<div class="note warn">Demo: the money here is pretend. The charities are the real list, each rated four stars by Charity Navigator.</div>` : t.pool_usd > 0 ? '' : `<div class="note">Real charities, each rated four stars by Charity Navigator. No ads are running yet, so the ads have earned $0 so far. At least ${usd(t.min_usd || 100)} goes out at Lobbyfest anyway: if the ads earn less, the owners make up the difference. The lobbyist counts are live, and they decide the split.</div>`}
        <div class="lobby-stats">
          <div><b>${esc(lobbyN(t.quarter_total))}</b><span>lobbyists this quarter, from ${t.quarter_donors} player${t.quarter_donors === 1 ? '' : 's'}</span></div>
          <div><b data-fest="${esc(t.quarter_ends_at)}">${esc(untilLong(t.quarter_ends_at))}</b><span>until Lobbyfest, ${esc(festDate(t.quarter_ends_at))}</span></div>
          <div><b>${usd(t.payout_usd != null ? t.payout_usd : Math.max(t.pool_usd, 100))}</b><span>${t.demo ? 'pretend money' : 'real money'} going out at Lobbyfest${t.pool_usd < (t.min_usd || 100) ? ` (ads ${usd(t.pool_usd)}, the rest from us)` : ''}</span></div>
        </div>
        ${teamMarkup(team)}
        ${eventBannerHtml(featuredNow(await currentEvents()))}
        <ul class="charities">
          ${t.charities.map((c) => `
            <li class="charity">
              <div class="charity-top">
                ${safeHref(c.url) ? `<a class="name" href="${safeHref(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.name)}</a>` : `<span class="name">${esc(c.name)}</span>`}
                <b>${Math.round(c.share * 100)}%</b>
              </div>
              <div class="charity-bar"><i style="--w:${(c.share / max * 100).toFixed(1)}%"></i></div>
              <div class="charity-sub">
                <span>${esc(lobby(c.quarter_total))} from ${c.quarter_donors} player${c.quarter_donors === 1 ? '' : 's'}</span>
                <span>${c.left_out ? `under ${usd(t.charity_min_usd || 5)} for now: rolls over` : c.est_usd > 0 ? `would get ${usd(c.est_usd)}` : ''}</span>
              </div>
              <p class="blurb">${esc(c.blurb)}${c.rating ? ` <span class="ch-rating"><span aria-hidden="true">★★★★</span> ${esc(c.rating)}</span>` : ''}${safeHref(c.donate) ? ` <a class="give-link" href="${safeHref(c.donate)}" target="_blank" rel="noopener noreferrer">Give directly ↗</a>` : ''}</p>
            </li>`).join('')}
        </ul>
        <p class="muted small">Giving directly goes straight to the charity. Trickle Down never touches it.</p>
        <p><a href="#history" class="history-link">Past Lobbyfests →</a></p>
        <p class="muted small">"Would get" is if Lobbyfest were today. A charity whose share would be under ${usd(t.charity_min_usd || 5)} gets nothing this time, its lobbyists roll over to the next Lobbyfest, and the rest is split again. Every quarter starts at zero; career totals and ranks carry over. <button type="button" class="linkish" data-request-charity>Don't see your charity? Request one.</button></p>`;
    } catch (e) {
      el.innerHTML = `${backLink()}<h1>Lobbyfest</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // A position at zero: three lobbyists, heads bowed, and a headstone (3.4).
  function ripScene(symbol) {
    const mourner = (x) => `<g transform="translate(${x} 5)"><g class="rip-bow">${Coin.LOBBYIST_PATHS}</g></g>`;
    return `<figure class="rip-scene">
      <svg viewBox="0 0 126 48" class="rip-svg" aria-hidden="true">
        ${mourner(6)}${mourner(30)}${mourner(54)}
        <g class="rip-stone" transform="translate(88 10)"><path d="M0 36 V13 a15 13 0 0 1 30 0 V36 z"/><text x="15" y="20" text-anchor="middle">RIP</text><text x="15" y="30" text-anchor="middle" class="rip-tk">${esc(String(symbol || '').slice(0, 6))}</text></g>
        <line x1="0" y1="46.5" x2="126" y2="46.5" class="rip-ground"/>
      </svg>
      <figcaption>The lobbyists held a service. Preston charged for the chairs.</figcaption>
    </figure>`;
  }

  // --- Past Lobbyfests (3.5): public, like the promises ---------------------------------------
  const quarterLabel = (q) => { const m = /^(\d{4})-Q([1-4])$/.exec(q || ''); return m ? `Q${m[2]} ${m[1]}` : esc(q || ''); };
  const dayLong = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
  async function renderHistory() {
    const el = $('#screen-history');
    const back = API.token() ? backLink() : '<a href="#" class="back-link">← Trickle Down</a>';
    el.innerHTML = `${back}<h1>Past Lobbyfests</h1><p class="lede">Loading…</p>`;
    try {
      const { lobbyfests: list = [] } = await API.get('/lobbyfests');
      el.innerHTML = `${back}<h1>Past Lobbyfests</h1>
        <p class="lede">Every quarter: what went out, to whom, and the receipt. <a href="#promises">Our promises</a> say each one lands here within 60 days.</p>
        ${list.length ? list.map((f) => `
          <section class="fest">
            <h2>${quarterLabel(f.quarter)} ${f.paid_at ? `<span class="muted">paid ${esc(dayLong(f.paid_at))}</span>` : ''}</h2>
            <p class="fest-pot"><b>${usd(f.pot)}</b> to charity</p>
            ${(f.payouts || []).length ? `<table class="fest-table"><thead><tr><th>Charity</th><th class="num">Lobbyists</th><th class="num">Paid</th></tr></thead><tbody>${f.payouts.map((x) => `
              <tr><td>${safeHref(x.url) ? `<a href="${safeHref(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>` : esc(x.name)}</td><td class="num">${esc(lobbyN(x.lobbyists))}</td><td class="num">${usd(x.usd)}</td></tr>`).join('')}</tbody></table>` : ''}
            ${safeHref(f.receipt_url) ? `<p><a href="${safeHref(f.receipt_url)}" target="_blank" rel="noopener noreferrer">The receipt ↗</a></p>` : '<p class="muted small">Receipt to come.</p>'}
            ${f.notes ? `<p class="muted small">${esc(f.notes)}</p>` : ''}
          </section>`).join('') : '<p class="note">The first Lobbyfest is January 1, 2027. Receipts land here within 60 days of it, as promised.</p>'}`;
    } catch (e) {
      el.innerHTML = `${back}<h1>Past Lobbyfests</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- leaderboards -----------------------------------------------------------------------------

  // The boards, for everyone or just your friends. Every name opens that
  // player's profile.
  const leaders = { scope: 'all' };

  const playerLink = (name, cls = '') => `<a href="#u/${encodeURIComponent(name)}" class="player-link ${cls}" data-player="${esc(name)}">${esc(name)}</a>`;
  function openPlayer(name) { if (name) location.hash = `#u/${encodeURIComponent(name)}`; }
  const backLink = () => '<a href="#today" class="back-link">← Back to today</a>';

  async function loadLeaders() {
    const el = $('#screen-leaders');
    el.innerHTML = `${backLink()}<h1>Leaderboards</h1><p class="lede">Loading…</p>`;
    try {
      const friendsOnly = leaders.scope === 'friends';
      const b = await API.get(friendsOnly ? '/leaderboard?friends=1' : '/leaderboard');
      const meName = state.me ? state.me.user.username : null;
      const rowCls = (u) => (u === meName ? 'me' : '');
      const fold = (i, r) => (i >= 10 && r.username !== meName ? 'fold' : '');
      el.innerHTML = `
        ${backLink()}
        <h1>Leaderboards</h1>
        <p class="lede">Tap anyone to see their profile: how their trading has gone, what they're holding, their town. Rankings are by lobbyists, because that's what counts. Money is just how you get them.</p>
        <div class="scope-toggle" role="tablist">
          <button class="chip ${friendsOnly ? '' : 'on'}" data-scope="all" role="tab">Everyone</button>
          <button class="chip ${friendsOnly ? 'on' : ''}" data-scope="friends" role="tab">Friends${state.me && state.me.friend_count ? ` (${state.me.friend_count + 1})` : ''}</button>
        </div>
        <h2 class="board-h">Most lobbyists <span class="muted">${friendsOnly ? 'friends · ' : ''}this quarter · Lobbyfest in ${esc(untilLong(b.quarter_ends_at))}</span></h2>
        ${b.all_time.length ? `
        <table class="board board-fold">
          <thead><tr><th></th><th>Player</th><th class="num">This quarter</th><th class="num">Career</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr class="${fold(i, r)}"><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${playerLink(r.username)}</td><td class="num">${esc(lobbyN(r.quarter || 0))}</td><td class="num muted">${esc(lobbyN(r.donated))}</td><td class="num">${r.streak}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">${friendsOnly ? 'None of your friends have hired anyone this quarter. Lead by example.' : 'Nobody has collected a profit yet. The board is yours.'}</p>`}
        ${friendsOnly && b.all_time.length < 2 ? '<p class="invite-row"><button type="button" class="btn small primary" data-share>Invite someone</button></p>' : ''}

        <h2 class="board-h">Best cash-out <span class="muted">last 24 hours</span></h2>
        ${b.last_24h.length ? `
        <table class="board board-fold">
          <thead><tr><th></th><th>Player</th><th>Trade</th><th class="num">Gain</th></tr></thead>
          <tbody>${b.last_24h.map((r, i) => `
            <tr class="${fold(i, r)}">
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${playerLink(r.username)}</td>
              <td><span class="tier">${esc(r.tier)}</span>${esc(r.symbol)} ${money(r.invested)} → ${money(r.proceeds)}</td>
              <td class="num ${dir(r.gain_pct)}">${pct(r.gain_pct, 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<p class="muted">No cash-outs in the last day.</p>'}

        <h2 class="board-h">Biggest positions <span class="muted">right now</span></h2>
        ${b.biggest && b.biggest.length ? `
        <table class="board board-biggest board-fold">
          <thead><tr><th></th><th>Player</th><th>Position</th><th class="num">Worth</th></tr></thead>
          <tbody>${b.biggest.map((r, i) => `
            <tr class="${fold(i, r)}">
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${playerLink(r.username)}</td>
              <td><b>${esc(r.symbol)}</b> <span class="muted">${money(r.invested)} in${r.multiplier_now ? ` · ${mult(r.multiplier_now)}` : ''}${r.matured ? ' · matured' : r.ride_count ? ' · riding' : ''}</span></td>
              <td class="num"><b>${money(r.value)}</b>${r.priced && r.swing_pct != null ? ` <span class="${dir(r.swing_pct)} small">${pct(r.swing_pct, 0)}</span>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">${friendsOnly ? 'None of your friends are holding anything right now.' : 'Nobody is holding anything right now.'}</p>`}
        <p class="muted small">Add people on the <a href="#friends">Friends</a> page to see a board of just them.</p>`;
      $$('#screen-leaders [data-scope]').forEach((btn) => { btn.onclick = () => { leaders.scope = btn.dataset.scope; loadLeaders(); }; });
      // Ten rows per board; the rest behind one tap.
      $$('#screen-leaders .board-fold').forEach((tbl) => {
        const hidden = tbl.querySelectorAll('tr.fold').length;
        if (!hidden) return;
        const more = document.createElement('button'); more.type = 'button'; more.className = 'linkish board-more'; more.textContent = `Show ${hidden} more`;
        more.onclick = () => { tbl.querySelectorAll('tr.fold').forEach((tr) => tr.classList.remove('fold')); more.remove(); };
        tbl.insertAdjacentElement('afterend', more);
      });
    } catch (e) {
      el.innerHTML = `${backLink()}<h1>Leaderboards</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- friends ----------------------------------------------------------------------------------

  // Adding a friend is one-way: you see them on your board, and they get a
  // note ("you added them") with an Add back button. Adding someone also lets
  // them write on your wall. People who added you and are waiting on an
  // add-back are listed first.
  async function loadFriends() {
    const el = $('#screen-friends');
    el.innerHTML = `${backLink()}<h1>Friends</h1><p class="lede">Loading…</p>`;
    try {
      const f = await API.get('/friends');
      const friends = f.friends || [];
      el.innerHTML = `
        ${backLink()}
        <h1>Friends</h1>
        <p class="lede">Friends get their own leaderboard, and they can write on your wall. It's one-way until they add you back, like most friendships.</p>
        <form class="friend-add" id="friend-add" autocomplete="off">
          <input id="friend-name" type="text" placeholder="Add by username" maxlength="20" spellcheck="false" aria-label="Username to add">
          <button class="btn small primary" type="submit">Add</button>
        </form>
        ${(f.waiting || []).length ? `<section class="friend-waiting"><h2>Added you</h2><ul class="friend-list">${f.waiting.map((w) => `
          <li class="friend" data-player="${esc(w.username)}">
            <span class="avatar" style="--av:${avColor(w.username)}" aria-hidden="true">${esc(initial(w.username))}</span>
            <div class="friend-main"><b>${esc(w.username)}</b><span class="muted">added you ${esc(ago(w.at))}</span></div>
            <button class="btn primary small" data-addback="${esc(w.username)}">Add back</button>
          </li>`).join('')}</ul></section>` : ''}
        <p class="muted friend-hint">${f.is_guest ? `You're playing as <b>${esc(f.your_username)}</b>. People can add you by that, but keep your account and you can pick a name worth sharing.` : `Your username is <b>${esc(f.your_username)}</b>. ${f.added_you ? `${f.added_you} player${f.added_you === 1 ? ' has' : 's have'} added you.` : 'Share it and get added.'} They'll get a note with an Add back button.`}</p>
        ${friends.length ? `<ul class="friend-list">${friends.map((u) => `
          <li class="friend" data-player="${esc(u.username)}">
            <span class="avatar" style="--av:${avColor(u.username)}" aria-hidden="true">${esc(initial(u.username))}</span>
            <div class="friend-main">
              <b>${esc(u.username)}</b>
              <span class="muted">${u.badges && u.badges.earned.length ? esc(u.badges.earned[u.badges.earned.length - 1].name) : 'No rank yet'} · ${esc(lobby(u.quarter_donated))} this quarter · ${u.streak}-day streak</span>
            </div>
            <span class="muted friend-seen">${esc(u.last_seen || '')}</span>
            <button class="btn quiet small" data-unfriend="${esc(u.username)}" aria-label="Remove ${esc(u.username)}" title="Remove">×</button>
          </li>`).join('')}</ul>` : `<div class="invite-empty"><p class="muted">Nobody here yet. Friends get their own leaderboard and can write on your wall.${API.demo ? ' In the demo, try adding <b>ravi_k</b> or <b>bagholder_ben</b>.' : ''}</p><button type="button" class="btn small primary" data-share>Invite someone</button></div>`}`;
      $$('#screen-friends .friend').forEach((li) => { li.onclick = (ev) => { if (ev.target.closest('[data-unfriend], [data-addback]')) return; openPlayer(li.dataset.player); }; });
      $$('#screen-friends [data-addback]').forEach((btn) => {
        btn.onclick = async (ev) => { ev.stopPropagation(); btn.disabled = true; if (await addFriend(btn.dataset.addback, { back: true })) loadFriends(); else btn.disabled = false; };
      });
      $$('#screen-friends [data-unfriend]').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          try { await API.post('/friends/remove', { username: btn.dataset.unfriend }); toast(`${btn.dataset.unfriend} removed. They'll never know.`); if (state.me) state.me.friend_count = Math.max(0, (state.me.friend_count || 1) - 1); await loadFriends(); } catch (e) { toast(e.message, 4000); }
        };
      });
      $('#friend-add').onsubmit = (ev) => { ev.preventDefault(); addFriend($('#friend-name').value.trim()); };
    } catch (e) {
      el.innerHTML = `${backLink()}<h1>Friends</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  async function addFriend(name, { back = false } = {}) {
    if (!name || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/friends/add', { username: name });
      toast(back ? `You and ${r.username} are friends now. Each of you can write on the other's wall.` : `${r.username} added. They're on your board now, and they can write on your wall.`, 4500);
      if (state.me && state.me.new_followers) state.me.new_followers = state.me.new_followers.filter((f) => f.username.toLowerCase() !== r.username.toLowerCase());
      if (state.me) state.me.friend_count = r.friend_count;
      if (state.tab === 'friends') await loadFriends();
      refreshAchievements(1200);
      return true;
    } catch (e) { toast(e.message, 4500); return false; }
    finally { state.busy = false; }
  }

  // --- profiles -----------------------------------------------------------------------------------
  //
  // Yours and everyone else's. The headline is a chart of how your trading
  // has gone: profit and loss from positions only, so a gift from Mommy &
  // Daddy or a casino you built doesn't move it. Then what they're holding,
  // their town, their lobbyists, their trophies, and a wall their friends
  // can write on.

  const initial = (name) => String(name || '?').replace(/^guest_/i, '').charAt(0).toUpperCase() || '?';
  const AV_COLORS = ['#1879A0', '#0F5873', '#2E7D5B', '#8A6A3C', '#6B4E8C', '#B0412E', '#3F7D55', '#1B6E8C'];
  const avColor = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; };
  const signed = (v, opts) => `${v > 0.004 ? '+' : ''}${money(v, opts)}`;
  const dayLabel = (d) => (d === 'now' ? 'Now' : new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const isoAdd = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  const RANGES = [['1W', 7, 'past week'], ['1M', 30, 'past month'], ['3M', 90, 'past 3 months'], ['All', 0, 'all time']];
  const prof = { range: '1M', p: null };

  async function loadProfile(name) {
    const el = $('#screen-profile');
    if (!name) { location.hash = '#today'; return; }
    if (!prof.p || prof.p.username.toLowerCase() !== String(name).toLowerCase()) el.innerHTML = `${backLink()}<p class="lede">Loading…</p>`;
    try {
      const { player: p } = await API.get(`/players/${encodeURIComponent(name)}`);
      prof.p = p;
      renderProfile(p);
      $('#btn-me').classList.toggle('on', !!p.is_you);
      if (prof.toWall) { prof.toWall = false; const w = $('#screen-profile .prof-wall'); if (w) setTimeout(() => w.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }), 150); }
      if (p.is_you && state.me) { state.me.wall_unread = 0; updateMenuDot(); }
    } catch (e) {
      el.innerHTML = `${backLink()}<h1>${esc(name)}</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // The points for a range. The last point is "now": today's realized total
  // plus what's open, at today's prices.
  function perfPoints(perf, days) {
    let pts = perf.series.map((x) => ({ d: x.d, v: x.v }));
    if (pts.length) { const last = pts[pts.length - 1]; pts[pts.length - 1] = { d: 'now', v: round2(last.v + (perf.open_pnl || 0)) }; }
    if (days && pts.length > 1) {
      const end = perf.series[perf.series.length - 1].d;
      const cutoff = isoAdd(end, -days);
      const i = pts.findIndex((x) => x.d === 'now' || x.d >= cutoff);
      pts = pts.slice(Math.max(0, i - 1));
    }
    if (pts.length === 1) pts = [{ ...pts[0], d: pts[0].d === 'now' ? perf.series[0].d : pts[0].d }, pts[0]];
    return pts;
  }

  function perfMarkup(perf) {
    if (!perf) return '';
    if (!perf.series || !perf.series.length) {
      return `<section class="prof-sec perf"><div class="perf-head"><span class="perf-eyebrow">Trading gains</span><b class="perf-total">$0</b><span class="perf-sub muted">No trades yet.</span></div></section>`;
    }
    const [label, days, words] = RANGES.find((r) => r[0] === prof.range) || RANGES[1];
    const pts = perfPoints(perf, days);
    const change = round2(pts[pts.length - 1].v - pts[0].v);
    const tone = change > 0.004 ? 'up' : change < -0.004 ? 'down' : 'flat';
    const W = 600, H = 180, pad = 12;
    const vs = pts.map((p) => p.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < 0.01) { lo -= 1; hi += 1; }
    const X = (i) => (i / (pts.length - 1)) * W;
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const base = Y(pts[0].v).toFixed(1);
    prof.chart = { pts, X, Y, W, H, words, change, tone };
    const winRate = perf.closed ? Math.round((perf.wins / perf.closed) * 100) : null;
    return `
      <section class="prof-sec perf tone-${tone}">
        <div class="perf-head">
          <span class="perf-eyebrow">Trading gains</span>
          <b class="perf-total ${dir(perf.total)}" id="perf-total">${signed(perf.total)}</b>
          <span class="perf-sub ${tone === 'flat' ? 'muted' : tone}" id="perf-sub">${signed(change)} ${esc(words)}</span>
        </div>
        <div class="perf-chart" id="perf-chart" role="img" aria-label="Trading gains, ${esc(words)}: ${esc(signed(change))}">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" x2="${W}" y1="${base}" y2="${base}" class="perf-base"/>
            <path d="${path}" class="perf-line"/>
          </svg>
          <i class="perf-cursor" hidden></i><i class="perf-dot" hidden></i>
        </div>
        <div class="perf-ranges" role="tablist">${RANGES.map(([l]) => `<button type="button" role="tab" class="${l === label ? 'on' : ''}" aria-selected="${l === label}" data-range="${l}">${l}</button>`).join('')}</div>
        <ul class="perf-stats">
          <li><span>Win rate</span><b>${winRate == null ? '—' : `${winRate}%`}</b><small>${perf.closed ? `${perf.wins} of ${perf.closed} closed` : 'nothing closed yet'}</small></li>
          <li><span>Best trade</span><b class="${perf.best ? 'up' : ''}">${perf.best ? signed(perf.best.profit) : '—'}</b><small>${perf.best ? `${esc(perf.best.symbol)}${perf.best.pct != null ? `, ${pct(perf.best.pct, 0)}` : ''}` : 'no wins yet'}</small></li>
          <li><span>Worst trade</span><b class="${perf.worst ? 'down' : ''}">${perf.worst ? signed(perf.worst.profit) : '—'}</b><small>${perf.worst ? `${esc(perf.worst.symbol)}${perf.worst.pct != null ? `, ${pct(perf.worst.pct, 0)}` : ''}` : 'no losses yet'}</small></li>
          <li><span>Open now</span><b class="${dir(perf.open_pnl)}">${signed(perf.open_pnl)}</b><small>not yet collected</small></li>
        </ul>
        <p class="muted small perf-note">Profit and loss from buying and selling, before tax. Gifts from Mommy &amp; Daddy and TrickleTown spending don't move this line.</p>
      </section>`;
  }

  function wirePerf() {
    $$('#screen-profile [data-range]').forEach((b) => {
      b.onclick = () => {
        prof.range = b.dataset.range;
        const sec = $('#screen-profile .perf');
        sec.outerHTML = perfMarkup(prof.p.performance);
        wirePerf();
      };
    });
    const box = $('#perf-chart'); if (!box || !prof.chart) return;
    const { pts, X, Y, W, H, words, change, tone } = prof.chart;
    const cur = $('.perf-cursor', box), dot = $('.perf-dot', box);
    const total = $('#perf-total'), sub = $('#perf-sub');
    const rest = () => {
      cur.hidden = true; dot.hidden = true;
      total.textContent = signed(prof.p.performance.total); total.className = `perf-total ${dir(prof.p.performance.total)}`;
      sub.textContent = `${signed(change)} ${words}`; sub.className = `perf-sub ${tone === 'flat' ? 'muted' : tone}`;
    };
    const at = (clientX) => {
      const r = box.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((clientX - r.left) / r.width) * (pts.length - 1))));
      const p = pts[i];
      cur.hidden = false; dot.hidden = false;
      cur.style.left = dot.style.left = `${(X(i) / W) * 100}%`;
      dot.style.top = `${(Y(p.v) / H) * 100}%`;
      total.textContent = signed(p.v); total.className = `perf-total ${dir(p.v)}`;
      const d = round2(p.v - pts[0].v);
      sub.textContent = `${dayLabel(p.d)} · ${signed(d)} since ${dayLabel(pts[0].d)}`; sub.className = `perf-sub ${d > 0.004 ? 'up' : d < -0.004 ? 'down' : 'muted'}`;
    };
    box.onpointermove = (e) => at(e.clientX);
    box.onpointerdown = (e) => at(e.clientX);
    box.onpointerleave = rest;
    box.onpointerup = (e) => { if (e.pointerType !== 'mouse') rest(); };
    box.onpointercancel = rest;
  }

  function holdingsMarkup(p) {
    const open = p.positions || [];
    if (!open.length) return `<section class="prof-sec"><h2>Holding now</h2><p class="muted">Nothing on the coin right now. ${money(p.cash)} in bills.</p></section>`;
    return `<section class="prof-sec"><h2>Holding now <span class="muted">${money(p.in_play)} in play</span></h2>
      <ul class="prof-holdings">${open.map((x) => {
        const val = x.quote_error || x.value == null ? null : x.value;
        const when = x.matures_at ? left(x.matures_at) : x.hours_left ? `about ${x.hours_left}h` : '';
        const tag = x.busted ? 'gone' : x.matured ? 'matured, ready to collect' : x.ride_count > 0 ? `riding${x.ride_count > 1 ? ` ×${x.ride_count}` : ''}${when ? `, ${mult(x.multiplier)} in ${when}` : ''}` : when ? `${mult(x.multiplier)} in ${when}` : '';
        return `<li>
          <span class="ph-name"><b>${esc(x.symbol)}</b> <span class="muted">${esc(x.name || '')}</span><small class="muted">${esc(tag)}</small></span>
          <span class="ph-val">${money(x.invested)} → <b>${val == null ? '—' : money(val)}</b>${x.busted ? ' <em class="down">RIP</em>' : x.swing_pct != null && !x.quote_error ? ` <em class="${dir(x.swing_pct)}">${pct(x.swing_pct, 0)}</em>` : ''}</span>
        </li>`;
      }).join('')}</ul>${p.positions_total > open.length ? `<p class="muted small">…and ${p.positions_total - open.length} smaller ones.</p>` : ''}</section>`;
  }

  function townMarkup(p) {
    const t = p.town;
    if (!t) return `<section class="prof-sec"><h2>TrickleTown</h2><p class="muted">No town yet. TrickleTown opens with the first lobbyist.</p></section>`;
    const sides = t.sides || { preston: 0, dolores: 0 };
    const played = (sides.preston || 0) + (sides.dolores || 0);
    const pp = played ? Math.round((sides.preston / played) * 100) : 50;
    const lean = !played ? 'No cards played yet.' : pp >= 65 ? 'Mostly Preston. The numbers are up.' : pp <= 35 ? 'Mostly Dolores. The people are up.' : 'Splits the difference. Both of them are annoyed.';
    return `<section class="prof-sec prof-town"><h2>TrickleTown <span class="muted">“${esc(t.motto || '')}”</span></h2>
      <ul class="prof-nums">${t.happiness == null ? `
        <li><span>Profit</span><b class="hidden-meter">Hidden by management</b></li>
        <li><span>Happiness</span><b class="hidden-meter">Hidden by management</b></li>
        <li><span>Lobbyist price</span><b class="hidden-meter">Hidden by management</b></li>` : `
        <li><span>Profit</span><b class="${t.income < 0 ? 'down' : 'up'}">${t.income >= 0 ? '+' : ''}${money(t.income, { whole: true })}<small>/day</small></b></li>
        <li><span>Happiness</span><b>${Math.round(t.happiness)}</b><i class="ss-bar"><i style="--w:${Math.max(0, Math.min(100, t.happiness))}%"></i></i></li>
        <li><span>Lobbyist price</span><b>${money(t.hire_cost)}</b></li>`}
      </ul>
      ${t.pet ? `<div class="prof-pet">${Coin.catPortrait(t.pet, 64)}<div><span><b>${esc(t.pet.name)}</b> <span class="muted">the cat</span></span><small>${esc(catWearingText(t.pet))}</small><small>Wardrobe worth ${money(t.pet.spent || 0, { whole: true })}</small></div></div>` : ''}
      <div class="prof-lots">${(t.buildings || []).map((b) => (b.key
        ? `<div class="prof-lot tier-${esc(b.tier || '')}"><span class="muted">${esc(b.label || b.slot)}</span><b>${esc(b.name)}</b>${b.upgrades && b.upgrades.length ? `<small>+ ${b.upgrades.map((u) => esc(u.name)).join(', ')}</small>` : ''}${b.days ? `<small class="muted">${b.days} day${b.days === 1 ? '' : 's'} standing</small>` : ''}</div>`
        : `<div class="prof-lot empty"><span class="muted">${esc(b.label || b.slot)}</span><b>Empty lot</b></div>`)).join('')}</div>
      <div class="prof-sides">
        <div class="ps-head"><span>${Coin.preston(28)} Preston <b>${sides.preston || 0}</b></span><span><b>${sides.dolores || 0}</b> Dolores ${Coin.dolores(28)}</span></div>
        <div class="ps-bar ${played ? '' : 'none'}" aria-hidden="true"><i class="ps-p" style="--w:${played ? pp : 50}%"></i><i class="ps-d"></i></div>
        <small class="muted">${played ? `${played} card${played === 1 ? '' : 's'} played. ` : ''}${esc(lean)}</small>
      </div>
    </section>`;
  }

  function lobbyMarkup(p) {
    const rows = p.lobbyists_by_charity || [];
    const max = Math.max(0.0001, ...rows.map((r) => r.amount));
    return `<section class="prof-sec"><h2>Lobbyists</h2>
      <ul class="prof-nums">
        <li><span>This quarter</span><b>${esc(lobbyN(p.quarter_donated || 0))}</b></li>
        <li><span>Career</span><b>${esc(lobbyN(p.total_donated || 0))}</b></li>
        <li><span>Rank</span><b class="rank-name">${esc(p.badges && p.badges.earned.length ? p.badges.earned[p.badges.earned.length - 1].name : '—')}</b></li>
      </ul>
      ${rows.length ? `<ul class="prof-charities">${rows.map((r) => `<li><span>${esc(r.name)}</span><b>${esc(lobbyN(r.amount))}</b><i class="charity-bar"><i style="--w:${((r.amount / max) * 100).toFixed(1)}%"></i></i></li>`).join('')}</ul>`
        : '<p class="muted small">No lobbyists this quarter yet.</p>'}
    </section>`;
  }

  function trophiesMarkup(p) {
    const a = p.achievements; if (!a) return '';
    return `<section class="prof-sec"><h2>Trophies <span class="muted">${a.earned.length} of ${a.total}</span></h2>
      ${a.earned.length ? `<ul class="prof-trophies">${a.earned.map((x) => `<li title="${esc(x.how || '')}">${TROPHY('sm')}<span>${esc(x.title)}</span></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
    </section>`;
  }

  function wallMarkup(p) {
    const w = p.wall; if (!w) return '';
    if (!w.open) {
      return `<section class="prof-sec prof-wall"><h2>Wall</h2><p class="muted">${esc(p.username)} hasn't added you, so their wall is closed to you. Only people they've added can read it and write on it.</p></section>`;
    }
    const posts = w.posts || [];
    return `<section class="prof-sec prof-wall"><h2>${p.is_you ? 'Your wall' : 'Wall'}</h2>
      <p class="muted small">${p.is_you ? "People you've added on the Friends page can read and write here. You can delete anything." : `Only people ${esc(p.username)} has added can see this.`}</p>
      <form class="wall-form" id="wall-form" autocomplete="off">
        <textarea id="wall-body" rows="2" maxlength="${w.max || 280}" placeholder="${p.is_you ? 'Say something to whoever drops by' : `Write on ${esc(p.username)}'s wall`}" aria-label="Wall post"></textarea>
        <div class="wall-row"><small class="muted" id="wall-count">${w.max || 280}</small><button type="submit" class="btn small primary" id="wall-post">Post</button></div>
      </form>
      ${posts.length ? `<ul class="wall-list">${posts.map((x) => `
        <li class="wall-post">
          <span class="avatar sm" style="--av:${avColor(x.author)}" aria-hidden="true">${esc(initial(x.author))}</span>
          <div class="wall-main">
            <div class="wall-meta">${playerLink(x.author)} <span class="muted">· ${esc(ago(x.at))}</span></div>
            <p class="wall-text">${esc(x.body)}</p>
          </div>
          ${x.can_delete ? `<button type="button" class="wall-del" data-wall-del="${Number(x.id)}" aria-label="Delete post" title="Delete">×</button>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted small">Nothing here yet.</p>'}
    </section>`;
  }

  function renderProfile(p) {
    const rank = p.badges && p.badges.earned.length ? p.badges.earned[p.badges.earned.length - 1].name : 'No rank yet';
    // The server sends the month ("2026-10"); older servers the full timestamp.
    const since = p.joined ? new Date(/^\d{4}-\d{2}$/.test(p.joined) ? `${p.joined}-15T12:00:00` : p.joined).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;
    const signedIn = !!(state.me && API.token());
    $('#screen-profile').classList.toggle('visitor', !signedIn);
    $('#screen-profile').innerHTML = `
      ${signedIn ? backLink() : '<a href="#" class="back-link">← Trickle Down</a>'}
      <header class="prof-head">
        <span class="avatar lg" style="--av:${avColor(p.username)}" aria-hidden="true">${esc(initial(p.username))}</span>
        <div class="prof-id">
          <h1>${esc(p.username)}${p.is_you ? ' <span class="muted you">(you)</span>' : ''}</h1>
          <p class="prof-meta">
            <span class="prof-rank">${esc(rank)}</span>
            <span>🔥 ${p.streak}-day streak</span>
            ${p.town && p.town.pet ? `<span>🐈 ${esc(p.town.pet.name)}</span>` : ''}
            ${since ? `<span>Playing since ${esc(since)}</span>` : ''}
            ${!p.is_you ? `<span>Played ${esc(p.last_seen || 'recently')}</span>` : ''}
            ${p.added_you && !p.is_you ? '<span class="prof-chip">Added you</span>' : ''}
          </p>
          ${p.is_you || !signedIn ? '' : `<div class="prof-actions">${p.is_friend
            ? '<button type="button" class="btn small quiet" id="prof-unfriend">Remove friend</button>'
            : `<button type="button" class="btn small primary" id="prof-add">Add friend</button><small class="muted prof-add-note">Adding ${esc(p.username)} also lets them read and write on your wall.</small>`}</div>`}
        </div>
      </header>
      ${p.performance ? perfMarkup(p.performance) : ''}
      ${holdingsMarkup(p)}
      ${townMarkup(p)}
      ${lobbyMarkup(p)}
      ${trophiesMarkup(p)}
      ${signedIn ? wallMarkup(p) : ''}
      ${signedIn ? '' : `<div class="visitor-bar" role="region" aria-label="Get your own town">
        <p>This is <b>${esc(p.username)}</b>'s town. Get your own:</p>
        <div class="visitor-ways"><button type="button" class="btn small primary" data-visitor="guest">Play as a guest</button><button type="button" class="btn small quiet" data-visitor="register">Create an account</button></div>
        <small class="muted">18+ only. Playing confirms you're 18 or older.</small>
      </div>`}`;
    wirePerf();
    $$('#screen-profile [data-visitor]').forEach((b) => { b.onclick = () => (b.dataset.visitor === 'guest' ? startGuest() : openAuth('register')); });
    const add = $('#prof-add'); if (add) add.onclick = async () => { if (await addFriend(p.username)) loadProfile(p.username); };
    const rm = $('#prof-unfriend'); if (rm) rm.onclick = async () => {
      try { await API.post('/friends/remove', { username: p.username }); toast(`${p.username} removed.`); if (state.me) state.me.friend_count = Math.max(0, (state.me.friend_count || 1) - 1); loadProfile(p.username); } catch (e) { toast(e.message, 4000); }
    };
    wireWall(p);
  }

  function wireWall(p) {
    const form = $('#wall-form');
    const paint = (posts) => { prof.p.wall.posts = posts; const sec = $('#screen-profile .prof-wall'); sec.outerHTML = wallMarkup(prof.p); wireWall(prof.p); };
    if (form) {
      const ta = $('#wall-body'), count = $('#wall-count'), max = p.wall.max || 280;
      const sync = () => { const n = [...ta.value].length; count.textContent = String(max - n); count.classList.toggle('down', n > max); };
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } });
      form.onsubmit = async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body || state.busy) return;
        state.busy = true; $('#wall-post').disabled = true;
        try { const r = await API.post(`/players/${encodeURIComponent(p.username)}/wall`, { body }); paint(r.posts); }
        catch (err) { toast(err.message, 4000); $('#wall-post').disabled = false; }
        finally { state.busy = false; }
      };
    }
    $$('#screen-profile [data-wall-del]').forEach((b) => {
      b.onclick = async () => {
        try { const r = await API.post(`/wall/${Number(b.dataset.wallDel)}/delete`, {}); paint(r.posts); } catch (err) { toast(err.message, 4000); }
      };
    });
  }

  // --- menu -----------------------------------------------------------------------------------------

  const M_ICON = {
    today: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.2c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.5-2.5 1.8-2.5.8-2.5 1.8 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/>',
    leaders: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
    friends: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2c2.6 0 4.4 1.5 5 4.3"/>',
    lobby: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
    trophies: '<path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/><path d="M12 13v4M8 21h8"/>',
    how: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6V14M12 17.2v.1"/>',
    promise: '<circle cx="12" cy="9.5" r="6"/><path d="M9.4 9.6l1.8 1.8 3.4-3.6M8.6 14.6 7.2 21l4.8-2.4 4.8 2.4-1.4-6.4"/>',
    account: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
    out: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
    theme: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    bug: '<path d="M9 7.5a3 3 0 0 1 6 0"/><rect x="7" y="7.5" width="10" height="11" rx="5"/><path d="M12 11v7.5M3.5 13H7M17 13h3.5M4.5 8.5 7 10M19.5 8.5 17 10M4.5 18.5 7 16.5M19.5 18.5 17 16.5"/>',
    admin: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6L12 3z"/><path d="M9 12l2 2 4-4"/>',
  };
  // Appearance: Auto (follow the device), Light, Dark. js/theme.js does the work.
  const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
  function themePickMarkup() {
    const now = window.Theme ? Theme.choice() : 'auto';
    return `<div class="theme-pick">${mIcon('theme')}<span id="theme-pick-label">Appearance</span>
      <div class="theme-seg" role="group" aria-labelledby="theme-pick-label">${THEMES.map(([k, label]) => `<button type="button" data-theme-pick="${k}" aria-pressed="${k === now}">${label}</button>`).join('')}</div>
    </div>`;
  }
  function wireThemePick(root) {
    root.querySelectorAll('[data-theme-pick]').forEach((b) => {
      b.onclick = () => {
        if (!window.Theme) return;
        Theme.set(b.dataset.themePick);
        root.querySelectorAll('[data-theme-pick]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      };
    });
  }
  const mIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${M_ICON[k]}</svg>`;

  // "erin wrote" / "erin and ravi_k wrote" / "erin, ravi_k and 2 others wrote"
  function wallWho(me) {
    const from = (me.wall_unread_from || []).map((n) => `<b>${esc(n)}</b>`);
    const n = me.wall_unread || 0;
    if (!from.length) return `<b>${n} new post${n === 1 ? '' : 's'}</b>`;
    const names = from.length === 1 ? from[0] : from.length === 2 ? `${from[0]} and ${from[1]}` : `${from.slice(0, 2).join(', ')} and others`;
    return `${names} wrote${n > 1 && from.length === 1 ? ` ${n} posts` : ''}`;
  }
  // Tell someone about a new wall post once, quietly: a toast that goes away
  // on its own, plus the dot and the to-do line, which stay until it's read.
  // Remembered per browser by the newest post's id, so a reload doesn't
  // repeat it.
  function maybeWallToast(me) {
    if (!me.wall_unread || !me.wall_latest) return;
    let told = null; try { told = localStorage.getItem('trickledown.wall-told'); } catch (e) { /* private mode */ }
    if (told === String(me.wall_latest)) return;
    try { localStorage.setItem('trickledown.wall-told', String(me.wall_latest)); } catch (e) { /* private mode */ }
    const who = (me.wall_unread_from || [])[0];
    // After the morning's other toasts (money landed, new cards), not over them.
    const delay = REDUCED ? 600 : me.fresh_cards && me.fresh_cards.length ? 10600 : me.allowance ? 5600 : 2200;
    setTimeout(() => toast(`💬 ${who ? `${who} wrote` : 'Someone wrote'} on your wall. Tap your avatar, top right, to read it.`, 5000), delay);
  }

  // "erin added you": a small card at the bottom, once per new follower per
  // browser, with Add back right on it. "×" waves off everyone waiting; the
  // to-do line and the Friends page keep them until then.
  function maybeFollowerPeek(me, delay) {
    const nf = me.new_followers || [];
    if (!nf.length) return;
    const key = `${nf[0].username}@${nf[0].at}`;
    let told = null; try { told = localStorage.getItem('trickledown.follow-told'); } catch (e) { /* private mode */ }
    if (delay == null && told === key) return;
    setTimeout(() => {
      const list = (state.me && state.me.new_followers) || [];
      if (!list.length || $('.ach-peek') || $('dialog[open]') || Explainer.isOpen() || state.tab !== 'today') return;
      try { localStorage.setItem('trickledown.follow-told', key); } catch (e) { /* private mode */ }
      showFollowerPeek(list);
    }, delay != null ? delay : (REDUCED ? 800 : me.allowance ? 7000 : 3200));
  }
  function showFollowerPeek(list) {
    hidePeek(true);
    const f = list[0], more = list.length - 1;
    const el = document.createElement('div');
    el.className = 'ach-peek friend-peek';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="avatar" style="--av:${avColor(f.username)}" aria-hidden="true">${esc(initial(f.username))}</span>
      <div class="ach-peek-text"><span>Added you</span><b>${esc(f.username)}</b><small>${more ? `and ${more} other${more > 1 ? 's' : ''} added you as a friend.` : 'added you as a friend.'}</small></div>
      <button type="button" class="btn small ach-peek-open" data-addback>Add back</button>
      <button type="button" class="ach-peek-x" aria-label="Not now">×</button>`;
    el.querySelector('[data-addback]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      if (!(await addFriend(f.username, { back: true }))) { e.currentTarget.disabled = false; return; }
      const rest = (state.me.new_followers || []);
      const li = $('[data-todo="friend"]');
      if (li && !rest.length) li.closest('li').remove();
      else if (li) li.innerHTML = `👋 <b>${esc(rest[0].username)}</b>${rest.length > 1 ? ` and ${rest.length - 1} other${rest.length > 2 ? 's' : ''}` : ''} added you. Add back?`;
      if (rest.length) showFollowerPeek(rest); else hidePeek();
    };
    el.querySelector('.ach-peek-x').onclick = async () => {
      hidePeek();
      try { await API.post('/friends/seen', {}); } catch (err) { /* it'll ask again next time */ }
      if (state.me) state.me.new_followers = [];
      const li = $('[data-todo="friend"]'); if (li) li.closest('li').remove();
    };
    document.body.appendChild(el);
    const root = document.documentElement;
    root.style.setProperty('--peek-h', `${el.offsetHeight}px`);
    root.classList.add('has-peek');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  }

  function updateMenuDot() {
    const n = state.me ? state.me.wall_unread || 0 : 0;
    $('#menu-dot').hidden = !n;
    $('#btn-me').setAttribute('aria-label', n ? `Your profile, ${n} new on your wall` : 'Your profile');
  }

  function openMenu() {
    const me = state.me; if (!me) return;
    const u = me.user, unread = me.wall_unread || 0, a = me.achievements;
    const cur = (t) => (state.tab === t ? ' aria-current="page"' : '');
    $('#menu-body').innerHTML = `
      <a href="#profile" class="menu-me"${cur('profile')}>
        <span class="avatar" style="--av:${avColor(u.username)}" aria-hidden="true">${esc(initial(u.username))}</span>
        <span class="menu-me-text"><b>Your profile</b><small>${esc(u.username)} · ${unread ? `${unread} new on your wall` : 'trading, town, wall'}</small></span>
        ${unread ? `<i class="menu-count">${unread}</i>` : '<i class="menu-chev" aria-hidden="true">›</i>'}
      </a>
      <a href="#today"${cur('today')}>${mIcon('today')}<span>Today's game</span></a>
      <a href="#leaders"${cur('leaders')}>${mIcon('leaders')}<span>Leaderboards</span></a>
      <a href="#friends"${cur('friends')}>${mIcon('friends')}<span>Friends</span>${me.friend_count ? `<small>${me.friend_count}</small>` : ''}</a>
      <a href="#trickle"${cur('trickle')}>${mIcon('lobby')}<span>Lobbyfest &amp; charities</span></a>
      <button type="button" data-menu-act="trophies">${mIcon('trophies')}<span>Trophies</span>${a ? `<small>${a.earned}/${a.total}</small>` : ''}</button>
      <a href="#how"${cur('how')}>${mIcon('how')}<span>How to play</span></a>
      <a href="#promises"${cur('promises')}>${mIcon('promise')}<span>Mission &amp; promises</span></a>
      <button type="button" data-menu-act="bug">${mIcon('bug')}<span>Report a bug</span></button>
      ${u.is_admin ? `<a href="#admin"${cur('admin')}>${mIcon('admin')}<span>Admin</span></a>` : ''}
      <hr>
      ${themePickMarkup()}
      <button type="button" data-menu-act="account">${mIcon('account')}<span>Account</span></button>
      <button type="button" data-menu-act="signout">${mIcon('out')}<span>Sign out</span></button>`;
    const dlg = $('#dlg-menu');
    wireThemePick($('#menu-body'));
    $$('#menu-body a').forEach((l) => { l.onclick = () => softClose(dlg); });
    $$('#menu-body [data-menu-act]').forEach((b) => {
      b.onclick = async () => {
        await softClose(dlg);
        if (b.dataset.menuAct === 'trophies') openTrophies();
        if (b.dataset.menuAct === 'account') openAccount();
        if (b.dataset.menuAct === 'signout') signOut();
        if (b.dataset.menuAct === 'bug') openBugReport();
      };
    });
    dlg.showModal();
  }

  // --- choosing a charity ----------------------------------------------------------------------------
  // The default charity matters: every lobbyist goes there, and at Lobbyfest
  // the real money follows lobbyists. So the first time someone has
  // lobbyists (or theirs was retired), the choice gets a screen of its own.

  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  // Only ever link to http(s); anything else renders as plain text.
  const safeHref = (url) => (/^https?:\/\//i.test(String(url || '')) ? esc(url) : '');

  function charityExplain(retired = false) {
    return `<div class="ch-explain">
      ${retired ? '<p><b>Trickle Down now lobbies for real charities</b>, each rated four stars by Charity Navigator. The pretend one your lobbyists had is retired, so choose a real one.</p>' : ''}
      <p>Every lobbyist you hire goes to this charity by default. At Lobbyfest each quarter, this site's ad revenue is split by headcount: <b>the more lobbyists a charity has, the bigger its share.</b></p>
      <p class="muted small">Change your mind anytime: TrickleTown → Assign lobbyists moves them and changes the default.</p>
    </div>`;
  }
  function charityCards(selectedId = null) {
    return `<ul class="ch-list" role="radiogroup" aria-label="Charities">${state.charities.map((c) => {
      const href = safeHref(c.url);
      return `<li class="ch-item ${href || safeHref(c.donate) ? 'has-links' : ''}">
        <button type="button" class="ch-card" role="radio" aria-checked="${c.id === selectedId}" data-charity="${c.id}">
          <span class="ch-top"><b>${esc(c.name)}</b>${c.category ? `<em>${esc(c.category)}</em>` : ''}</span>
          ${c.blurb ? `<span class="ch-blurb">${esc(c.blurb)}</span>` : ''}
          ${c.rating ? `<span class="ch-rating"><span aria-hidden="true">★★★★</span> ${esc(c.rating)}</span>` : ''}
        </button>
        ${href || safeHref(c.donate) ? `<span class="ch-links">${href ? `<a class="ch-link" href="${href}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.url))} ↗</a>` : ''}${safeHref(c.donate) ? `<a class="ch-link give-link" href="${safeHref(c.donate)}" target="_blank" rel="noopener noreferrer">Give directly ↗</a>` : ''}</span>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }
  function wireCharityCards(root, onPick) {
    $$('[data-charity]', root).forEach((b) => {
      b.onclick = () => {
        $$('[data-charity]', root).forEach((o) => o.setAttribute('aria-checked', String(o === b)));
        const c = state.charities.find((x) => x.id === Number(b.dataset.charity));
        if (c) onPick(c);
      };
    });
  }
  function wireRequestLinks(root) { $$('[data-request-charity]', root).forEach((b) => { b.onclick = () => openCharityRequest(); }); }

  async function chooseCharity(id) {
    const r = await API.post('/charity/choose', { charity_id: id });
    if (state.me) {
      Object.assign(state.me.user, r.user);
      state.me.donations_by_charity = r.donations_by_charity;
      state.me.needs_charity = false;
    }
    return r;
  }

  async function openCharityChooser({ auto = false } = {}) {
    if (!state.me) return;
    try { await ensureCharities(); } catch (e) { toast(e.message); return; }
    if (!state.charities.length) return;
    const retired = (state.me.donations_by_charity || []).some((c) => c.amount > 0 && c.active === false);
    const total = round2((state.me.donations_by_charity || []).reduce((x, c) => x + Math.max(0, c.amount), 0));
    const dlg = $('#dlg-charity');
    $('#charity-title').textContent = retired ? 'Choose a real charity' : 'Choose your charity';
    $('#charity-body').innerHTML = `
      ${total > 0 ? `<div class="ch-crew">${lobbyists(total, { max: 12 })}<span><b>${esc(lobby(total))}</b> on your payroll, waiting for a cause.</span></div>` : ''}
      ${charityExplain(retired)}
      ${charityCards(state.me.user.charity_id)}
      <button type="button" class="linkish ch-request" data-request-charity>Don't see yours? Request a charity</button>
      <div class="ch-go"><button type="button" class="btn primary wide" id="charity-go" disabled>Choose a charity above</button></div>`;
    let picked = null;
    wireCharityCards($('#charity-body'), (c) => { picked = c; const b = $('#charity-go'); b.disabled = false; b.textContent = `Lobby for ${c.name}`; });
    wireRequestLinks($('#charity-body'));
    $('#charity-go').onclick = async () => {
      if (!picked) return;
      const b = $('#charity-go'); b.disabled = true; b.textContent = 'Signing them up…';
      try {
        const r = await chooseCharity(picked.id);
        await softClose(dlg);
        toast(r.moved > 0 ? `${lobby(r.moved)} now lobby for ${r.charity.name}. New hires go there too.` : `New lobbyists will lobby for ${r.charity.name}.`, 4200);
        renderToday();
      } catch (e) { toast(e.message, 4000); b.disabled = false; b.textContent = `Lobby for ${picked.name}`; }
    };
    if (auto) { try { sessionStorage.setItem('trickledown.charity-asked', '1'); } catch (e) { /* fine */ } }
    dlg.showModal();
  }

  // Lobbyists and no charity: ask, once a session on its own, and the to-do
  // line keeps asking. Never on top of a gift or another sheet.
  function maybeCharityChooser(me) {
    if (!me.needs_charity) return;
    try { if (sessionStorage.getItem('trickledown.charity-asked')) return; } catch (e) { /* ask anyway */ }
    setTimeout(() => {
      if (!state.me || !state.me.needs_charity || $('dialog[open]') || $('.ach-peek') || unclaimedKeys(state.me).length || Explainer.isOpen()) return;
      if (state.tab !== 'today') return;
      openCharityChooser({ auto: true });
    }, REDUCED ? 600 : 1800);
  }

  function openCharityRequest() {
    const dlg = $('#dlg-request');
    ['#rq-name', '#rq-url', '#rq-reason'].forEach((sel) => { $(sel).value = ''; });
    $('#rq-error').hidden = true;
    const btn = $('#rq-submit'); btn.disabled = false; btn.textContent = 'Send request';
    const prev = $('dialog[open]');
    if (prev && prev !== dlg) prev.close();
    dlg.showModal();
    setTimeout(() => $('#rq-name').focus(), 50);
  }
  async function submitCharityRequest(ev) {
    ev.preventDefault();
    const name = $('#rq-name').value.trim(), url = $('#rq-url').value.trim(), reason = $('#rq-reason').value.trim();
    const err = $('#rq-error');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    if (name.length < 2) return fail("What's the charity called?");
    if (!/^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(url)) return fail("Add the charity's website, like example.org.");
    const btn = $('#rq-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await API.post('/charity-requests', { name, url, reason });
      await softClose($('#dlg-request'));
      toast(`Thanks. ${name} is on the list to check out.`, 4200);
    } catch (e) { fail(e.message); btn.disabled = false; btn.textContent = 'Send request'; }
  }

  // ☰ → Report a bug: an interstitial with the page they were on attached.
  function openBugReport() {
    const dlg = $('#dlg-bug');
    $('#bug-desc').value = '';
    $('#bug-url').textContent = location.href;
    $('#bug-url-on').checked = true;
    $('#bug-error').hidden = true;
    const btn = $('#bug-submit'); btn.disabled = false; btn.textContent = 'Send report';
    dlg.dataset.url = location.href;
    dlg.showModal();
    setTimeout(() => $('#bug-desc').focus(), 50);
  }
  async function submitBug(ev) {
    ev.preventDefault();
    const dlg = $('#dlg-bug');
    const description = $('#bug-desc').value.trim();
    const err = $('#bug-error');
    if (description.length < 4) { err.textContent = 'Say a few words about what went wrong.'; err.hidden = false; return; }
    const client = [`build ${BUILD || 'dev'}`, `${innerWidth}×${innerHeight}`, window.Theme ? Theme.current() : '', navigator.userAgent.slice(0, 200)].filter(Boolean).join(' · ');
    const btn = $('#bug-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await API.post('/bugs', { description, url: $('#bug-url-on').checked ? dlg.dataset.url : '', client });
      await softClose(dlg);
      toast('Thanks. Bug report sent.', 3600);
    } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send report'; }
  }

  // --- admin -----------------------------------------------------------------------------------------
  // Everything, for ADMIN_USERNAMES only (the server checks; this page just
  // asks): every transaction in order, every open position, every player, and
  // the charity requests and bug reports waiting to be read.
  const admin = { tab: 'tx', tx: [], txMore: false, who: '', users: null, sort: 'last_seen_at', dir: -1, sel: new Set() };
  const when = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso), today = d.toDateString() === new Date().toDateString();
    return d.toLocaleString('en-US', today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const sMoney = (n) => (n == null ? '' : n < 0 ? minus(-n) : n > 0 ? `+${money(n)}` : money(0));
  const TX_LABEL = { buy: 'Buy', ride: 'Ride', rolled: 'Rolled into a ride', sell: 'Sold early', collect: 'Collected', bust: 'Busted', gift: 'Gift', vested: 'Vested', allowance: 'Allowance', card: 'Card', build: 'Built', upgrade: 'Upgrade', cat: 'Cat', 'admin grant': 'Admin grant', 'admin undo': 'Admin undo', 'admin remove': 'Admin remove', assign: 'Lobbyists' };

  async function loadAdmin(tab) {
    const el = $('#screen-admin');
    if (!state.me || !state.me.user.is_admin) { el.innerHTML = `${backLink()}<h1>Admin</h1><p class="lede">Admins only.</p>`; return; }
    if (tab) admin.tab = tab;
    el.innerHTML = `${backLink()}<h1>Admin</h1><div id="adm-overview" class="adm-stats"></div>
      <div class="scope-toggle adm-tabs" role="tablist">${[['tx', 'Transactions'], ['pos', 'Positions'], ['users', 'Players'], ['req', 'Requests'], ['fest', 'Lobbyfests'], ['events', 'Events']].map(([k, label]) => `<button type="button" class="chip ${admin.tab === k ? 'on' : ''}" role="tab" aria-selected="${admin.tab === k}" data-adm-tab="${k}">${label}<span class="adm-badge" data-adm-badge="${k}"></span></button>`).join('')}</div>
      <div id="adm-body" class="adm-body"><p class="muted">Loading…</p></div>`;
    $$('[data-adm-tab]', el).forEach((b) => { b.onclick = () => loadAdmin(b.dataset.admTab); });
    adminOverview();
    try {
      if (admin.tab === 'tx') await adminTx(true);
      if (admin.tab === 'pos') await adminPositions();
      if (admin.tab === 'users') await adminUsers();
      if (admin.tab === 'req') await adminRequests();
      if (admin.tab === 'fest') await adminFests();
      if (admin.tab === 'events') await adminEvents();
    } catch (e) { $('#adm-body').innerHTML = `<p class="note warn">${esc(e.message)}</p>`; }
  }

  function adminOverview() {
    API.get('/admin/overview').then((o) => {
      const el = $('#adm-overview'); if (!el) return;
      el.innerHTML = [['Players', o.users, `${o.guests} guests`], ['Active today', o.active_today, 'last 24 hours'], ['Open positions', o.open_positions, ''], ['Lobbyists', lobbyN(o.quarter_lobbyists), 'this quarter']]
        .map(([k, v, sub]) => `<div><b>${esc(String(v))}</b><span>${esc(k)}${sub ? `<br><small>${esc(sub)}</small>` : ''}</span></div>`).join('');
      const n = o.new_requests + o.new_bugs; const badge = $('[data-adm-badge="req"]');
      if (badge) badge.textContent = n || '';
    }).catch(() => {});
  }

  async function adminTx(reset) {
    const body = $('#adm-body');
    if (reset) { admin.tx = []; admin.txMore = false; admin.txCursor = null; }
    const q = new URLSearchParams({ limit: '150' });
    if (!reset && admin.txCursor) q.set('cursor', admin.txCursor);
    if (admin.who) q.set('username', admin.who);
    const r = await API.get(`/admin/transactions?${q}`);
    admin.tx = admin.tx.concat(r.transactions); admin.txMore = r.more && !!r.cursor; admin.txCursor = r.cursor || null;
    const detail = (t) => [
      t.kind === 'buy' || t.kind === 'ride' ? `${money(t.amount)} in${t.note ? `, ${esc(t.note)}` : ''}` : '',
      t.profit != null ? `profit ${sMoney(t.profit)}` : '', t.tax ? `tax ${minus(t.tax)}` : '',
      t.lobbyists ? `${esc(lobbyN(t.lobbyists))} lobbyists${t.charity ? ` → ${esc(t.charity)}` : ''}` : '',
      !['buy', 'ride'].includes(t.kind) && t.note ? esc(t.note) : '',
    ].filter(Boolean).join(' · ');
    body.innerHTML = `
      <form class="adm-filter" id="adm-who"><input type="text" id="adm-who-in" placeholder="Filter by player" value="${esc(admin.who)}" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn small" type="submit">Filter</button>${admin.who ? '<button class="linkish" type="button" id="adm-who-clear">Clear</button>' : ''}</form>
      ${admin.tx.length ? `<div class="adm-scroll"><table class="adm-table">
        <thead><tr><th>Player · when</th><th>What</th><th class="num">Cash</th><th>Detail</th><th><span class="sr">Delete</span></th></tr></thead>
        <tbody>${admin.tx.map((t) => `<tr class="k-${esc(t.kind.replace(/\s+/g, '-'))}">
          <td class="adm-who">${playerLink(t.username)}<small>${esc(when(t.at))}</small></td>
          <td class="nowrap"><span class="adm-kind">${esc(TX_LABEL[t.kind] || t.kind)}</span>${t.what ? ` <b>${esc(t.what)}</b>` : ''}</td>
          <td class="num nowrap ${t.cash > 0 ? 'up' : t.cash < 0 ? 'down' : ''}">${t.cash == null ? '<span class="muted">—</span>' : sMoney(t.cash)}</td>
          <td class="adm-detail">${detail(t)}</td>
          <td class="adm-act">${t.undoable && t.ref ? `<button type="button" class="adm-del" data-undo="${esc(t.ref)}" aria-label="Delete this ${esc(TX_LABEL[t.kind] || t.kind)} for ${esc(t.username)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No transactions yet.</p>'}
      ${admin.txMore ? '<button type="button" class="btn quiet small" id="adm-more">Load older</button>' : ''}`;
    $('#adm-who').onsubmit = (e) => { e.preventDefault(); admin.who = $('#adm-who-in').value.trim(); adminTx(true).catch((er) => toast(er.message)); };
    const clr = $('#adm-who-clear'); if (clr) clr.onclick = () => { admin.who = ''; adminTx(true).catch((er) => toast(er.message)); };
    const more = $('#adm-more'); if (more) more.onclick = () => { more.disabled = true; adminTx(false).catch((er) => toast(er.message)); };
    $$('[data-undo]', body).forEach((b) => { b.onclick = () => adminUndo(b.dataset.undo).catch((er) => toast(er.message)); });
  }

  async function adminPositions() {
    const r = await API.get('/admin/positions');
    $('#adm-body').innerHTML = r.positions.length ? `<p class="muted small">${r.positions.length} open. Values use the last price the server saw; no fresh lookups.</p>
      <div class="adm-scroll"><table class="adm-table">
        <thead><tr><th>Player</th><th>Stock</th><th class="num">In</th><th class="num">Now</th><th class="num">Swing</th><th>×</th><th>Status</th><th>Matures</th></tr></thead>
        <tbody>${r.positions.map((p) => `<tr>
          <td>${playerLink(p.username)}</td><td><b>${esc(p.symbol)}</b>${p.ride_count ? ` <span class="tag">ride ${p.ride_count}</span>` : ''}</td>
          <td class="num">${money(p.invested)}</td><td class="num">${p.value == null ? '<span class="muted">?</span>' : money(p.value)}</td>
          <td class="num ${p.swing_pct > 0 ? 'up' : p.swing_pct < 0 ? 'down' : ''}">${p.swing_pct == null ? '' : pct(p.swing_pct, 0)}</td>
          <td>${esc(mult(p.multiplier))}</td><td>${esc(p.status)}</td><td class="nowrap">${esc(when(p.matures_at))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No open positions.</p>';
  }

  const USER_COLS = [
    ['username', 'Player'], ['last_seen_at', 'Last seen'], ['cash', 'Cash'], ['lobbyists', 'Lobbyists'], ['quarter_lobbyists', 'This qtr'],
    ['open_positions', 'Open'], ['total_positions', 'Positions'], ['cards_played', 'Cards'], ['buildings', 'Built'], ['achievements', 'Trophies'],
    ['friends', 'Friends'], ['streak', 'Streak'], ['realized_pnl', 'P&L'], ['charity', 'Charity'], ['cat', 'Cat'], ['created_at', 'Joined'],
  ];
  async function adminUsers() {
    if (!admin.users) admin.users = (await API.get('/admin/users')).users;
    const rows = [...admin.users].sort((a, b) => {
      const x = a[admin.sort], y = b[admin.sort];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * admin.dir;
    });
    const cell = (u, k) => {
      const v = u[k];
      if (k === 'username') return `${playerLink(u.username)}${u.is_guest ? ' <span class="tag">guest</span>' : ''}${u.is_admin ? ' <span class="tag">admin</span>' : ''}
        <div class="adm-acts"><button type="button" class="linkish" data-lob="${esc(u.username)}">Lobbyists</button>${u.is_admin ? '' : ` · <button type="button" class="linkish adm-rm" data-rm="${esc(u.username)}">Remove</button>`}</div>`;
      if (k === 'last_seen_at' || k === 'created_at') return esc(when(v));
      if (k === 'cash') return money(v);
      if (k === 'realized_pnl') return `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${sMoney(v)}</span>`;
      if (k === 'lobbyists' || k === 'quarter_lobbyists') return esc(lobbyN(v));
      return v == null ? '<span class="muted">—</span>' : esc(String(v));
    };
    admin.sel = new Set([...admin.sel].filter((n) => admin.users.some((u) => u.username === n && !u.is_admin)));
    $('#adm-body').innerHTML = `<p class="muted small">${rows.length} players. Tap a column to sort; tick players to remove several at once.</p>
      <div class="adm-selbar" ${admin.sel.size ? '' : 'hidden'}><b id="adm-sel-n">${admin.sel.size} selected</b><button type="button" class="btn small danger" id="adm-rm-sel">Remove…</button><button type="button" class="linkish" id="adm-sel-clear">Clear</button></div>
      <div class="adm-scroll"><table class="adm-table adm-users">
        <thead><tr><th class="adm-check"><input type="checkbox" id="adm-sel-all" aria-label="Select every player shown (not admins)"></th>${USER_COLS.map(([k, label]) => `<th><button type="button" class="adm-sort ${admin.sort === k ? 'on' : ''}" data-sort="${k}">${label}${admin.sort === k ? (admin.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${rows.map((u) => `<tr class="${admin.sel.has(u.username) ? 'sel' : ''}"><td class="adm-check">${u.is_admin ? '' : `<input type="checkbox" data-sel="${esc(u.username)}" ${admin.sel.has(u.username) ? 'checked' : ''} aria-label="Select ${esc(u.username)}">`}</td>${USER_COLS.map(([k]) => `<td class="${['username', 'charity', 'cat'].includes(k) ? '' : 'num'} nowrap">${cell(u, k)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <button type="button" class="linkish" id="adm-users-refresh">Refresh</button>`;
    $$('[data-sort]').forEach((b) => { b.onclick = () => { const k = b.dataset.sort; if (admin.sort === k) admin.dir = -admin.dir; else { admin.sort = k; admin.dir = ['username', 'charity', 'cat'].includes(k) ? 1 : -1; } adminUsers(); }; });
    $('#adm-users-refresh').onclick = () => { admin.users = null; adminUsers().catch((e) => toast(e.message)); };
    const paintSel = () => {
      $('.adm-selbar').hidden = !admin.sel.size; $('#adm-sel-n').textContent = `${admin.sel.size} selected`;
      $$('[data-sel]').forEach((c) => { c.closest('tr').classList.toggle('sel', c.checked); });
    };
    $$('[data-sel]').forEach((c) => { c.onchange = () => { if (c.checked) admin.sel.add(c.dataset.sel); else admin.sel.delete(c.dataset.sel); paintSel(); }; });
    $('#adm-sel-all').onchange = (e) => { $$('[data-sel]').forEach((c) => { c.checked = e.target.checked; if (c.checked) admin.sel.add(c.dataset.sel); else admin.sel.delete(c.dataset.sel); }); paintSel(); };
    $('#adm-sel-clear').onclick = () => { admin.sel.clear(); $('#adm-sel-all').checked = false; $$('[data-sel]').forEach((c) => { c.checked = false; }); paintSel(); };
    $('#adm-rm-sel').onclick = () => adminRemove([...admin.sel]).catch((e) => toast(e.message));
    $$('[data-rm]').forEach((b) => { b.onclick = () => adminRemove([b.dataset.rm]).catch((e) => toast(e.message)); });
    $$('[data-lob]').forEach((b) => { b.onclick = () => adminLobbyists(b.dataset.lob).catch((e) => toast(e.message)); });
  }

  // --- admin clean-up: delete a transaction, remove lobbyists, remove accounts ---
  // Every one asks the server for a dry run first, so the sheet says exactly
  // what will change. Undo and lobbyists take two taps; removing accounts
  // (which can't be undone at all) takes typing the name, or the count.
  function admSheet({ title, html, go, typeWord = null, arm = false, onGo, wire }) {
    const d = $('#dlg-adm'), err = $('#adm-error'), btn = $('#adm-go');
    $('#adm-title').textContent = title;
    $('#adm-sheet-body').innerHTML = html + (typeWord ? `<label class="field adm-type"><span>Type <b>${esc(typeWord)}</b> to confirm</span><input type="text" id="adm-type-in" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></label>` : '');
    err.hidden = true;
    const typed = $('#adm-type-in');
    const ui = {
      label: go, enabled: !typeWord, armed: false,
      set(label, enabled) { ui.label = label; ui.enabled = enabled; ui.armed = false; ui.paint(); },
      paint() {
        btn.textContent = ui.armed ? `Yes, ${ui.label.charAt(0).toLowerCase()}${ui.label.slice(1)}` : ui.label;
        btn.disabled = !ui.enabled; btn.classList.toggle('armed', ui.armed);
      },
    };
    ui.paint();
    if (typed) typed.oninput = () => { ui.enabled = typed.value.trim().toLowerCase() === typeWord.toLowerCase(); err.hidden = true; ui.paint(); };
    btn.onclick = async () => {
      if (!ui.enabled || btn.dataset.busy) return;
      if (arm && !ui.armed) { ui.armed = true; ui.paint(); return; }
      btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = 'Working…';
      try { await onGo(typed ? typed.value.trim() : null); d.close(); }
      catch (e) { err.textContent = e.message; err.hidden = false; ui.armed = false; ui.paint(); }
      finally { delete btn.dataset.busy; }
    };
    if (wire) wire($('#adm-sheet-body'), ui);
    if (!d.open) d.showModal();
    if (typed) setTimeout(() => typed.focus(), 80);
  }

  // After a clean-up: fresh numbers on top, a fresh player list next time, and
  // a fresh /me if the admin just changed their own account.
  function afterAdminChange(username) {
    adminOverview();
    admin.users = null;
    if (state.me && username === state.me.user.username) API.get('/me').then((me) => { state.me = me; renderToday(); }).catch(() => {});
  }

  async function adminUndo(ref) {
    const r = await API.post('/admin/transactions/undo', { ref, dry_run: true });
    const kindWord = (i) => (i.kind === 'gift' || i.kind === 'vested' ? 'Gift' : i.kind === 'ride' ? 'Ride' : 'Buy');
    const fate = (i) => (i.status === 'open' ? 'still open' : i.status === 'rolled' ? 'rode on' : i.status === 'closed' ? `paid out ${money(Math.max(0, (i.proceeds || 0) - (i.tax || 0)))}` : `paid ${money(Math.max(0, (i.proceeds || 0) - (i.tax || 0)))}`);
    const short = Math.abs(r.cash - r.cash_wanted) > 0.004;
    const effects = [
      `<li>Cash <b>${r.cash ? esc(sMoney(r.cash)) : 'unchanged'}</b>${short ? ` <span class="muted">(${esc(sMoney(r.cash_wanted))} by the numbers, but they have ${esc(money(r.cash_before))} and cash stops at $0)</span>` : ''}</li>`,
      r.lobbyists ? `<li>Lobbyists <b>${esc(lobbyN(r.lobbyists))}</b> <span class="muted">(off the payroll and the all-time count)</span></li>` : '',
      r.pnl ? `<li>P&amp;L <b>${esc(sMoney(r.pnl))}</b></li>` : '',
      r.reopened && r.reopened.length ? '<li>The gift goes back to unclaimed, so they can claim it again</li>' : '',
    ].filter(Boolean).join('');
    admSheet({
      title: 'Delete this transaction?',
      html: `<p><b>${esc(r.username)}</b> · ${esc(r.label)}</p>
        ${r.items.length > 1 ? '<p class="muted small">A ride only exists on top of the one before it, so the whole chain goes:</p>' : ''}
        ${r.items.length ? `<ul class="adm-chain">${r.items.map((i) => `<li><span class="adm-kind">${kindWord(i)}</span> <b>${esc(i.what)}</b> ${i.invested ? `${esc(money(i.invested))} ${esc(mult(i.multiplier))} ` : ''}<span class="muted">· ${esc(fate(i))}</span></li>`).join('')}</ul>` : ''}
        ${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}
        <p class="adm-eff-h">What changes for ${esc(r.username)}</p>
        <ul class="adm-effects">${effects}</ul>
        <p class="muted small">It leaves the feed; an “Admin undo” line records what changed and who did it.</p>`,
      go: 'Delete and undo', arm: true,
      onGo: async () => {
        const done = await API.post('/admin/transactions/undo', { ref });
        const bits = [done.cash ? `cash ${sMoney(done.cash)}` : '', done.lobbyists ? `${lobbyN(done.lobbyists)} lobbyists` : ''].filter(Boolean).join(', ');
        toast(`Deleted. ${done.username}${bits ? `: ${bits}` : ''}.`, 3600);
        afterAdminChange(done.username);
        adminTx(true).catch((e) => toast(e.message));
      },
    });
  }

  async function adminLobbyists(name) {
    const r = await API.get(`/admin/lobbyists?username=${encodeURIComponent(name)}`);
    const list = r.donations_by_charity;
    const total = round2(list.reduce((s, c) => s + c.amount, 0));
    admSheet({
      title: `${r.username}'s lobbyists`,
      html: list.length ? `<p>This quarter they have <b>${esc(lobby(total))}</b> on the payroll (${esc(lobbyN(r.total_donated))} hired all-time). How many should go?</p>
        <ul class="adm-lob">${list.map((c) => `<li>
          <span class="adm-lob-name"><b>${esc(c.name)}</b><small>${esc(lobbyN(c.amount))} now${c.active === false ? ' · retired' : ''}</small></span>
          <input type="number" inputmode="decimal" min="0" max="${c.amount}" step="any" value="0" data-take="${c.id}" data-max="${c.amount}" aria-label="Lobbyists to remove from ${esc(c.name)}">
          <button type="button" class="linkish" data-take-all="${c.id}">All</button></li>`).join('')}</ul>
        ${list.length > 1 ? '<button type="button" class="linkish" id="adm-take-every">All of them, everywhere</button>' : ''}
        <p class="muted small">Removed lobbyists are gone, not moved: off this quarter's Lobbyfest count and their all-time total. An “Admin remove” line records it.</p>`
        : `<p>${esc(r.username)} has no lobbyists on this quarter's payroll.</p>`,
      go: 'Remove lobbyists', arm: true,
      wire: (body, ui) => {
        const amounts = () => $$('[data-take]', body).map((i) => ({ charity_id: Number(i.dataset.take), amount: round2(Math.min(Number(i.dataset.max), Math.max(0, Number(i.value) || 0))) }));
        const paint = () => { const n = round2(amounts().reduce((s, t) => s + t.amount, 0)); ui.set(n > 0 ? `Remove ${lobby(n)}` : 'Remove lobbyists', n > 0); };
        $$('[data-take]', body).forEach((i) => { i.oninput = paint; });
        $$('[data-take-all]', body).forEach((b) => { b.onclick = () => { const i = $(`[data-take="${b.dataset.takeAll}"]`, body); i.value = i.dataset.max; paint(); }; });
        const every = $('#adm-take-every', body); if (every) every.onclick = () => { $$('[data-take]', body).forEach((i) => { i.value = i.dataset.max; }); paint(); };
        paint();
        ui.amounts = amounts;
      },
      onGo: async () => {
        const take = $$('#adm-sheet-body [data-take]').map((i) => ({ charity_id: Number(i.dataset.take), amount: round2(Math.min(Number(i.dataset.max), Math.max(0, Number(i.value) || 0))) })).filter((t) => t.amount > 0);
        const done = await API.post('/admin/lobbyists/remove', { username: r.username, take });
        toast(`Removed ${lobby(done.removed)} from ${done.username}.`, 3200);
        afterAdminChange(done.username);
        if (admin.tab === 'users') adminUsers().catch((e) => toast(e.message));
      },
    });
  }

  async function adminRemove(names) {
    if (!names.length) return;
    const r = await API.post('/admin/users/remove', { usernames: names, dry_run: true });
    const n = r.users.length;
    const qtr = round2(r.users.reduce((s, u) => s + (u.quarter_lobbyists || 0), 0));
    admSheet({
      title: n === 1 ? `Remove ${r.users[0].username}?` : `Remove ${n} players?`,
      html: `<p>Everything of theirs goes: positions, lobbyists, town and cat, friends (their list, and their place on other people's), and wall posts. Their charity requests and bug reports stay, unsigned. <b>This can't be undone.</b></p>
        <ul class="adm-rmlist">${r.users.slice(0, 30).map((u) => `<li><b>${esc(u.username)}</b>${u.is_guest ? ' <span class="tag">guest</span>' : ''}<small>${esc(money(u.cash))} · ${esc(lobbyN(u.lobbyists))} lobbyists · ${u.positions} position${u.positions === 1 ? '' : 's'}${u.followers ? ` · followed by ${u.followers}` : ''}</small></li>`).join('')}${n > 30 ? `<li class="muted">and ${n - 30} more</li>` : ''}</ul>
        ${qtr > 0 ? `<p class="muted small">${esc(lobby(qtr))} leave this quarter's Lobbyfest count.</p>` : ''}`,
      typeWord: r.confirm_with, go: n === 1 ? 'Remove for good' : `Remove ${n} for good`,
      onGo: async (typed) => {
        const done = await API.post('/admin/users/remove', { usernames: names, confirm: typed });
        toast(`Removed ${done.removed} account${done.removed === 1 ? '' : 's'}.`, 3200);
        admin.sel.clear();
        afterAdminChange(null);
        if (admin.tab === 'users') adminUsers().catch((e) => toast(e.message));
      },
    });
  }

  // Lobbyfests: enter what went out each quarter (Past Lobbyfests shows it).
  const prevQuarter = () => { const d = new Date(); const q = Math.floor(d.getMonth() / 3); return q === 0 ? `${d.getFullYear() - 1}-Q4` : `${d.getFullYear()}-Q${q}`; };
  async function adminFests() {
    const body = $('#adm-body');
    await ensureCharities();
    const { lobbyfests: list = [] } = await API.get('/lobbyfests');
    const row = (c) => `<tr data-fest-row="${c.id}"><td>${esc(c.name)}</td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-f="lobbyists" aria-label="Lobbyists for ${esc(c.name)}"></td><td><input type="number" min="0" step="0.01" inputmode="decimal" data-f="usd" aria-label="Dollars to ${esc(c.name)}"></td></tr>`;
    body.innerHTML = `
      <form class="adm-fest" id="adm-fest-form" autocomplete="off">
        <h3>Enter a Lobbyfest</h3>
        <p class="muted small">Entering a quarter that's already here replaces it. Real dollars, not play money. Rows left at zero are skipped.</p>
        <div class="adm-fest-grid">
          <label class="field"><span>Quarter</span><input id="af-quarter" value="${esc(prevQuarter())}" pattern="\\d{4}-Q[1-4]" required></label>
          <label class="field"><span>Paid on</span><input id="af-paid" type="date"></label>
          <label class="field"><span>Pot ($)</span><input id="af-pot" type="number" min="0" step="0.01" inputmode="decimal" required></label>
          <label class="field"><span>Receipt link</span><input id="af-receipt" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://…"></label>
        </div>
        <label class="field"><span>Notes</span><input id="af-notes" maxlength="1000" placeholder="Anything worth saying, like a rollover"></label>
        <button type="button" class="linkish" id="af-fill">Fill from this quarter's standings</button>
        <div class="adm-scroll"><table class="adm-table adm-fest-table"><thead><tr><th>Charity</th><th>Lobbyists</th><th>Dollars</th></tr></thead><tbody>${state.charities.map(row).join('')}</tbody></table></div>
        <p class="form-error" id="af-error" hidden></p>
        <button type="submit" class="btn primary">Save this Lobbyfest</button>
      </form>
      <h3>Entered</h3>
      ${list.length ? `<ul class="adm-list">${list.map((f) => `<li><b>${esc(f.quarter)}</b> · ${usd(f.pot)} · ${(f.payouts || []).length} charities${f.receipt_url ? ' · receipt' : ''} <button type="button" class="linkish danger-link" data-fest-del="${esc(f.quarter)}">Delete</button></li>`).join('')}</ul>` : '<p class="muted">None yet. The first is January 1, 2027.</p>'}`;
    $('#af-fill').onclick = async () => {
      try {
        const t = await API.get('/trickle');
        for (const c of t.charities) {
          const tr = $(`[data-fest-row="${c.id}"]`); if (!tr) continue;
          $('[data-f="lobbyists"]', tr).value = c.quarter_total ? round2(c.quarter_total) : '';
          $('[data-f="usd"]', tr).value = c.est_usd ? c.est_usd : '';
        }
        $('#af-pot').value = t.payout_usd || '';
      } catch (e) { toast(e.message, 4000); }
    };
    $('#adm-fest-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('#af-error'); err.hidden = true;
      const payouts = $$('[data-fest-row]').map((tr) => ({ charity_id: Number(tr.dataset.festRow), lobbyists: Number($('[data-f="lobbyists"]', tr).value || 0), usd: Number($('[data-f="usd"]', tr).value || 0) })).filter((x) => x.lobbyists > 0 || x.usd > 0);
      try {
        await API.post('/admin/lobbyfests', { quarter: $('#af-quarter').value.trim(), paid_at: $('#af-paid').value, pot: Number($('#af-pot').value || 0), receipt_url: $('#af-receipt').value.trim(), notes: $('#af-notes').value.trim(), payouts });
        toast('Saved. It shows on Past Lobbyfests.');
        adminFests();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    $$('[data-fest-del]').forEach((b) => {
      b.onclick = () => admSheet({
        title: `Delete ${b.dataset.festDel}?`, html: '<p>It disappears from Past Lobbyfests. Nothing else changes.</p>', go: 'Delete it', arm: true,
        onGo: async () => { await API.post('/admin/lobbyfests/delete', { quarter: b.dataset.festDel }); toast('Deleted.'); adminFests(); },
      });
    });
  }

  // Events: a featured charity for a week. Lobbyists hired for it count extra.
  async function adminEvents() {
    const body = $('#adm-body');
    await ensureCharities();
    const r = await API.get('/admin/events');
    const today = r.today || new Date().toISOString().slice(0, 10);
    const status = (e) => (e.ends_on < today ? 'over' : e.starts_on > today ? 'upcoming' : 'running');
    body.innerHTML = `
      <form class="adm-fest" id="adm-ev-form" autocomplete="off">
        <h3>Feature a charity</h3>
        <p class="muted small">While it runs, lobbyists hired for that charity (sells, rides, gifts) count extra, and Today and Lobbyfest show a banner. Off unless something's here.</p>
        <label class="field"><span>Charity</span><select id="ae-charity">${state.charities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <div class="adm-fest-grid">
          <label class="field"><span>Starts</span><input id="ae-start" type="date" value="${esc(today)}" required></label>
          <label class="field"><span>Ends</span><input id="ae-end" type="date" value="${esc(isoAdd(today, 6))}" required></label>
          <label class="field"><span>Counts ×</span><input id="ae-mult" type="number" min="1.05" max="3" step="0.05" value="1.25" inputmode="decimal"></label>
          <label class="field"><span>Tag</span><input id="ae-title" maxlength="120" placeholder="Featured charity"></label>
        </div>
        <label class="field"><span>One more line <em class="muted">(optional)</em></span><input id="ae-blurb" maxlength="500"></label>
        <p class="form-error" id="ae-error" hidden></p>
        <button type="submit" class="btn primary">Start it</button>
      </form>
      <h3>Scheduled and past</h3>
      ${(r.events || []).length ? `<ul class="adm-list">${r.events.map((e) => `<li><b>${esc(e.charity_name || '—')}</b> ${multStr(e.multiplier)} · ${esc(e.starts_on)} to ${esc(e.ends_on)} · <em>${status(e)}</em> <button type="button" class="linkish danger-link" data-ev-del="${Number(e.id)}">${status(e) === 'over' ? 'Delete' : 'End it'}</button></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}`;
    $('#adm-ev-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('#ae-error'); err.hidden = true;
      try {
        await API.post('/admin/events', { kind: 'featured_charity', charity_id: Number($('#ae-charity').value), starts_on: $('#ae-start').value, ends_on: $('#ae-end').value, multiplier: Number($('#ae-mult').value || 1.25), title: $('#ae-title').value.trim(), blurb: $('#ae-blurb').value.trim() });
        state.events = null;
        toast('Scheduled.');
        adminEvents();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    $$('[data-ev-del]').forEach((b) => {
      b.onclick = () => admSheet({
        title: 'Remove this event?', html: '<p>The banner goes away and lobbyists count normally from now on. Ones already hired keep their count.</p>', go: 'Remove it', arm: true,
        onGo: async () => { await API.post('/admin/events/delete', { id: Number(b.dataset.evDel) }); state.events = null; toast('Removed.'); adminEvents(); },
      });
    });
  }

  async function adminRequests() {
    const r = await API.get('/admin/requests');
    const link = (url) => (safeHref(url) ? `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>` : esc(url || ''));
    // The "Page" on a bug report is whatever the reporter sent. It's a link only
    // when it points at this game; anything else shows as plain text.
    const ours = (url) => { try { const o = new URL(url).origin; return o === location.origin || o === new URL(SITE_LINK).origin; } catch (e) { return false; } };
    const pageLink = (url) => (ours(url) ? `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : `<span class="adm-plain">${esc(url)}</span>`);
    const actions = (kind, x) => `<div class="adm-actions">${x.status === 'new'
      ? `<button type="button" class="btn small" data-req="${kind}:${x.id}:done">Done</button><button type="button" class="btn small quiet" data-req="${kind}:${x.id}:dismissed">Dismiss</button>`
      : `<span class="tag">${esc(x.status)}</span><button type="button" class="linkish" data-req="${kind}:${x.id}:new">Reopen</button>`}</div>`;
    $('#adm-body').innerHTML = `
      <h2 class="board-h">Charity requests <span class="muted">${r.requests.filter((x) => x.status === 'new').length} new</span></h2>
      ${r.requests.length ? `<ul class="adm-reqs">${r.requests.map((x) => `<li class="${x.status === 'new' ? 'new' : 'old'}">
        <div class="adm-req-top"><b>${esc(x.name)}</b> ${link(x.url)}</div>
        ${x.reason ? `<p class="adm-text">${esc(x.reason)}</p>` : ''}
        <div class="adm-meta">${x.username ? playerLink(x.username) : '<span class="muted">deleted player</span>'} · ${esc(when(x.created_at))}</div>
        ${actions('charity', x)}</li>`).join('')}</ul>` : '<p class="muted">No requests yet.</p>'}
      <h2 class="board-h">Bug reports <span class="muted">${r.bugs.filter((x) => x.status === 'new').length} new</span></h2>
      ${r.bugs.length ? `<ul class="adm-reqs">${r.bugs.map((x) => `<li class="${x.status === 'new' ? 'new' : 'old'}">
        <p class="adm-text">${esc(x.description)}</p>
        ${x.url ? `<div class="adm-meta">Page: ${pageLink(x.url)}</div>` : ''}
        ${x.client ? `<div class="adm-meta adm-client">${esc(x.client)}</div>` : ''}
        <div class="adm-meta">${x.username ? playerLink(x.username) : '<span class="muted">deleted player</span>'} · ${esc(when(x.created_at))}</div>
        ${actions('bug', x)}</li>`).join('')}</ul>` : '<p class="muted">No bug reports yet.</p>'}`;
    $$('[data-req]').forEach((b) => {
      b.onclick = async () => {
        const [kind, id, status] = b.dataset.req.split(':');
        b.disabled = true;
        try { await API.post(`/admin/requests/${kind}/${id}`, { status }); await adminRequests(); } catch (e) { toast(e.message); b.disabled = false; }
      };
    });
  }

  // --- how -----------------------------------------------------------------------------------------

  // --- mission & promises ----------------------------------------------------------------------
  // The one page with no satire. The full promises are the commitment, worded
  // to keep the owners' exact terms; the short version is a summary that
  // defers to them. Change the numbers here only with src/game.js LOBBYFEST.
  const PROMISES_UPDATED = 'October 29, 2026';
  function renderPromises() {
    const demo = !!(state.me && state.me.rules && state.me.rules.demo) || API.demo;
    const back = API.token() ? backLink() : '<a href="#" class="back-link">← Back</a>';
    const promise = (title, ...paras) => `<li><h3>${title}</h3>${paras.map((x) => `<p>${x}</p>`).join('')}</li>`;
    $('#screen-promises').innerHTML = `
      ${back}
      <h1>Mission &amp; promises</h1>
      <p class="promise-nojoke">The one page on this site with no jokes.</p>
      <p class="lede promise-mission"><b>Our mission</b> is to take the fun of day trading, dial it up, and put it to a good cause. Gamifying charity, to benefit us all.</p>
      ${demo ? '<div class="note warn">You\'re in the demo, where the money is pretend. These are the promises for the real game.</div>' : ''}

      <h2 class="promise-h">The short version</h2>
      <ul class="promise-short">
        <li><b>Ads pay charities.</b> Every quarter, this site's ad money goes to charity, split by how many lobbyists each charity has.</li>
        <li><b>At least $100, every time.</b> If the ads earn less than $100 by Lobbyfest, we make up the difference.</li>
        <li><b>Receipts within 60 days.</b> Proof of the donations is posted here.</li>
        <li><b>Nothing for running the site</b> while it earns $200 a quarter or less. Processing fees, and anything else that has to come out, are posted with the receipts.</li>
        <li><b>Everyone starts fresh.</b> Lobbyists reset every quarter, buildings stay, and a wealth tax brings every fortune down to $500K or less.</li>
        <li><b>Good charities only.</b> Well rated and ethical. We can remove any that aren't, and we'll say so publicly if we do.</li>
      </ul>
      <p class="muted small">That's the gist. The promises below are the actual commitment: if the short version ever seems to say something different, the full promises are what count.</p>

      <h2 class="promise-h">Our promises</h2>
      <ol class="promises">
        ${promise('Every quarter, the ad money goes to charity',
          'All ad revenue goes to charity every three months, at the beginning of each calendar quarter: January 1, April 1, July 1 and October 1. That moment is Lobbyfest.')}
        ${promise('Receipts within 60 days',
          'Proof of donations is posted on this site within 60 days of each Lobbyfest.')}
        ${promise('At least $100, every Lobbyfest',
          'If the total ad revenue to distribute at a Lobbyfest is less than $100, the owners will contribute cash to make sure at least $100 is distributed in total.')}
        ${promise('How the money is split',
          "Ad revenue is divided in proportion to each charity's share of all lobbyists, as long as that charity's share would be at least $5.",
          'If a charity would receive less than $5, it does not receive a donation, and the calculation is run again without its lobbyists. This repeats until every charity receiving a donation gets at least $5.')}
        ${promise('Left-out charities roll over',
          'If a charity is left out because its lobbyists would not bring its share to $5, the lobbyists it had at Lobbyfest are added to its total at the next Lobbyfest. This keeps rolling over until it receives a payment.')}
        ${promise('Lobbyists reset; buildings stay',
          "All players' lobbyists are fully reset after each Lobbyfest. Buildings remain.")}
        ${promise('A wealth tax',
          "Player wealth is also soft-reset after each Lobbyfest. A wealth tax is taken at that time, bringing everyone down to no more than $500K of game money, and the tax increases the more wealth a player has. The exact calculation is at the site owners' discretion.")}
        ${promise('Donations, maybe someday',
          'We may also allow donations in the future, possibly in exchange for cosmetic or vanity items in the game. Donations would be treated as ad revenue for the purposes of this distribution.')}
        ${promise('What comes out of the ad money',
          'We will take no money out of the total ad revenue, except what is required for third-party processing or other needs as judged required. Any fees, or any other redirection of ad money, will be posted openly when the receipts are shared, no more than 60 days after Lobbyfest.',
          'This policy of taking no administrative costs from ad revenue stays in effect unless and until earned revenue exceeds $200 per quarter. At that point the owners may decide to begin deducting the true administrative costs of running Trickle Down, including hosting, API usage, backend server and plugin costs, and the like. Any money used this way will be shared openly at that point.')}
        ${promise('Which charities',
          'Money goes to well-rated, ethical charities. If at any point a charity receiving lobbyists supports certain ideological stances, or is of demonstrably suspect status, we reserve the right to remove it from the site. Disqualifying ideological stances include anti-abortion efforts, purely political activities, anti-LGBT actions, anti-trans actions, and other deplorable stances.',
          'If we remove a charity for any of these reasons, we will post it publicly.')}
      </ol>
      <p class="muted small promise-foot">Last updated ${PROMISES_UPDATED}. ${API.token() ? 'See the standings on <a href="#trickle">Lobbyfest &amp; charities</a>.' : ''}</p>`;
  }

  function renderHow() {
    const me = state.me;
    const rules = me ? me.rules : { daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, mult_floor: 1, demo: true, vest_amount: 40 };
    const earned = me ? me.user.badges.earned.map((b) => b.name) : [];
    const badgeList = [
      { at: 1, name: 'Intern' }, { at: 10, name: 'Staffer' }, { at: 50, name: 'Consultant' }, { at: 250, name: 'Lobbyist' },
      { at: 1000, name: 'Fixer' }, { at: 5000, name: 'Kingmaker' }, { at: 25000, name: 'Shadow Cabinet' },
    ];
    const pct = Math.round(rules.tax_rate * 100);
    const h = rules.hold_hours;
    const qa = [
      ['What is this?', `A daily game. You get fake money every morning, invest it in real stocks, and your wins send this site's real ad money to charity. Losing costs you nothing.`],
      ['Who can play?', `Adults: Trickle Down is for players <b>18 and older</b>. Creating an account or playing as a guest means you're confirming you are. It's a game about money, markets and lobbying, with the jokes to match, and it isn't built or moderated for kids.`],
      ['What do I do each day?', `Three things, in about two minutes: <b>collect</b> anything that matured, <b>buy</b> something with the day's money, and <b>play the cards</b> in TrickleTown. The to-do list under your coin keeps track.`],
      ['How much money do I get?', `${money(rules.daily_base, { whole: true })} a day. Each day of your streak adds ${money(rules.streak_bonus, { whole: true })}, up to ${money(rules.daily_cap, { whole: true })}. Miss a day and it drops back to ${money(rules.daily_base, { whole: true })}. Bills you don't spend stay on the coin.`],
      [`What's the ×10?`, `Every buy rides the real market for ${h} hours, and the move is multiplied. It starts at ${mult(rules.mult_floor)} the moment you buy and climbs to ×10 at the ${h}-hour mark (×5 for crypto). The multiplier works on the move, not the money: the stock goes up 1% over the day, you're up 10%; down 1%, down 10%. At ${h} hours it matures and the value freezes. A position can fall to $0; it can't go below.`],
      ['Collect, sell early, or ride?', `<b>Collect</b> a matured position and the money comes back to the coin. <b>Sell early</b> any time at the current, smaller multiplier. <b>Ride</b> a matured winner instead: the profit so far is taxed at half rate (${pct / 2}%), and what's left goes back on the same stock for another ${h} hours with the multiplier climbing higher (×10 to ×20, then ×30). The other half of the tax is due if you sell the ride early, forgiven if you let it mature.`],
      ['What happens when I win?', `Only the gain is taxed, at ${pct}%, never what you put in. Put in $50K, collect $60K: the gain is $10K, so ${money(10 * pct / 100)} is tax and ${money(60 - 10 * pct / 100)} comes back to you. The tax hires <b>lobbyists</b> (about $1K a head; the exact price is set by your town's happiness) for your <b>charity</b>, which you choose when you hire your first lobbyist. Losses aren't taxed.`],
      ['Where does the money go, exactly?', `To the charities, every quarter, with receipts posted here within 60 days. The exact rules, including what (if anything) can come out first, are on <a href="#promises">Mission &amp; promises</a>. It's the one page on the site with no jokes.`],
      ['Which charities?', `Real ones: well-known charities across hunger, health, kids, disaster relief, poverty, water, the environment, animals, housing, education, justice, veterans and mental health, each rated four stars (out of four) by Charity Navigator when we added it. The more lobbyists a charity has at Lobbyfest, the bigger its share of this site's ad money. Don't see yours? <button type="button" class="linkish" data-request-charity>Request a charity</button>; a person checks every request.`],
      ['Found a bug?', `☰ → <b>Report a bug</b>. Say what happened; the page you were on comes along with it, so it's easier to find.`],
      ['What is Lobbyfest?', `Every quarter, at midnight Central as the new quarter begins (January 1, April 1, July 1, October 1), every lobbyist in the game marches off to Lobbyfest. The ad money this site earned goes to the charities, split by headcount: the more lobbyists a charity has, the bigger its share. At least $100 goes out every time; if the ads earned less, we make up the difference. Then everyone's lobbyists reset to zero for the next quarter, and buildings stay. ☰ → Lobbyfest &amp; charities shows the standings; ☰ → <a href="#promises">Mission &amp; promises</a> has the exact rules, including the $5 minimum per charity and the receipts.`],
      ['What is TrickleTown?', `The other side of your coin, where your lobbyists live. It has two scores. <b>Profit</b>: what the town adds to (or takes from) your daily money. <b>Happiness</b>: what each new lobbyist costs you, from $1.4K in a miserable town to $500 in a happy one. Two lots to build on: extractive buildings (a casino, tenements) make profit and unhappiness; decent ones (a clinic, a co-op) cost profit and make people happy. Buildings get upgrade proposals as the town grows. The Company Store takes 20% off anything a card costs.`],
      ['What are the cards?', `Each day Preston (wants profit) and Dolores (wants happiness) bring a few decisions to Town Hall: a headline everyone gets, plus cards your own town has unlocked. Pick a side on each. The arrows show which way a choice pushes; a tag says if it comes back around later. Unplayed cards expire at midnight, and once you've built something, skipping them costs a little happiness. The deck shows every card and what unlocks it.`],
      ['Can I move my lobbyists?', `Yes. TrickleTown → Assign lobbyists moves this quarter's lobbyists between charities and changes where new ones go. Past quarters already marched.`],
      ['What are achievements?', `Rare milestones (your first buy, your first win, a week-long streak, building out the town, a million on the coin). Each comes with a one-time gift from Mommy &amp; Daddy. A gift is all gain, so it's taxed like one and hires lobbyists. After the first week's milestones, a gift is a share of the money you have in play, so it still matters when you're rich. The 🏆 at the top shows how close you are.`],
      ['Profiles, friends and leaderboards?', `Everything besides today's game is in the ☰ menu. Your <b>profile</b> charts how your trading has gone (positions only: gifts and town spending don't count), plus what you're holding, your town, your lobbyists and your trophies. Tap any name on the <b>leaderboards</b> to see theirs. Add <b>friends</b> by username for a board of just them; they get a note with an Add back button. It's one-way until they do, and it's also who can write on your <b>wall</b>: only people you've added.`],
      ['Ranks?', `Ranks count every lobbyist you ever hire, across every Lobbyfest. <span class="badges-inline">${badgeList.map((b) => `<span class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b> ${b.at}</span>`).join('')}</span>`],
      ['Fine print', `<span class="muted">Trickle Down Holdings is a fictional company and a wholly owned subsidiary of Trickle Down Holdings. Prices come from Finnhub and CoinGecko and can be a minute or so behind. Stocks only move while the market is open; crypto never stops. A guest account lives in one browser until you keep it with a password, Google, or a device code. Trickle Down is for players 18 and up. None of the money you play with is real, which is also why nothing here is financial advice.</span>`],
    ];
    $('#screen-how').innerHTML = `
      <h1>How it works</h1>
      <p class="lede">Fake money, real stocks, real charity. The whole game in one sentence: invest, hold ${h} hours, and your wins hire lobbyists for a charity.</p>
      <div class="row-actions" style="margin:6px 0 14px"><button class="btn quiet small" id="btn-orient-how">Replay the training</button>${me && me.town && me.town.unlocked ? '<button class="btn quiet small" id="btn-town-how">Replay the TrickleTown tour</button>' : ''}</div>
      ${rules.demo ? `<div class="note warn">Demo. No real money moves here. The charities are real; the payouts in this copy are pretend.</div>` : ''}
      <div class="faq">${qa.map(([q, a], n) => `<details class="faq-item" ${n === 0 ? 'open' : ''}><summary>${esc(q)}</summary><p>${a}</p></details>`).join('')}</div>`;
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
      (gsi.mounted = gsi.mounted || {})[containerId] = intent;
      window.google.accounts.id.renderButton(target, { theme: window.Theme && Theme.dark() ? 'filled_black' : 'outline', size: 'large', shape: 'pill', width: Math.min(320, target.clientWidth || 320), text: intent === 'link' ? 'continue_with' : 'signin_with' });
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
    // Adults only, wherever an account can be made (Google on Sign in can make one too).
    $('#auth-age').hidden = code;
    $('#auth-age').innerHTML = mode === 'login' ? '<b>18+ only.</b> Trickle Down is for players 18 and older.' : "<b>18+ only.</b> By creating an account, you confirm you're 18 or older.";
    // Anyone setting a password gets the honest version of where security stands.
    $('#auth-beta').hidden = !(mode === 'register' || mode === 'claim');
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
      if (state.authMode === 'register') useInvite();
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
  // Daily reminders (web push). Never asks for permission until the switch is tapped.
  const reminderSection = () => `
      <details class="acct-section" id="acct-remind" hidden>
        <summary>Daily reminder</summary>
        <div id="remind-body"><p class="muted small">Checking…</p></div>
      </details>`;
  const b64ToBytes = (b64) => { const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
  const hourStr = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
  async function wireReminder() {
    const sec = $('#acct-remind'), box = $('#remind-body');
    if (!sec) return;
    let key = null, hour = 17;
    try { const r = await API.get('/push/key'); key = r.key; if (r.hour != null) hour = r.hour; } catch (e) { key = null; }
    if (!key) return; // not set up on this server: no section at all
    sec.hidden = false;
    const say = (html) => { box.innerHTML = `<p class="muted small">${html}</p>`; };
    if (IS_IOS && !isStandalone()) return say(`On iPhone and iPad, reminders only work from the home screen. ${installHow()} Then open it from there and turn this on.`);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return say("This browser can't do reminders.");
    if (Notification.permission === 'denied') return say('Notifications are blocked for this site. Allow them in your browser settings, then come back.');
    let reg = null, sub = null;
    try { reg = await navigator.serviceWorker.getRegistration(); sub = reg ? await reg.pushManager.getSubscription() : null; } catch (e) { sub = null; }
    box.innerHTML = `<label class="admin-switch"><input type="checkbox" id="remind-on" ${sub ? 'checked' : ''}><span><b>Remind me at ${hourStr(hour)}</b><small>One a day, only if you haven't played yet. Your time zone.</small></span></label><p class="form-error" id="remind-error" hidden></p>`;
    const sw = $('#remind-on'), err = $('#remind-error');
    sw.onchange = async () => {
      err.hidden = true; sw.disabled = true;
      try {
        if (sw.checked) {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('No permission, no reminder. Fair.');
          reg = await navigator.serviceWorker.register('sw.js');
          await navigator.serviceWorker.ready;
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
          let tz = null; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = null; }
          await API.post('/push/subscribe', { subscription: sub.toJSON(), tz });
          toast(`Reminder on. ${hourStr(hour)}, your time, on days you haven't shown up.`);
        } else {
          const endpoint = sub ? sub.endpoint : null;
          if (sub) await sub.unsubscribe();
          sub = null;
          await API.post('/push/unsubscribe', endpoint ? { endpoint } : {});
          toast('Reminder off.');
        }
      } catch (e) { sw.checked = !sw.checked; err.textContent = e.message; err.hidden = false; }
      finally { sw.disabled = false; }
    };
  }
  const deviceSection = () => `
      <details class="acct-section" id="acct-device">
        <summary>Use on another device</summary>
        <p class="muted small">Get a code here, then on the other device tap Sign in → “Signed in on another device? Use a code.” It works once and lasts 15 minutes. No password needed.</p>
        <button type="button" class="btn small" id="acct-code-btn">Get a code</button>
        <div class="device-code" id="acct-code" hidden></div>
      </details>`;
  // Testing tools, only for ADMIN_USERNAMES. Every action defaults to your own
  // account; type a player's name to aim it at theirs instead.
  const adminCardOptions = () => {
    const deck = (state.me && state.me.town && state.me.town.deck) || [];
    const label = { today: 'in hand', played: 'played today', available: 'in the pile', locked: 'locked' };
    return [...deck].sort((a, b) => a.title.localeCompare(b.title))
      .map((d) => `<option value="${esc(d.id)}">${esc(d.title)} · ${label[d.status] || d.status}${d.general ? ' · headline' : ''}</option>`).join('');
  };
  const adminSection = (u) => (u.is_admin ? `
      <details class="acct-section admin" id="acct-admin">
        <summary>Admin</summary>
        <p class="muted small">Testing only. Everything here is real: grants land on the boards, resets delete rows.</p>
        <label class="field"><span>Player <em class="muted">(blank = you)</em></span><input id="acct-admin-who" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="${esc(u.username)}"></label>
        <h4 class="admin-h">Grant</h4>
        <form id="acct-grant-form" class="acct-form">
          <label class="field"><span>Cash to add ($K)</span><input id="acct-grant-cash" type="number" min="0" step="1" placeholder="0" inputmode="numeric"></label>
          <label class="field"><span>Lobbyists to add</span><input id="acct-grant-lob" type="number" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
          <button type="submit" class="btn small">Grant</button>
        </form>
        <h4 class="admin-h">Cards</h4>
        <label class="field"><span>Card</span><select id="acct-card">${adminCardOptions()}</select></label>
        <div class="row-actions admin-row">
          <button type="button" class="btn small" id="acct-deal">Deal it today</button>
          <button type="button" class="btn quiet small" id="acct-unlock">Unlock it</button>
        </div>
        <p class="muted small">Deal puts the card on today's agenda now (the town has to be open). Unlock puts it in the pile for future days.</p>
        <label class="admin-switch"><input type="checkbox" id="acct-sw-unlock" disabled><span><b>Unlock every card</b><small>Untick to go back to what the town has earned. Cards already played stay open; unplayed ones that lock again leave today's agenda.</small></span></label>
        <label class="admin-switch"><input type="checkbox" id="acct-sw-deal" disabled><span><b>Deal every unlocked card, every day</b><small>Untick to go back to a normal day's hand. Cards played today stay.</small></span></label>
        <h4 class="admin-h">Start over</h4>
        <p class="muted small">Back to a brand-new account: no positions, lobbyists, town, friends, streak or achievements, $100K at the next load. On your own account this browser also forgets the training and tours, so you get the whole first-day experience again.</p>
        <div class="row-actions"><button type="button" class="btn quiet small danger" id="acct-reset">Reset to brand new</button></div>
      </details>` : '');
  function wireShared() {
    wireReminder();
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
    // Admin: aim at yourself unless a player is named.
    const who = () => { const w = $('#acct-admin-who'); const v = w ? w.value.trim() : ''; return v && v.toLowerCase() !== state.me.user.username.toLowerCase() ? v : ''; };
    const aim = (body) => (who() ? { ...body, username: who() } : body);
    const reload = (opts = {}) => {
      $('#dlg-account').close(); state.me = null;
      if (opts.town) state.flipped = true;
      location.hash = '#today'; route();
    };
    const busy = async (btn, fn) => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } catch (e) { err(e.message); } finally { btn.disabled = false; } };
    const grant = $('#acct-grant-form');
    if (grant) grant.onsubmit = (ev) => {
      ev.preventDefault();
      const cash = Number($('#acct-grant-cash').value) || 0, lobbyists = Number($('#acct-grant-lob').value) || 0;
      busy(grant.querySelector('button'), async () => {
        await API.post('/admin/grant', aim({ cash, lobbyists }));
        toast(`Granted${who() ? ` ${who()}` : ''}: ${cash ? money(cash) : ''}${cash && lobbyists ? ' and ' : ''}${lobbyists ? lobby(lobbyists) : ''}.`);
        reload();
      });
    };
    const card = $('#acct-card');
    const cardName = () => (card && card.selectedOptions[0] ? card.selectedOptions[0].textContent.split(' · ')[0] : 'that card');
    const deal = $('#acct-deal');
    if (deal) deal.onclick = () => busy(deal, async () => {
      await API.post('/admin/deal', aim({ issue_id: card.value }));
      toast(`Dealt “${cardName()}”${who() ? ` to ${who()}` : ''}. It's on today's agenda.`);
      reload({ town: !who() });
    });
    const unlock = $('#acct-unlock');
    if (unlock) unlock.onclick = () => busy(unlock, async () => {
      await API.post('/admin/unlock', aim({ issue_id: card.value }));
      toast(`Unlocked “${cardName()}”${who() ? ` for ${who()}` : ''}. It can be dealt from tomorrow.`);
      reload();
    });
    // The two switches: read for whoever the panel is aimed at, flip on change.
    const swUnlock = $('#acct-sw-unlock'), swDeal = $('#acct-sw-deal');
    const readSwitches = async () => {
      if (!swUnlock) return;
      swUnlock.disabled = swDeal.disabled = true;
      try {
        const r = await API.get(`/admin/switches${who() ? `?username=${encodeURIComponent(who())}` : ''}`);
        swUnlock.checked = !!r.unlock_all; swDeal.checked = !!r.deal_all;
        swUnlock.disabled = swDeal.disabled = false;
      } catch (e) { err(e.message); }
    };
    const flip = (box, key, on, off) => {
      box.onchange = async () => {
        const want = box.checked;
        swUnlock.disabled = swDeal.disabled = true;
        try {
          await API.post('/admin/switches', aim({ [key]: want }));
          toast(`${want ? on : off}${who() ? ` (${who()})` : ''}.`, 4200);
          reload({ town: !who() });
        } catch (e) { box.checked = !want; err(e.message); swUnlock.disabled = swDeal.disabled = false; }
      };
    };
    if (swUnlock) {
      flip(swUnlock, 'unlock_all', 'Every card is unlocked', 'Back to the cards this town has earned. Anything already played stays open');
      flip(swDeal, 'deal_all', 'Every unlocked card is dealt, today and every day', "Back to a normal day's hand. Cards played today stay");
      const whoBox = $('#acct-admin-who'); if (whoBox) whoBox.addEventListener('change', readSwitches);
      readSwitches();
    }
    const reset = $('#acct-reset');
    if (reset) reset.onclick = () => busy(reset, async () => {
      if (reset.dataset.armed !== '1') { reset.dataset.armed = '1'; reset.textContent = who() ? `Tap again to wipe ${who()} back to brand new` : 'Tap again to wipe everything and start over'; return; }
      const target = who();
      const r = await API.post('/admin/reset', aim({}));
      if (r.self === false || target) { toast(`${target} is brand new again. Their own browser still remembers the training they've seen.`); reload(); return; }
      forgetFirstRun();
      toast('Brand new. Welcome to Trickle Down Corp.');
      reload();
    });
  }

  // Everything this browser remembers about having played before, so a reset
  // account replays the training, the first-investment guide, the vesting
  // gift, the first hire and the TrickleTown tour from the top.
  function forgetFirstRun() {
    for (const k of ['trickledown.oriented', 'trickledown.town-intro']) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
    tickerStop();
    Object.assign(state, { flipped: false, oriented: false, ceremony: false, selected: null, quote: null, carve: 0, sell: null });
    state.found.clear();
  }

  async function openAccount() {
    const u = state.me && state.me.user;
    if (!u) return;
    const body = $('#account-body');
    if (u.is_guest) {
      body.innerHTML = `
        <p>You're playing as <b>${esc(u.username)}</b>, a guest. It lives in this browser only.</p>
        <p class="muted">Claim it to keep your coin, your lobbyists and TrickleTown on every device. Trickle Down is for players 18 and older.</p>
        <div class="row-actions"><button type="button" class="btn primary" id="acct-claim">Keep this account</button><button type="button" class="btn quiet" id="acct-signout">Sign out</button></div>
        ${deviceSection()}
        ${reminderSection()}
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
      <p class="muted small">Friends add you by that username; it's the only thing about you they can see. <a href="#friends">Your friends</a>${state.me.friend_count ? ` (${state.me.friend_count})` : ''}.</p>

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
      ${reminderSection()}
      ${adminSection(u)}

      <div class="row-actions" style="margin-top:14px">
        <button type="button" class="btn quiet small" id="acct-signout">Sign out</button>
        <button type="button" class="btn quiet small" id="acct-signout-all">Sign out everywhere</button>
      </div>
      <p class="form-error" id="account-error" hidden></p>`;
    $('#dlg-account').showModal();
    wireShared();
    $$('#account-body a[href="#friends"]').forEach((a) => { a.onclick = () => { $('#dlg-account').close(); }; });
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
    tickerStop();
    API.setToken(null); state.me = null; state.flipped = false;
    if ($('#dlg-account').open) $('#dlg-account').close();
    location.hash = ''; route();
  }

  // --- wiring ----------------------------------------------------------------------------------------

  function wire() {
    $$('[data-close]').forEach((b) => { b.onclick = () => { const d = b.closest('dialog'); if (d.classList.contains('soft')) softClose(d); else d.close(); }; });
    // "Recruit" and "Invite someone", wherever they are: the share sheet.
    document.addEventListener('click', (e) => { const b = e.target.closest('[data-share]'); if (b) { e.preventDefault(); share(); } });
    $('#assign-save').onclick = saveAssign;
    $('#btn-trophies').onclick = openTrophies;
    for (const id of ['#dlg-site', '#dlg-advisors', '#dlg-hire', '#dlg-sell', '#dlg-assign']) { const d = $(id); if (d) d.addEventListener('close', () => maybeAchievement(500)); }
    $('#dlg-advisors').addEventListener('close', () => { adv.result = null; });
    $$('dialog.sheet').forEach((d) => { d.addEventListener('click', (e) => { if (e.target === d) { if (d.classList.contains('soft')) softClose(d); else d.close(); } }); });
    $('#dlg-review').addEventListener('close', afterReviewCloses);
    $('#dlg-digest').addEventListener('close', afterReviewCloses);
    $('#form-sell').addEventListener('submit', submitSell);
    $('#form-auth').addEventListener('submit', submitAuth);
    $('#form-request').addEventListener('submit', submitCharityRequest);
    $('#form-bug').addEventListener('submit', submitBug);
    $('#form-request').addEventListener('input', () => { $('#rq-error').hidden = true; });
    $('#form-bug').addEventListener('input', () => { $('#bug-error').hidden = true; });
    document.addEventListener('click', (e) => { if (e.target.closest('[data-request-charity]') && !e.target.closest('#hire-body, #charity-body')) openCharityRequest(); });
    $('#auth-switch').onclick = () => openAuth(state.authMode === 'login' ? 'register' : 'login');
    $('#auth-code-link').onclick = () => openAuth(state.authMode === 'code' ? 'login' : 'code');
    $('#btn-claim').onclick = () => openAuth('claim');
    $('#btn-account').onclick = openAccount;
    $('#btn-help').onclick = () => Explainer.open({ deck: 'main', rules: state.me ? state.me.rules : undefined, finale: !API.token(), onFinale: welcomeFinale });
    $('#btn-menu').onclick = openMenu;
    document.addEventListener('click', (e) => { if (e.target.closest('[data-cat-open]')) openCat(); });
    $('#dlg-menu').addEventListener('click', (e) => { if (e.target === e.currentTarget) softClose(e.currentTarget); });
    $('#btn-signout').onclick = signOut;
    window.addEventListener('hashchange', route);

    // Keep the clocks honest and the coin fresh while the tab is open, but
    // never yank the carve panel out from under someone mid-slice.
    const carving = () => state.carve > 0 || state.selected || ['carve-usd', 'carve-search'].includes(document.activeElement && document.activeElement.id);
    setInterval(() => {
      if (!state.me) return;
      $('#day-countdown').innerHTML = countdownHtml(state.me.day.resets_at);
      tickTimes();
      if (new Date(state.me.day.resets_at) <= Date.now() && state.tab === 'today' && !carving()) loadMe();
    }, 30_000);
    setInterval(() => {
      if (state.me && state.tab === 'today' && document.visibilityState === 'visible' && !$('#dlg-sell').open && !carving()) loadMe();
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
      // Away ten minutes or more counts as coming back (for the review).
      if (document.visibilityState === 'hidden') { state.awayAt = Date.now(); return; }
      if (state.awayAt && Date.now() - state.awayAt >= 10 * 60e3) state.cameBack = true;
      if (document.visibilityState === 'visible' && state.me && state.tab === 'today' && !carving()) loadMe();
    });
  }

  // GitHub Pages lets a browser reuse index.html for up to ten minutes, so a
  // new release can sit behind an old page. Ask, uncached, which build is
  // live (version.txt); if it's not this one, reload once to pick it up.
  // Never mid-purchase or with a popup open; never twice for the same build.
  function checkBuild() {
    if (!BUILD || API.demo) return;
    fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        const live = text.trim();
        if (!/^[\w.-]{1,40}$/.test(live) || live === BUILD) return;
        if ($('dialog[open]') || state.busy || state.carve > 0 || state.selected) return; // try again next time
        try {
          if (sessionStorage.getItem('trickledown.reloaded-for') === live) return;
          sessionStorage.setItem('trickledown.reloaded-for', live);
        } catch (e) { return; }
        location.reload();
      })
      .catch(() => { /* offline: keep what we have */ });
  }

  // A theme switch repaints through CSS; only Google's button (an iframe
  // drawn once) needs redrawing in its other style.
  if (window.Theme) {
    Theme.onChange(() => {
      Object.entries(gsi.mounted || {}).forEach(([id, intent]) => {
        const slot = $(`#${id}`);
        if (slot && !slot.hidden && slot.isConnected && slot.offsetParent) mountGoogle(id, intent);
      });
    });
  }

  wire();
  route();
  checkBuild();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBuild(); });
})();
