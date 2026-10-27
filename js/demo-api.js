// Demo mode: the whole game against an in-memory fake API. Used when the URL
// has ?demo, or when config.js still points at the placeholder backend. Prices
// wander quickly so the loop is fun to click through. Nothing is saved.
(function () {
  const cfg = window.TRICKLE_CONFIG || {};
  const wantDemo = /[?&]demo\b/.test(location.search) || /YOUR-HEROKU-APP/.test(cfg.API_BASE || '');
  if (!wantDemo) return;

  const ASSETS = [
    ['NVDA', 'Nvidia', 'stock', 'Spicy'], ['TSLA', 'Tesla', 'stock', 'Spicy'], ['AAPL', 'Apple', 'stock', 'Normal'],
    ['MSFT', 'Microsoft', 'stock', 'Calm'], ['AMZN', 'Amazon', 'stock', 'Normal'], ['META', 'Meta', 'stock', 'Normal'],
    ['GME', 'GameStop', 'stock', 'Unhinged'], ['KO', 'Coca-Cola', 'stock', 'Calm'], ['COST', 'Costco', 'stock', 'Calm'],
    ['SPY', 'S&P 500 (ETF)', 'stock', 'Calm'], ['GLD', 'Gold (ETF)', 'stock', 'Calm'], ['PLTR', 'Palantir', 'stock', 'Spicy'],
    ['BTC', 'Bitcoin', 'crypto', 'Spicy'], ['ETH', 'Ethereum', 'crypto', 'Spicy'], ['SOL', 'Solana', 'crypto', 'Unhinged'],
    ['DOGE', 'Dogecoin', 'crypto', 'Unhinged'], ['SHIB', 'Shiba Inu', 'crypto', 'Unhinged'],
  ].map(([symbol, name, type, mood]) => ({ symbol, name, type, mood, multiplier: type === 'crypto' ? 5 : 10 }));

  // Made up on purpose. See src/charities.js in the backend for the same list.
  const CHARITIES = [
    ['Society for Slightly Taller Trees', 'Forestry', "We can't make trees taller. We can make them feel taller."],
    ['Pigeons With Dignity', 'Animals', 'Tiny hats. Big self-esteem.'],
    ['Fund for Ducks Who Are Owed Bread', 'Animals', 'A debt generations in the making.'],
    ['Left Sock Recovery Initiative', 'Household', "They're somewhere. We are going to find them."],
    ['Hold Music Appreciation Trust', 'Arts', 'Someone wrote that. They deserve to know it mattered.'],
    ['Puddle Preservation League', 'Water', 'Every puddle was once a cloud. Thematically appropriate.'],
    ["Lighthouse Keepers' Lunch Program", 'Hunger', "It's a long way down for a sandwich."],
    ['Umbrella Relief Fund for Umbrellas', 'Weather', 'You left it on the train. We take it from here.'],
  ].map(([name, category, blurb], i) => ({ id: i + 1, slug: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, category, blurb, url: '' }));

  const RULES = { tax_rate: 0.25, daily_base: 100, streak_bonus: 10, daily_cap: 200, hold_hours: 24, mult_floor: 1, demo: true };
  const BADGES = [[1, 'Intern'], [10, 'Staffer'], [50, 'Consultant'], [250, 'Lobbyist'], [1000, 'Fixer'], [5000, 'Kingmaker'], [25000, 'Shadow Cabinet']].map(([at, name]) => ({ at, name }));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  function priceOf(a, t = Date.now() / 1000) {
    const seed = hash(a.symbol);
    const base = a.type === 'crypto' ? (seed < 0.5 ? 0.05 + seed : 20 + seed * 90000) : 8 + seed * 600;
    const vol = a.type === 'crypto' ? 0.06 : 0.03;
    const move = vol * (Math.sin(t / 40 + seed * 7) + 0.5 * Math.sin(t / 9 + seed * 3));
    return { price: +(base * (1 + move)).toFixed(base < 1 ? 5 : 2), change_pct: move };
  }
  const find = (s) => ASSETS.find((a) => a.symbol === String(s).toUpperCase());

  // One player, seeded so the screen has something on it.
  const today = new Date().toISOString().slice(0, 10);
  const user = { id: 1, username: 'guest_demo', is_guest: true, cash: 100, total_donated: 7.5, realized_pnl: 22.5, streak: 3, charity_id: 6 };
  let nextId = 10;
  const seedNvda = find('NVDA'), seedDoge = find('DOGE'), seedKo = find('KO');
  const HOLD_MS = RULES.hold_hours * 3600e3;
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const positions = [
    // Live, bought 3h ago, up.
    { id: 1, symbol: 'NVDA', name: 'Nvidia', asset_type: 'stock', multiplier: 10, invested: 50, entry_price: round2(priceOf(seedNvda).price * 0.985), opened_at: ago(3), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS - 3 * 3600e3).toISOString(), status: 'open' },
    // Live, bought 20h ago, down.
    { id: 2, symbol: 'DOGE', name: 'Dogecoin', asset_type: 'crypto', multiplier: 5, invested: 25, entry_price: priceOf(seedDoge).price * 1.012, opened_at: ago(20), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS - 20 * 3600e3).toISOString(), status: 'open' },
    // Matured 2h ago: frozen, ready to collect.
    { id: 5, symbol: 'KO', name: 'Coca-Cola', asset_type: 'stock', multiplier: 10, invested: 20, entry_price: round2(priceOf(seedKo).price * 0.99), opened_at: ago(26), opened_day: '2026-10-26', matures_at: ago(2), matured_at: ago(2), matured_price: priceOf(seedKo).price, status: 'open' },
    { id: 3, symbol: 'TSLA', name: 'Tesla', asset_type: 'stock', multiplier: 10, invested: 40, status: 'closed', proceeds: 58, profit: 18, tax: 4.5, tier: 'Nice', charity_id: 6, collected: true, closed_day: today, closed_at: ago(1) },
    { id: 4, symbol: 'GME', name: 'GameStop', asset_type: 'stock', multiplier: 10, invested: 30, status: 'closed', proceeds: 0, profit: -30, tax: 0, tier: 'Rest in peace', charity_id: null, collected: false, closed_day: '2026-10-26', closed_at: ago(24) },
  ];
  positions[2].matured_value = round2(positions[2].invested * (1 + 10 * (positions[2].matured_price - positions[2].entry_price) / positions[2].entry_price));

  // Freeze anything past maturity at the current price, at the full multiplier
  // (what the server's timer does).
  function settleMatured() {
    for (const p of positions) {
      if (p.status === 'open' && !p.matured_at && new Date(p.matures_at) <= new Date()) {
        p.matured_at = new Date().toISOString(); p.matured_price = priceOf(find(p.symbol)).price;
        p.matured_value = valueOf(p, p.matured_price, new Date(p.matures_at).getTime()).value;
      }
    }
  }
  function shape(p) {
    const matured = !!p.matured_at;
    const price = matured ? p.matured_price : priceOf(find(p.symbol)).price;
    const live = valueOf(p, price, matured ? new Date(p.matures_at).getTime() : Date.now()); if (matured) live.value = p.matured_value;
    return { ...p, matured, seconds_left: matured ? 0 : Math.max(0, Math.round((new Date(p.matures_at) - Date.now()) / 1000)), ride_count: p.ride_count || 0, origin_invested: p.origin_invested != null ? p.origin_invested : p.invested, price, quote_error: false, ...live, preview: settle(p.invested, live.value) };
  }
  const donations = [
    { charity_id: 6, amount: 4.5, user: 'guest_demo' }, { charity_id: 4, amount: 2.1, user: 'guest_demo' }, { charity_id: 1, amount: 0.9, user: 'guest_demo' },
    { charity_id: 1, amount: 61.25, user: 'ravi_k' }, { charity_id: 2, amount: 48, user: 'ravi_k' }, { charity_id: 4, amount: 33.1, user: 'erin' },
    { charity_id: 3, amount: 12.75, user: 'erin' }, { charity_id: 6, amount: 20, user: 'bagholder_ben' }, { charity_id: 8, amount: 9.3, user: 'bagholder_ben' },
    { charity_id: 5, amount: 15.5, user: 'moonshot_mia' }, { charity_id: 7, amount: 2.25, user: 'moonshot_mia' },
  ];
  const otherPlayers = [
    { username: 'ravi_k', donated: 109.25, realized_pnl: 437, streak: 12 }, { username: 'erin', donated: 45.85, realized_pnl: 183.4, streak: 7 },
    { username: 'bagholder_ben', donated: 29.3, realized_pnl: -41, streak: 2 }, { username: 'moonshot_mia', donated: 17.75, realized_pnl: 71, streak: 5 },
  ];

  const badgesFor = (d) => ({ earned: BADGES.filter((b) => d >= b.at), next: BADGES.find((b) => d < b.at) || null });
  const publicUser = () => ({ ...user, badges: badgesFor(user.total_donated) });
  // Multiplier ramps from ×1 at purchase to the full multiplier at maturity.
  const multAt = (p, at = Date.now()) => {
    const o = new Date(p.opened_at).getTime(), m = new Date(p.matures_at).getTime();
    const k = Math.max(0, Math.min(1, (at - o) / Math.max(1, m - o)));
    return 1 + (p.multiplier - 1) * k;
  };
  const valueOf = (p, price, at = Date.now()) => {
    const mult = multAt(p, at);
    const real = (price - p.entry_price) / p.entry_price; const swing = mult * real; const raw = p.invested * (1 + swing);
    return { real_pct: real, swing_pct: Math.max(-1, swing), multiplier_now: Math.round(mult * 100) / 100, value: round2(Math.max(0, raw)), busted: raw <= 0 };
  };
  const tierFor = (inv, v) => { if (v <= 0) return 'Rest in peace'; const p = (v - inv) / inv; return p < 0 ? 'Paper cut' : p < 0.1 ? 'Pocket change' : p < 0.25 ? 'Respectable' : p < 0.5 ? 'Nice' : p < 1 ? 'Heater' : 'Legend'; };
  const settle = (inv, v) => { const profit = round2(v - inv); const tax = profit > 0 ? round2(profit * RULES.tax_rate) : 0; return { profit, tax, net: round2(v - tax), tier: tierFor(inv, v) }; };
  const resetsAt = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.toISOString(); };
  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let get = async function (path) {
    await sleep(120);
    if (path === '/me') {
      settleMatured();
      const open = positions.filter((p) => p.status === 'open').map(shape).sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
      const history = positions.filter((p) => p.status === 'closed').sort((a, b) => b.id - a.id)
        .map((p) => ({ ...p, charity_name: p.charity_id ? CHARITIES.find((c) => c.id === p.charity_id).name : null }));
      const picks = [['NVDA', 'Nvidia', 9], ['BTC', 'Bitcoin', 5], ['TSLA', 'Tesla', 4], ['DOGE', 'Dogecoin', 2], ['GLD', 'Gold (ETF)', 1]]
        .map(([symbol, name, buys]) => ({ symbol, name, buys, invested: buys * 60 }));
      const mine = donations.filter((d) => d.user === user.username);
      const byCharity = CHARITIES.map((c) => ({ id: c.id, name: c.name, slug: c.slug, amount: round2(mine.filter((d) => d.charity_id === c.id).reduce((s, d) => s + d.amount, 0)), times: mine.filter((d) => d.charity_id === c.id).length }))
        .filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
      return {
        user: publicUser(), day: { key: today, number: 12, quarter: '2026-Q4', resets_at: resetsAt(), tz: 'America/Chicago' },
        allowance: null, rules: RULES, positions: open, history, donations_by_charity: byCharity,
        crowd: { picks, buys: 21, players: 9 },
        today_donated: history.filter((h) => h.closed_day === today).reduce((s, h) => s + h.tax, 0),
      };
    }
    if (path === '/assets') return { assets: ASSETS };
    if (path === '/charities') return { charities: CHARITIES };
    if (path === '/config') return { ...RULES, badges: BADGES };
    if (path.startsWith('/quote/')) { const a = find(decodeURIComponent(path.slice(7))); if (!a) fail('Not in the game.', 404); return { symbol: a.symbol, ...priceOf(a), source: 'demo' }; }
    if (path === '/trickle') {
      const totals = CHARITIES.map((c) => { const ds = donations.filter((d) => d.charity_id === c.id); const q = ds.reduce((s, d) => s + d.amount, 0); return { ...c, quarter_total: q, all_time: q + q * 1.8, quarter_donors: new Set(ds.map((d) => d.user)).size }; });
      const qt = totals.reduce((s, c) => s + c.quarter_total, 0); const pool = 140;
      return { quarter: '2026-Q4', demo: true, pool_usd: pool, quarter_total: round2(qt), all_time: round2(totals.reduce((s, c) => s + c.all_time, 0)), quarter_donors: 5,
        charities: totals.map((c) => ({ ...c, share: qt ? c.quarter_total / qt : 0, est_usd: qt ? round2(pool * c.quarter_total / qt) : 0 })).sort((a, b) => b.quarter_total - a.quarter_total) };
    }
    if (path === '/leaderboard') {
      const all_time = [...otherPlayers, { username: user.username, donated: user.total_donated, realized_pnl: user.realized_pnl, streak: user.streak }]
        .filter((r) => r.donated > 0).sort((a, b) => b.donated - a.donated);
      const mine = positions.filter((p) => p.status === 'closed' && p.closed_day === today).map((p) => ({ username: user.username, symbol: p.symbol, invested: p.invested, proceeds: p.proceeds, gain_pct: (p.proceeds - p.invested) / p.invested, tier: p.tier }));
      const last_24h = [{ username: 'ravi_k', symbol: 'SOL', invested: 100, proceeds: 212, gain_pct: 1.12, tier: 'Legend' }, { username: 'erin', symbol: 'COST', invested: 50, proceeds: 63.5, gain_pct: 0.27, tier: 'Nice' }, ...mine,
        { username: 'bagholder_ben', symbol: 'GME', invested: 80, proceeds: 0, gain_pct: -1, tier: 'Rest in peace' }].sort((a, b) => b.gain_pct - a.gain_pct);
      return { all_time, last_24h };
    }
    fail('Not found.', 404);
  }

  async function post(path, body = {}) {
    await sleep(160);
    if (path.startsWith('/auth/')) {
      if (path === '/auth/claim' || path === '/auth/register') { if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username || '')) fail('Usernames are 3–20 letters, numbers or underscores.'); donations.forEach((d) => { if (d.user === user.username) d.user = body.username; }); user.username = body.username; user.is_guest = false; }
      if (path === '/auth/login') { if (!body.username) fail('Wrong username or password.', 401); user.username = body.username; user.is_guest = false; }
      return { token: 'demo', user: publicUser() };
    }
    if (path === '/buy') {
      const a = find(body.symbol); const amount = round2(Number(body.amount));
      if (!a) fail('Pick something from the list.'); if (!(amount >= 0.01)) fail('Invest at least a penny.');
      if (amount > user.cash) fail(`You only have $${user.cash.toFixed(2)} to invest.`);
      const q = priceOf(a); user.cash = round2(user.cash - amount);
      const p = { id: nextId++, symbol: a.symbol, name: a.name, asset_type: a.type, multiplier: a.multiplier, invested: amount, entry_price: q.price, opened_at: new Date().toISOString(), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS).toISOString(), status: 'open' };
      positions.push(p); return { ok: true, position: shape(p), cash: user.cash, quote: q };
    }
    if (path === '/ride') {
      const p = positions.find((x) => x.id === Number(body.position_id)); if (!p) fail('No such position.', 404); if (p.status !== 'open') fail('Already collected.');
      settleMatured();
      if (!p.matured_at) fail("It hasn't matured yet. You can only let a matured position ride.");
      if (!(p.matured_value >= 0.01)) fail("There's nothing left to ride.");
      const q = priceOf(find(p.symbol)); const profit = round2(p.matured_value - p.invested);
      Object.assign(p, { status: 'rolled', closed_day: today, closed_at: new Date().toISOString(), proceeds: p.matured_value, profit, tax: 0, tier: 'Let it ride' });
      const n = { id: nextId++, symbol: p.symbol, name: p.name, asset_type: p.asset_type, multiplier: p.multiplier, invested: p.matured_value, entry_price: q.price, opened_at: new Date().toISOString(), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS).toISOString(), status: 'open', rolled_from: p.id, ride_count: (p.ride_count || 0) + 1, origin_invested: p.origin_invested != null ? p.origin_invested : p.invested };
      positions.push(n);
      return { ok: true, position: shape(n), rolled: { from: p.id, value: p.matured_value, profit }, quote: q };
    }
    if (path === '/sell') {
      const p = positions.find((x) => x.id === Number(body.position_id)); if (!p) fail('No such position.', 404); if (p.status !== 'open') fail('Already collected.');
      settleMatured();
      const exitPrice = p.matured_at ? p.matured_price : priceOf(find(p.symbol)).price;
      const live = valueOf(p, exitPrice, p.matured_at ? new Date(p.matures_at).getTime() : Date.now()); if (p.matured_at) live.value = p.matured_value;
      const s = settle(p.invested, live.value);
      // A profit needs a charity; fall back to the player's usual one if none came through.
      let charity = null;
      if (s.tax > 0) {
        charity = CHARITIES.find((c) => c.id === Number(body.charity_id)) || CHARITIES.find((c) => c.id === user.charity_id) || CHARITIES[0];
      }
      Object.assign(p, { status: 'closed', closed_day: today, closed_at: new Date().toISOString(), proceeds: live.value, profit: s.profit, tax: s.tax, tier: s.tier, charity_id: charity ? charity.id : null, collected: !!p.matured_at });
      user.cash = round2(user.cash + s.net); user.total_donated = round2(user.total_donated + s.tax); user.realized_pnl = round2(user.realized_pnl + s.profit); if (charity) user.charity_id = charity.id;
      if (s.tax > 0) donations.push({ charity_id: charity.id, amount: s.tax, user: user.username });
      return { ok: true, user: publicUser(), receipt: { position_id: p.id, symbol: p.symbol, name: p.name, invested: p.invested, value: live.value, ...live, ...s, collected: !!p.matured_at, exit_price: exitPrice, charity } };
    }
    fail('Not found.', 404);
  }

  // First /me of the page load behaves like the day's first visit, so the
  // coin toss and the allowance toast show in the demo.
  let firstMe = true;
  const origGet = get;
  get = async function (path) {
    const out = await origGet(path);
    if (path === '/me' && firstMe) { firstMe = false; out.allowance = { amount: 120, streak: 3 }; }
    return out;
  };

  let token = 'demo';
  window.API = { token: () => token, setToken: (t) => { token = t; }, get, post, demo: true };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.textContent = 'Demo. The prices are invented and move fast, the charities are made up, and nothing is saved.';
    document.body.prepend(b);
  });
})();
