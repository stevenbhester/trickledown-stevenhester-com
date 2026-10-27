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

  const CHARITIES = [
    ['Doctors Without Borders', 'Medical', 'Emergency medical care where it is hardest to get.', 'https://www.doctorswithoutborders.org'],
    ['GiveDirectly', 'Poverty', 'Sends cash straight to people living in extreme poverty.', 'https://www.givedirectly.org'],
    ['Against Malaria Foundation', 'Health', 'Bed nets. One of the cheapest ways to save a life.', 'https://www.againstmalaria.com'],
    ['Central Texas Food Bank', 'Hunger', 'Feeds Central Texas, including Austin and the Hill Country.', 'https://www.centraltexasfoodbank.org'],
    ['World Central Kitchen', 'Hunger', 'Hot meals in the middle of disasters and wars.', 'https://wck.org'],
    ['charity: water', 'Water', 'Clean water projects. Thematically appropriate.', 'https://www.charitywater.org'],
    ['Khan Academy', 'Education', 'Free education for anyone, anywhere.', 'https://www.khanacademy.org'],
    ['ASPCA', 'Animals', 'Rescues and protects animals across the US.', 'https://www.aspca.org'],
  ].map(([name, category, blurb, url], i) => ({ id: i + 1, slug: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, category, blurb, url }));

  const RULES = { tax_rate: 0.25, daily_base: 100, streak_bonus: 10, daily_cap: 200 };
  const BADGES = [[1, 'Dribble'], [10, 'Drip'], [50, 'Trickle'], [250, 'Stream'], [1000, 'River'], [5000, 'Flood'], [25000, 'Deluge']].map(([at, name]) => ({ at, name }));
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
  const user = { id: 1, username: 'guest_demo', is_guest: true, cash: 100, total_donated: 4.5, realized_pnl: 10.5, streak: 3, charity_id: 6 };
  let nextId = 10;
  const seedNvda = find('NVDA'), seedDoge = find('DOGE');
  const positions = [
    { id: 1, symbol: 'NVDA', name: 'Nvidia', asset_type: 'stock', multiplier: 10, invested: 50, entry_price: round2(priceOf(seedNvda).price * 0.985), opened_day: today, status: 'open' },
    { id: 2, symbol: 'DOGE', name: 'Dogecoin', asset_type: 'crypto', multiplier: 5, invested: 25, entry_price: priceOf(seedDoge).price * 1.012, opened_day: today, status: 'open' },
    { id: 3, symbol: 'TSLA', name: 'Tesla', asset_type: 'stock', multiplier: 10, invested: 40, status: 'closed', proceeds: 58, profit: 18, tax: 4.5, tier: 'Nice', charity_id: 6, closed_day: today, closed_at: new Date(Date.now() - 3600e3).toISOString() },
    { id: 4, symbol: 'GME', name: 'GameStop', asset_type: 'stock', multiplier: 10, invested: 30, status: 'closed', proceeds: 0, profit: -30, tax: 0, tier: 'Rest in peace', charity_id: null, closed_day: '2026-10-26', closed_at: new Date(Date.now() - 86400e3).toISOString() },
  ];
  const donations = [
    { charity_id: 6, amount: 4.5, user: 'guest_demo' },
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
  const valueOf = (p, price) => {
    const real = (price - p.entry_price) / p.entry_price; const swing = p.multiplier * real; const raw = p.invested * (1 + swing);
    return { real_pct: real, swing_pct: Math.max(-1, swing), value: round2(Math.max(0, raw)), busted: raw <= 0 };
  };
  const tierFor = (inv, v) => { if (v <= 0) return 'Rest in peace'; const p = (v - inv) / inv; return p < 0 ? 'Paper cut' : p < 0.1 ? 'Pocket change' : p < 0.25 ? 'Respectable' : p < 0.5 ? 'Nice' : p < 1 ? 'Heater' : 'Legend'; };
  const settle = (inv, v) => { const profit = round2(v - inv); const tax = profit > 0 ? round2(profit * RULES.tax_rate) : 0; return { profit, tax, net: round2(v - tax), tier: tierFor(inv, v) }; };
  const resetsAt = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.toISOString(); };
  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function get(path) {
    await sleep(120);
    if (path === '/me') {
      const open = positions.filter((p) => p.status === 'open').map((p) => {
        const live = valueOf(p, priceOf(find(p.symbol)).price);
        return { ...p, price: priceOf(find(p.symbol)).price, quote_error: false, ...live, preview: settle(p.invested, live.value) };
      }).sort((a, b) => b.id - a.id);
      const history = positions.filter((p) => p.status === 'closed').sort((a, b) => b.id - a.id)
        .map((p) => ({ ...p, charity_name: p.charity_id ? CHARITIES.find((c) => c.id === p.charity_id).name : null }));
      const picks = [['NVDA', 'Nvidia', 9], ['BTC', 'Bitcoin', 5], ['TSLA', 'Tesla', 4], ['DOGE', 'Dogecoin', 2], ['GLD', 'Gold (ETF)', 1]]
        .map(([symbol, name, buys]) => ({ symbol, name, buys, invested: buys * 60 }));
      return {
        user: publicUser(), day: { key: today, number: 12, quarter: '2026-Q4', resets_at: resetsAt(), tz: 'America/Chicago' },
        allowance: null, rules: RULES, positions: open, history,
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
      return { quarter: '2026-Q4', pool_usd: pool, quarter_total: round2(qt), all_time: round2(totals.reduce((s, c) => s + c.all_time, 0)), quarter_donors: 5,
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
      if (path === '/auth/claim' || path === '/auth/register') { if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username || '')) fail('Usernames are 3–20 letters, numbers or underscores.'); user.username = body.username; user.is_guest = false; }
      if (path === '/auth/login') { if (!body.username) fail('Wrong username or password.', 401); user.username = body.username; user.is_guest = false; }
      return { token: 'demo', user: publicUser() };
    }
    if (path === '/buy') {
      const a = find(body.symbol); const amount = round2(Number(body.amount));
      if (!a) fail('Pick something from the list.'); if (!(amount >= 1)) fail('Invest at least $1.');
      if (amount > user.cash) fail(`You only have $${user.cash.toFixed(2)} to invest.`);
      const q = priceOf(a); user.cash = round2(user.cash - amount);
      const p = { id: nextId++, symbol: a.symbol, name: a.name, asset_type: a.type, multiplier: a.multiplier, invested: amount, entry_price: q.price, opened_day: today, status: 'open' };
      positions.push(p); return { ok: true, position: p, cash: user.cash, quote: q };
    }
    if (path === '/sell') {
      const p = positions.find((x) => x.id === Number(body.position_id)); if (!p) fail('No such position.', 404); if (p.status !== 'open') fail('Already locked in.');
      const live = valueOf(p, priceOf(find(p.symbol)).price); const s = settle(p.invested, live.value);
      let charity = null; if (s.tax > 0) { charity = CHARITIES.find((c) => c.id === Number(body.charity_id)); if (!charity) fail('Pick a charity for the tax.'); }
      Object.assign(p, { status: 'closed', closed_day: today, closed_at: new Date().toISOString(), proceeds: live.value, profit: s.profit, tax: s.tax, tier: s.tier, charity_id: charity ? charity.id : null });
      user.cash = round2(user.cash + s.net); user.total_donated = round2(user.total_donated + s.tax); user.realized_pnl = round2(user.realized_pnl + s.profit); if (charity) user.charity_id = charity.id;
      if (s.tax > 0) donations.push({ charity_id: charity.id, amount: s.tax, user: user.username });
      return { ok: true, user: publicUser(), receipt: { position_id: p.id, symbol: p.symbol, name: p.name, invested: p.invested, value: live.value, ...live, ...s, charity } };
    }
    fail('Not found.', 404);
  }

  let token = 'demo';
  window.API = { token: () => token, setToken: (t) => { token = t; }, get, post, demo: true };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.textContent = 'Demo mode. Prices are invented and move fast. Nothing is saved.';
    document.body.prepend(b);
  });
})();
