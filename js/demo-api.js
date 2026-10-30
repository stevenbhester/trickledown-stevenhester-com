// Demo mode: the whole game against an in-memory fake API. Used when the URL
// has ?demo, or when config.js still points at the placeholder backend. Prices
// wander quickly so the loop is fun to click through. Nothing is saved.
(function () {
  const cfg = window.TRICKLE_CONFIG || {};
  // Demo mode is opt-in only (?demo). A copy whose config.js still points at
  // the placeholder backend shows a setup notice instead of quietly running
  // the fake game.
  const wantDemo = /[?&]demo\b/.test(location.search);
  if (!wantDemo) return;

  const ASSETS = [
    ['NVDA', 'Nvidia', 'stock', 'Spicy'], ['TSLA', 'Tesla', 'stock', 'Spicy'], ['AAPL', 'Apple', 'stock', 'Normal'],
    ['MSFT', 'Microsoft', 'stock', 'Calm'], ['AMZN', 'Amazon', 'stock', 'Normal'], ['META', 'Meta', 'stock', 'Normal'],
    ['GME', 'GameStop', 'stock', 'Unhinged'], ['KO', 'Coca-Cola', 'stock', 'Calm'], ['COST', 'Costco', 'stock', 'Calm'],
    ['SPY', 'S&P 500 (ETF)', 'stock', 'Calm'], ['GLD', 'Gold (ETF)', 'stock', 'Calm'], ['PLTR', 'Palantir', 'stock', 'Spicy'],
    ['BTC', 'Bitcoin', 'crypto', 'Spicy'], ['ETH', 'Ethereum', 'crypto', 'Spicy'], ['SOL', 'Solana', 'crypto', 'Unhinged'],
    ['DOGE', 'Dogecoin', 'crypto', 'Unhinged'], ['SHIB', 'Shiba Inu', 'crypto', 'Unhinged'],
  ].map(([symbol, name, type, mood]) => ({ symbol, name, type, mood, multiplier: type === 'crypto' ? 5 : 10 }));

  // The real list, as in src/charities.js in the backend (4 stars on Charity Navigator).
  const CHARITIES = [
    ['Against Malaria Foundation', 'Malaria', 'https://www.againstmalaria.com', 'Funds long-lasting insecticidal nets that protect families from malaria.'],
    ['Best Friends Animal Society', 'Animals', 'https://bestfriends.org', "Working to end the killing of dogs and cats in America's shelters."],
    ['charity: water', 'Clean water', 'https://www.charitywater.org', 'Funds clean, safe drinking water projects in developing countries.'],
    ['Crisis Text Line', 'Mental health', 'https://www.crisistextline.org', 'Free, 24/7 support by text for anyone in crisis.'],
    ['Direct Relief', 'Medical aid', 'https://www.directrelief.org', 'Gets medicine and medical supplies to people hit by poverty and emergencies.'],
    ['Doctors Without Borders USA', 'Global health', 'https://www.doctorswithoutborders.org', 'Independent medical care in war zones, epidemics and disasters.'],
    ['DonorsChoose', 'Education', 'https://www.donorschoose.org', 'Funds classroom projects requested by public school teachers.'],
    ['Equal Justice Initiative', 'Justice', 'https://eji.org', 'Represents people who were wrongly convicted or unfairly sentenced.'],
    ['Feeding America', 'Hunger', 'https://www.feedingamerica.org', 'A nationwide network of food banks fighting hunger in the US.'],
    ['Fisher House Foundation', 'Veterans', 'https://fisherhouse.org', "Free lodging for military and veterans' families while a loved one is in the hospital."],
    ['GiveDirectly', 'Poverty', 'https://www.givedirectly.org', 'Sends cash directly to people living in extreme poverty.'],
    ['Habitat for Humanity International', 'Housing', 'https://www.habitat.org', 'Builds and repairs homes with families who need affordable housing.'],
    ['International Rescue Committee', 'Refugees', 'https://www.rescue.org', 'Helps people whose lives are upended by conflict and disaster survive and rebuild.'],
    ['The Nature Conservancy', 'Environment', 'https://www.nature.org', 'Protects lands and waters around the world.'],
    ['Save the Children', 'Children', 'https://www.savethechildren.org', 'Helps children in the US and around the world stay healthy, learn and stay safe.'],
    ['Smile Train', "Kids' surgery", 'https://www.smiletrain.org', 'Funds cleft lip and palate surgery and care for children worldwide.'],
    ["St. Jude Children's Research Hospital", "Kids' health", 'https://www.stjude.org', 'Treats children with cancer and other deadly diseases. Families never get a bill. (Rated as ALSAC, its fundraising arm.)'],
    ['World Central Kitchen', 'Disaster relief', 'https://wck.org', 'Cooks and serves fresh meals on the front lines of disasters and crises.'],
  ].map(([name, category, url, blurb], i) => ({ id: i + 1, slug: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, category, blurb, url, donate: `${url}/donate`, rating: '4 stars' }));

  const RULES = { tax_rate: 0.25, ride_tax_factor: 0.5, ride_max_steps: 2, daily_base: 100, streak_bonus: 10, daily_cap: 200, hold_hours: 24, mult_floor: 1, demo: true };
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
  const user = { id: 1, username: 'guest_demo', is_guest: true, cash: 100, total_donated: 0.6, realized_pnl: 2.4, streak: 3, charity_id: 6, is_admin: true, vested: false };
  let nextId = 10;
  const seedNvda = find('NVDA'), seedDoge = find('DOGE'), seedKo = find('KO');
  const HOLD_MS = RULES.hold_hours * 3600e3;
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const isoDay = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
  const positions = [
    // Live, bought 3h ago, up.
    { id: 1, symbol: 'NVDA', name: 'Nvidia', asset_type: 'stock', multiplier: 10, invested: 50, entry_price: round2(priceOf(seedNvda).price * 0.985), opened_at: ago(3), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS - 3 * 3600e3).toISOString(), status: 'open' },
    // Live, bought 20h ago, down.
    { id: 2, symbol: 'DOGE', name: 'Dogecoin', asset_type: 'crypto', multiplier: 5, invested: 25, entry_price: priceOf(seedDoge).price * 1.012, opened_at: ago(20), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS - 20 * 3600e3).toISOString(), status: 'open' },
    // Matured 2h ago: frozen, ready to collect.
    { id: 5, symbol: 'KO', name: 'Coca-Cola', asset_type: 'stock', multiplier: 10, invested: 20, entry_price: round2(priceOf(seedKo).price * 0.97), opened_at: ago(26), opened_day: '2026-10-26', matures_at: ago(2), matured_at: ago(2), matured_price: priceOf(seedKo).price, status: 'open' },
    { id: 3, symbol: 'TSLA', name: 'Tesla', asset_type: 'stock', multiplier: 10, invested: 10, status: 'closed', proceeds: 12.4, profit: 2.4, tax: 0.6, lobbyists: 0.6, tier: 'Respectable', charity_id: 6, collected: true, closed_day: today, closed_at: ago(1) },
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
    return { ...p, matured, matured_late: !!p.matured_late, mult_floor: p.mult_floor != null ? p.mult_floor : 1, deferred_tax: p.deferred_tax || 0, seconds_left: matured ? 0 : Math.max(0, Math.round((new Date(p.matures_at) - Date.now()) / 1000)), ride_count: p.ride_count || 0, origin_invested: p.origin_invested != null ? p.origin_invested : p.invested, price, quote_error: false, ...live, preview: settle(p.invested, live.value, matured ? 0 : (p.deferred_tax || 0)) };
  }
  // The village, seeded with a "luxury" high-rise and slightly worn-down residents.
  const town = TownRules.fresh();
  town.plots.housing = 'pinnacle';
  town.built.housing = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
  town.happiness = 48;
  // The demo cat, a few days in and already in a bow tie.
  town.played.push('cat'); town.flags.push('cat_mascot');
  town.cat = { name: 'Comptroller', pronoun: 'she', coat: 'tabby', owned: ['bow_tie'], wearing: { neck: 'bow_tie' }, spent: 15, since: new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10) };
  // Friends are one-directional: the names you've added. Seeded with two so the
  // Friends board has something on it; add ravi_k or bagholder_ben to try it.
  const friends = new Set(['erin', 'moonshot_mia']);
  const townCtx = (extra = {}) => ({ day: today, uid: 1, cash: user.cash, lobbyists: user.total_donated, streak: user.streak, friends: friends.size, unlocked: TownRules.isUnlocked(user.total_donated), ...extra });
  const townView = () => ({ ...TownRules.view(town, townCtx()), unlocked: TownRules.isUnlocked(user.total_donated) });
  TownRules.tick(town, townCtx({ cash: 120 }));

  // Achievements, as src/achievements.js has them (same keys, gifts, notes).
  const ACH = [
    ['first_buy', 'Skin in the Game', 'Make your first investment.', 'Daddy', 40, "Proud of you, champ. Here's a little something so you never have to touch the principal."],
    ['first_win', 'Realized Gains', 'Cash out a profit.', 'Mommy', 20, 'Your first real money! Daddy got misty. Buy yourself something with a crest on it.'],
    ['first_bust', 'Character Building', 'Lose a whole position.', 'Daddy', 25, 'Everybody loses one. I lost a shipping line. This should cover it.'],
    ['networking', 'Networking', 'Add 3 friends.', 'Mommy', 20, 'Wonderful, darling. Who are their parents?'],
    ['streak_7', 'Creature of Habit', 'Play 7 days in a row.', 'Mommy', 30, 'A whole week! You get the discipline from my side.'],
    ['landlord', 'Landlord', 'Build on every lot in TrickleTown.', 'Daddy', 40, 'Property. Finally, a real job.'],
    ['let_it_ride', 'Let It Ride', 'Ride the same position twice.', 'Daddy', 40, 'Never take money off the table. Your grandfather never did, and look at him. Well, look at his portrait.'],
    ['legend', 'Legendary', 'Cash out at Legend tier (double your money or better).', 'Mommy', 50, "I told everyone at the club. They're asking who your advisor is."],
    ['power_broker', 'Power Broker', 'Hire 500 lobbyists, career.', 'Mommy', 60, 'Five hundred! Your father had four hundred and they named an interchange after him.'],
    ['streak_30', 'Clocked In', 'Play 30 days in a row.', 'Daddy', 100, 'Thirty days without missing one. Nobody in this family has ever done that. Not even at the office.'],
    ['seven_figures', 'Seven Figures', 'Have $1M on the coin at once.', 'Daddy', 100, "A million! They say the first one is the hardest. I wouldn't know."],
  ].map(([key, title, how, from, gift, note]) => ({ key, title, how, from, gift, note }));
  // The demo player is a few days in: the first three already earned and taken.
  const earned = new Map(['first_buy', 'first_win', 'first_bust'].map((k) => [k, { earned_at: new Date(Date.now() - 2 * 86400e3).toISOString(), claimed_at: new Date(Date.now() - 2 * 86400e3).toISOString(), lobbyists: k === 'first_buy' ? 10 : null }]));
  function achView() {
    const mine = positions.filter((p) => p.status !== 'vested' && p.status !== 'gift');
    const s = {
      bought: mine.length, won: mine.some((p) => (p.status === 'closed' || p.status === 'rolled') && p.profit > 0),
      bust: mine.some((p) => p.status === 'closed' && p.invested > 0 && p.proceeds <= 0), legend: mine.some((p) => p.tier === 'Legend'),
      rides: Math.max(0, ...mine.map((p) => p.ride_count || 0)), friends: friends.size, streak: user.streak, cash: user.cash, lob: user.total_donated,
      built: Object.values(town.plots).filter(Boolean).length, lots: Object.keys(town.plots).length,
    };
    const met = { first_buy: s.bought >= 1, first_win: s.won, first_bust: s.bust, networking: s.friends >= 3, streak_7: s.streak >= 7, landlord: s.built >= s.lots, let_it_ride: s.rides >= 2, legend: s.legend, power_broker: s.lob >= 500, streak_30: s.streak >= 30, seven_figures: s.cash >= 1000 };
    const prog = { first_buy: [Math.min(s.bought, 1), 1], networking: [Math.min(s.friends, 3), 3], streak_7: [Math.min(s.streak, 7), 7], streak_30: [Math.min(s.streak, 30), 30], landlord: [s.built, s.lots], let_it_ride: [Math.min(s.rides, 2), 2], power_broker: [Math.min(Math.floor(s.lob), 500), 500], seven_figures: [Math.min(Math.floor(s.cash), 1000), 1000] };
    for (const a of ACH) if (met[a.key] && !earned.has(a.key)) earned.set(a.key, { earned_at: new Date().toISOString(), claimed_at: null, lobbyists: null });
    const list = ACH.map((a) => { const e = earned.get(a.key); const p = prog[a.key]; return { ...a, earned_at: e ? e.earned_at : null, claimed_at: e ? e.claimed_at : null, lobbyists: e ? e.lobbyists : null, progress: !e && p ? { have: p[0], need: p[1], money: a.key === 'seven_figures' } : null }; });
    return { list, unclaimed: list.filter((a) => a.earned_at && !a.claimed_at).map((a) => a.key), earned: list.filter((a) => a.earned_at).length, total: list.length };
  }

  // Admin clean-up, demo-sized: other players' allowance rows that were undone.
  const demoUndone = new Set();
  function demoLobbyists(name) {
    const n = String(name || '').toLowerCase();
    if (n === user.username.toLowerCase()) {
      const mine = donations.filter((d) => d.user === user.username);
      const split = CHARITIES.map((c) => ({ id: c.id, name: c.name, active: true, amount: round2(mine.filter((d) => d.charity_id === c.id).reduce((s, d) => s + d.amount, 0)) })).filter((c) => c.amount > 0);
      return { username: user.username, quarter: '2026-Q4', total_donated: user.total_donated, donations_by_charity: split };
    }
    const o = otherPlayers.find((x) => x.username.toLowerCase() === n); if (!o) fail('No player by that name.', 404);
    const c = CHARITIES.find((x) => x.name === o.top_charity) || CHARITIES[0];
    return { username: o.username, quarter: '2026-Q4', total_donated: o.donated, donations_by_charity: o.donated > 0 ? [{ id: c.id, name: c.name, active: true, amount: round2(o.donated) }] : [] };
  }
  const demoRequests = [{ id: 1, name: 'Austin Pets Alive!', url: 'https://www.austinpetsalive.org/', reason: 'Saved my dog. Please add them!', status: 'new', created_at: new Date(Date.now() - 5 * 3.6e6).toISOString(), username: 'erin' }];
  const demoBugs = [{ id: 1, description: 'The coin flipped twice when I tapped it fast.', url: 'https://trickledown.stevenhester.com/#today', client: 'build demo · 390×844 · light · Mozilla/5.0 (iPhone)', status: 'new', created_at: new Date(Date.now() - 26 * 3.6e6).toISOString(), username: 'ravi_k' }];
  const donations = [
    { charity_id: 6, amount: 0.6, user: 'guest_demo' },
    { charity_id: 1, amount: 61.25, user: 'ravi_k' }, { charity_id: 2, amount: 48, user: 'ravi_k' }, { charity_id: 4, amount: 33.1, user: 'erin' },
    { charity_id: 3, amount: 12.75, user: 'erin' }, { charity_id: 6, amount: 20, user: 'bagholder_ben' }, { charity_id: 8, amount: 9.3, user: 'bagholder_ben' },
    { charity_id: 5, amount: 15.5, user: 'moonshot_mia' }, { charity_id: 7, amount: 2.25, user: 'moonshot_mia' },
  ];
  // The other players, with enough of a life to fill a player sheet: a few
  // positions (entry prices set so their coins show some red and green) and
  // a village of their own.
  const pos = (symbol, invested, hoursAgo, drift, extra = {}) => {
    const a = find(symbol); const opened = Date.now() - hoursAgo * 3600e3;
    const p = { id: 900 + Math.round(hash(symbol + invested) * 90), symbol: a.symbol, name: a.name, asset_type: a.type, multiplier: a.multiplier, invested, entry_price: priceOf(a).price * drift, opened_at: new Date(opened).toISOString(), opened_day: today, matures_at: new Date(opened + HOLD_MS).toISOString(), status: 'open', ...extra };
    if (new Date(p.matures_at) <= new Date()) { p.matured_at = p.matures_at; p.matured_price = priceOf(a).price; p.matured_value = valueOf(p, p.matured_price, new Date(p.matures_at).getTime()).value; }
    return p;
  };
  const otherPlayers = [
    { username: 'ravi_k', donated: 109.25, realized_pnl: 437, streak: 12, cash: 14, hours_ago: 1, top_charity: 'charity: water', town: { happiness: 71, income: 9, motto: 'Nobody is complaining. Officially.', buildings: [{ slot: 'housing', key: 'coop', name: 'Maple Co-op', tier: 'good' }, { slot: 'square', key: 'clinic', name: 'Free Clinic', tier: 'good' }] },
      positions: () => [pos('SOL', 100, 22, 0.94), pos('BTC', 50, 6, 0.99), pos('NVDA', 36, 2, 1.004)] },
    { username: 'erin', donated: 45.85, realized_pnl: 183.4, streak: 7, cash: 0, hours_ago: 4, top_charity: 'Best Friends Animal Society', town: { happiness: 58, income: 6, motto: 'A town, technically.', buildings: [{ slot: 'housing', key: 'tenement', name: 'Tenement Row', tier: 'bad' }, { slot: 'square', key: null }] },
      positions: () => [pos('COST', 40, 5, 0.985), pos('NVDA', 30, 1, 1.002), pos('GLD', 40, 9, 0.997)] },
    { username: 'bagholder_ben', donated: 29.3, realized_pnl: -41, streak: 2, cash: 32, hours_ago: 30, top_charity: 'Feeding America', town: null,
      positions: () => [pos('GME', 80, 27, 1.2), pos('AMZN', 20, 3, 1.01)] },
    { username: 'moonshot_mia', donated: 17.75, realized_pnl: 71, streak: 5, cash: 10, hours_ago: 0.3, top_charity: 'World Central Kitchen', town: { happiness: 39, income: 14, motto: 'Prosperity for some.', buildings: [{ slot: 'housing', key: 'pinnacle', name: 'The Pinnacle', tier: 'bad' }, { slot: 'square', key: 'casino', name: 'Lucky Lobby Casino', tier: 'bad' }] },
      positions: () => [pos('DOGE', 60, 15, 0.93), pos('SHIB', 40, 15, 1.08)] },
  ];
  const findPlayer = (name) => otherPlayers.find((p) => p.username.toLowerCase() === String(name || '').toLowerCase());
  // Other players' donation rows are their career totals; this quarter is a slice of that.
  const quarterOf = (name) => { const o = findPlayer(name); return o ? round2(o.donated * 0.6) : round2(donations.filter((d) => d.user === name).reduce((s, d) => s + d.amount, 0)); };
  const seenAt = (h) => (h < 24 ? 'today' : h < 24 * 7 ? 'this week' : h < 24 * 30 ? 'this month' : 'a while ago');
  const friendRow = (p) => ({ username: p.username, streak: p.streak, total_donated: p.donated, quarter_donated: quarterOf(p.username), badges: badgesFor(p.donated), cash: p.cash, last_seen: seenAt(p.hours_ago), town: p.town ? { happiness: p.town.happiness, motto: p.town.motto } : null });
  // A public profile, shaped like GET /players/:username on the server.
  // A trading history like the server's: realized profit by the day it was
  // realized, running total, gifts excluded, open positions added at "now".
  const addDay = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  function perfFromCloses(closes, open, firstDay) {
    const byDay = new Map();
    for (const c of closes) { const r = byDay.get(c.d) || { pnl: 0, n: 0, wins: 0 }; r.pnl += c.profit; r.n += 1; if (c.profit > 0) r.wins += 1; byDay.set(c.d, r); }
    const series = []; let total = 0, closed = 0, wins = 0;
    if (firstDay) {
      let d = addDay(firstDay, -1); series.push({ d, v: 0 });
      while (d < today) { d = addDay(d, 1); const r = byDay.get(d); if (r) { total += r.pnl; closed += r.n; wins += r.wins; } series.push({ d, v: round2(total) }); }
    }
    const best = closes.filter((c) => c.profit > 0).sort((a, b) => b.profit - a.profit)[0];
    const worst = closes.filter((c) => c.profit < 0).sort((a, b) => a.profit - b.profit)[0];
    const open_pnl = round2(open.reduce((sum, x) => sum + (x.value - x.invested), 0));
    const pick = (c) => (c ? { symbol: c.symbol, profit: round2(c.profit), pct: c.invested ? c.profit / c.invested : null, day: c.d, tier: c.tier || null } : null);
    return { series, realized: round2(total), open_pnl, total: round2(total + open_pnl), closed, wins, best: pick(best), worst: pick(worst), since: firstDay };
  }
  // Other players get a seeded month of trading that ends at their realized total.
  function seededCloses(p) {
    const out = []; const days = 34; const syms = ['NVDA', 'TSLA', 'BTC', 'KO', 'SOL', 'DOGE', 'AAPL', 'GME'];
    let sum = 0;
    for (let i = 0; i < days; i++) {
      const r = hash(`${p.username}:${i}`); if (r < 0.35) continue;
      const inv = round2(40 + r * 160); const profit = round2(inv * (hash(`${p.username}~${i}`) - 0.45) * 0.6);
      out.push({ d: addDay(today, -(days - i)), symbol: syms[Math.floor(r * 997) % syms.length], invested: inv, profit }); sum += profit;
    }
    // Nudge the last few so the total lands on the realized_pnl the boards show.
    const gap = (p.realized_pnl - sum) / 3; for (let k = 1; k <= 3 && out.length - k >= 0; k++) out[out.length - k].profit = round2(out[out.length - k].profit + gap);
    return out;
  }
  // Walls: the demo player's has a post from erin; erin's is open to you (she added you).
  const walls = new Map([
    ['guest_demo', [{ id: 2, author: 'erin', body: 'Saw the Pinnacle went up. Bold. The view from the 40th floor is mostly the casino.', at: ago(5) }]],
    ['erin', [{ id: 1, author: 'ravi_k', body: 'Co-op tour Saturday? Bring the good snacks.', at: ago(30) }]],
    ['ravi_k', []],
  ]);
  let wallNext = 10, wallSeen = false, followSeen = false;
  // Who added you and is waiting on an add-back (ravi_k, in the demo).
  const waiting = () => [...addedYouSet].filter((n) => !friends.has(n)).map((n, i) => ({ username: n, at: ago(3 + i * 20) }));
  const addedYouSet = new Set(['erin', 'ravi_k']);
  const wallOpenTo = (owner) => owner.toLowerCase() === user.username.toLowerCase() || addedYouSet.has(owner);
  const wallFor = (owner) => (walls.get(owner) || []).map((w) => ({ ...w, mine: w.author === user.username, can_delete: w.author === user.username || owner === user.username }));
  const ownerName = (name) => (name.toLowerCase() === user.username.toLowerCase() ? user.username : (findPlayer(name) || {}).username);
  const SEED_SIDES = { ravi_k: { preston: 4, dolores: 15 }, erin: { preston: 9, dolores: 8 }, moonshot_mia: { preston: 13, dolores: 2 } };
  const SEED_PETS = {
    ravi_k: { name: 'Mr. Biscuits', pronoun: 'he', coat: 'black', wearing: { head: 'top_hat', eyes: 'monocle', neck: 'bow_tie' }, owned: 3, spent: 240 },
    erin: { name: 'Duchess', pronoun: 'she', coat: 'calico', wearing: { head: 'tiara', neck: 'pearls' }, owned: 2, spent: 590 },
    moonshot_mia: { name: 'Margin Call', pronoun: 'she', coat: 'gray', wearing: { head: 'crown', body: 'cape', eyes: 'sunglasses' }, owned: 5, spent: 2025 },
  };
  const SEED_EARNED = { ravi_k: ['first_buy', 'first_win', 'networking', 'streak_7', 'landlord'], erin: ['first_buy', 'first_win', 'streak_7'], bagholder_ben: ['first_buy', 'first_bust'], moonshot_mia: ['first_buy', 'first_win', 'let_it_ride'] };

  function profileOf(name) {
    if (name.toLowerCase() === user.username.toLowerCase()) {
      settleMatured();
      const mine = positions.filter((p) => p.status === 'open').map(shape);
      const tv = TownRules.isUnlocked(user.total_donated) ? townView() : null;
      const closes = positions.filter((p) => (p.status === 'closed' || p.status === 'rolled')).map((p) => ({ d: p.closed_day, symbol: p.symbol, invested: p.invested, profit: p.profit, tier: p.tier }));
      const firstDay = positions.filter((p) => p.status !== 'gift' && p.status !== 'vested').map((p) => p.opened_day || p.closed_day).filter(Boolean).sort()[0] || null;
      const mineDon = donations.filter((d) => d.user === user.username);
      wallSeen = true;
      return { username: user.username, is_guest: user.is_guest, joined: addDay(today, -11) + 'T15:00:00Z', streak: user.streak, total_donated: user.total_donated, quarter_donated: quarterOf(user.username), badges: badgesFor(user.total_donated), cash: user.cash,
        in_play: round2(user.cash + mine.reduce((s, p) => s + p.value, 0)), positions: mine, performance: perfFromCloses(closes, mine, firstDay),
        lobbyists_by_charity: CHARITIES.map((c) => ({ name: c.name, slug: c.slug, amount: round2(mineDon.filter((d) => d.charity_id === c.id).reduce((s2, d) => s2 + d.amount, 0)) })).filter((c) => c.amount > 0),
        top_charity: 'Feeding America', last_seen: 'today',
        achievements: { earned: achView().list.filter((a) => a.earned_at).map((a) => ({ key: a.key, title: a.title, how: a.how, at: a.earned_at })), total: ACH.length },
        town: tv ? { happiness: tv.happiness, income: tv.income, hire_cost: tv.hire_cost, motto: tv.motto, sides: { ...(town.sides || { preston: 0, dolores: 0 }) },
          pet: town.cat && town.cat.name ? { name: town.cat.name, pronoun: town.cat.pronoun, coat: town.cat.coat, wearing: { ...town.cat.wearing }, owned: town.cat.owned.length, spent: town.cat.spent } : null,
          buildings: tv.plots.map((pl) => (pl.building ? { slot: pl.slot, label: pl.label, key: pl.key, name: pl.building.name, tier: pl.building.tier, days: pl.days, upgrades: pl.building.upgrades.filter((x) => x.owned).map((x) => ({ name: x.name, tier: x.tier })) } : { slot: pl.slot, label: pl.label, key: null })) } : null,
        is_friend: false, added_you: false, is_you: true, wall: { open: true, max: 280, posts: wallFor(user.username) } };
    }
    const p = findPlayer(name); if (!p) fail('No player by that name.', 404);
    const open = p.positions().map(shape);
    const town2 = p.town ? { ...p.town, hire_cost: round2(Math.max(0.5, 1.4 - 0.9 * Math.pow(p.town.happiness / 100, 1.5))), sides: SEED_SIDES[p.username] || { preston: 3, dolores: 3 }, pet: SEED_PETS[p.username] || null,
      buildings: p.town.buildings.map((b) => ({ ...b, label: b.slot === 'housing' ? 'Housing' : 'Town square', days: b.key ? 6 : 0, upgrades: [] })) } : null;
    const share = [0.55, 0.3, 0.15];
    return { ...friendRow(p), is_guest: false, joined: addDay(today, -40) + 'T15:00:00Z', in_play: round2(p.cash + open.reduce((s2, x) => s2 + x.value, 0)), positions: open,
      performance: perfFromCloses(seededCloses(p), open, addDay(today, -34)),
      lobbyists_by_charity: [p.top_charity, ...CHARITIES.map((c) => c.name).filter((n) => n !== p.top_charity).slice(hash(p.username) * 4 | 0, (hash(p.username) * 4 | 0) + 2)].map((n, i) => ({ name: n, amount: round2(quarterOf(p.username) * share[i]) })),
      top_charity: p.top_charity, town: town2,
      achievements: { earned: (SEED_EARNED[p.username] || ['first_buy']).map((k) => { const a = ACH.find((x) => x.key === k); return { key: k, title: a.title, how: a.how, at: ago(200) }; }), total: ACH.length },
      is_friend: friends.has(p.username), added_you: addedYouSet.has(p.username), is_you: false,
      wall: wallOpenTo(p.username) ? { open: true, max: 280, posts: wallFor(p.username) } : { open: false } };
  }

  const badgesFor = (d) => ({ earned: BADGES.filter((b) => d >= b.at), next: BADGES.find((b) => d < b.at) || null });
  const publicUser = () => ({ ...user, badges: badgesFor(user.total_donated), account_day: 11 });
  // Multiplier ramps from ×1 at purchase to the full multiplier at maturity.
  const multAt = (p, at = Date.now()) => {
    const o = new Date(p.opened_at).getTime(), m = new Date(p.matures_at).getTime();
    const k = Math.max(0, Math.min(1, (at - o) / Math.max(1, m - o)));
    const floor = Math.min(p.mult_floor != null ? p.mult_floor : 1, p.multiplier);
    return floor + (p.multiplier - floor) * k;
  };
  // A ride's multipliers: the new day starts at the old ceiling and climbs by the base again, up to a cap.
  const rideMults = (p) => { const base = p.asset_type === 'crypto' ? 5 : 10; const cap = base * (1 + RULES.ride_max_steps); const floor = Math.min(p.multiplier, cap); return { floor, ceiling: Math.min(floor + base, cap) }; };
  const valueOf = (p, price, at = Date.now()) => {
    const mult = multAt(p, at);
    const real = (price - p.entry_price) / p.entry_price; const swing = mult * real; const raw = p.invested * (1 + swing);
    return { real_pct: real, swing_pct: Math.max(-1, swing), multiplier_now: Math.round(mult * 100) / 100, value: round2(Math.max(0, raw)), busted: raw <= 0 };
  };
  const tierFor = (inv, v) => { if (v <= 0) return 'Rest in peace'; const p = (v - inv) / inv; return p <= -0.5 ? 'Comically disastrous' : p <= -0.25 ? 'Taking on water' : p <= -0.1 ? 'Flesh wound' : p < 0 ? 'Paper cut' : p < 0.1 ? 'Pocket change' : p < 0.25 ? 'Respectable' : p < 0.5 ? 'Nice' : p < 1 ? 'Heater' : 'Legend'; };
  const settle = (inv, v, deferred = 0) => { const profit = round2(v - inv); const own = profit > 0 ? round2(profit * RULES.tax_rate) : 0; const due = round2(Math.min(Math.max(0, deferred), Math.max(0, v - own))); const tax = round2(own + due); return { profit, tax, deferred_tax: due, net: round2(v - tax), tier: tierFor(inv, v) }; };
  const resetsAt = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.toISOString(); };
  // Lobbyfest: local midnight at the start of the next quarter.
  const quarterEndsAt = () => { const d = new Date(); const m = Math.floor(d.getMonth() / 3) * 3 + 3; return new Date(d.getFullYear(), m, 1, 0, 0, 0).toISOString(); };
  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let get = async function (fullPath) {
    await sleep(120);
    const [path, qs] = String(fullPath).split('?');
    const params = new URLSearchParams(qs || '');
    // The welcome-back review: a made-up but plausible path for each position,
    // starting at what went in and landing exactly where it froze.
    if (path === '/positions/review') {
      settleMatured();
      const ids = String(params.get('ids') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const open = positions.filter((p) => p.status === 'open');
      const done = open.filter((p) => p.matured_at && ids.includes(p.id));
      if (!done.length) return { start: null, end: null, positions: [] };
      const ms = (d) => new Date(d).getTime();
      const end = Math.max(...done.map((p) => ms(p.matures_at)));
      const start = Math.min(...done.map((p) => ms(p.opened_at)));
      const live = open.filter((p) => !p.matured_at && ms(p.opened_at) < end);
      return {
        start, end,
        positions: [...done, ...live].map((p) => {
          const t0 = Math.max(ms(p.opened_at), start), t1 = p.matured_at ? ms(p.matures_at) : end;
          const last = p.matured_at ? p.matured_price : priceOf(find(p.symbol)).price;
          const seed = hash(p.symbol), n = 72, points = [];
          for (let i = 0; i <= n; i++) {
            const k = i / n, t = t0 + (t1 - t0) * k;
            const wob = Math.sin(k * 9 + seed * 20) * 0.6 + Math.sin(k * 23 + seed * 7) * 0.3 + Math.sin(k * 51 + seed * 3) * 0.12;
            const px = p.entry_price + (last - p.entry_price) * k + p.entry_price * 0.012 * wob * Math.sin(Math.PI * k);
            points.push([Math.round(t), valueOf(p, px, t).value]);
          }
          if (p.matured_at) points[n][1] = p.matured_value;
          return { id: p.id, symbol: p.symbol, name: p.name, matured: !!p.matured_at, invested: p.invested, opened_at: p.opened_at, matures_at: p.matures_at, final_value: points[n][1], points };
        }),
      };
    }
    if (path === '/me') {
      settleMatured();
      TownRules.ensureIssues(town, townCtx());
      const open = positions.filter((p) => p.status === 'open').map(shape).sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at));
      const history = positions.filter((p) => p.status === 'closed' || p.status === 'rolled' || p.status === 'vested' || p.status === 'gift').sort((a, b) => b.id - a.id)
        .map((p) => ({ ...p, rode: p.status === 'rolled', vested: p.status === 'vested', gift: p.status === 'gift', charity_name: p.charity_id ? CHARITIES.find((c) => c.id === p.charity_id).name : null }));
      // What your friends bought today, for the crowd line.
      const friendsToday = [...friends].sort().map((name) => { const p = findPlayer(name); return p && { username: name, symbols: [...new Set(p.positions().filter((x) => new Date(x.opened_at) >= new Date(today)).map((x) => x.symbol))].sort() }; }).filter((f) => f && f.symbols.length);
      const picks = [['NVDA', 'Nvidia', 9], ['BTC', 'Bitcoin', 5], ['TSLA', 'Tesla', 4], ['DOGE', 'Dogecoin', 2], ['GLD', 'Gold (ETF)', 1]]
        .map(([symbol, name, buys]) => ({ symbol, name, buys, invested: buys * 60 }));
      const mine = donations.filter((d) => d.user === user.username);
      const byCharity = CHARITIES.map((c) => { const amt = round2(mine.filter((d) => d.charity_id === c.id).reduce((s, d) => s + d.amount, 0)); return { id: c.id, name: c.name, slug: c.slug, active: true, amount: amt, times: mine.filter((d) => d.charity_id === c.id).length, all_time: amt }; })
        .filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
      return {
        user: { ...publicUser(), quarter_donated: round2(byCharity.reduce((s, c) => s + c.amount, 0)) },
        day: { key: today, number: 12, quarter: '2026-Q4', resets_at: resetsAt(), quarter_ends_at: quarterEndsAt(), tz: 'America/Chicago' },
        allowance: null, rules: RULES, positions: open, history, donations_by_charity: byCharity, town: townView(),
        crowd: { picks, buys: 21, players: 9, friends: friendsToday },
        friend_count: friends.size,
        vesting: null,
        achievements: achView(),
        new_followers: followSeen ? [] : waiting(),
        wall_unread: wallSeen ? 0 : (walls.get(user.username) || []).filter((w) => w.author !== user.username).length,
        wall_unread_from: wallSeen ? [] : [...new Set((walls.get(user.username) || []).filter((w) => w.author !== user.username).map((w) => w.author))].slice(0, 3),
        wall_latest: wallSeen ? null : ((walls.get(user.username) || []).find((w) => w.author !== user.username) || {}).id || null,
        today_donated: history.filter((h) => h.closed_day === today).reduce((s, h) => s + h.tax, 0),
        needs_charity: !user.charity_id && user.total_donated > 0,
      };
    }
    if (path === '/achievements') return achView();
    if (path === '/admin/overview') return { users: otherPlayers.length + 1, guests: 1, active_today: 4, open_positions: positions.filter((p) => p.status === 'open').length, quarter_lobbyists: round2(donations.reduce((s2, d) => s2 + d.amount, 0)), new_requests: demoRequests.filter((r) => r.status === 'new').length, new_bugs: demoBugs.filter((r) => r.status === 'new').length };
    if (path.startsWith('/admin/transactions')) {
      const tx = [];
      for (const p of positions) {
        if (p.status !== 'gift' && p.status !== 'vested') tx.push({ ref: `p${p.id}`, undoable: true, at: p.opened_at, username: user.username, kind: p.ride_count ? 'ride' : 'buy', what: p.symbol, cash: p.ride_count ? null : -p.invested, amount: p.invested, note: `×${p.multiplier}` });
        if (p.closed_at) tx.push({ ref: `c${p.id}`, undoable: true, at: p.closed_at, username: user.username, kind: p.status === 'gift' ? 'gift' : p.status === 'rolled' ? 'rolled' : (p.proceeds || 0) <= 0 ? 'bust' : 'collect', what: p.symbol, cash: p.status === 'rolled' ? null : round2((p.proceeds || 0) - (p.tax || 0)), profit: p.profit, tax: p.tax, lobbyists: p.tax ? round2(p.tax) : null, charity: p.charity_id ? CHARITIES.find((c) => c.id === p.charity_id).name : null, note: p.tier || '' });
      }
      otherPlayers.forEach((o, i) => { const ref = `l${9000 + i}`; if (!demoUndone.has(o.username)) tx.push({ ref, undoable: true, at: new Date(Date.now() - (i + 1) * 3.6e6).toISOString(), username: o.username, kind: 'allowance', what: '', cash: 110 + i * 10, note: `stipend 100 · streak ${o.streak}` }); });
      tx.sort((a, b) => new Date(b.at) - new Date(a.at));
      return { transactions: tx, more: false };
    }
    if (path === '/admin/positions') return { positions: positions.filter((p) => p.status === 'open').map(shape).map((p) => ({ id: p.id, username: user.username, symbol: p.symbol, invested: p.invested, value: p.value, swing_pct: p.swing_pct, multiplier: p.multiplier, ride_count: p.ride_count || 0, opened_at: p.opened_at, matures_at: p.matures_at, status: p.matured ? 'matured' : 'live' })) };
    if (path === '/admin/users') {
      return { users: [{ username: user.username, is_guest: user.is_guest, is_admin: true, created_at: addDay(today, -11) + 'T15:00:00Z', last_seen_at: new Date().toISOString(), cash: user.cash, lobbyists: user.total_donated, quarter_lobbyists: user.total_donated, realized_pnl: user.realized_pnl, streak: user.streak, open_positions: positions.filter((p) => p.status === 'open').length, total_positions: positions.length, invested_open: 0, cards_played: (town.sides ? town.sides.preston + town.sides.dolores : 0), buildings: Object.values(town.plots).filter(Boolean).length, cat: town.cat && town.cat.name, achievements: 3, friends: friends.size, charity: (CHARITIES.find((c) => c.id === user.charity_id) || {}).name || null }]
        .concat(otherPlayers.map((o) => ({ username: o.username, is_guest: false, is_admin: false, created_at: addDay(today, -20) + 'T15:00:00Z', last_seen_at: new Date(Date.now() - o.hours_ago * 3.6e6).toISOString(), cash: o.cash, lobbyists: o.donated, quarter_lobbyists: round2(o.donated * 0.6), realized_pnl: o.realized_pnl, streak: o.streak, open_positions: 2, total_positions: 9, invested_open: 80, cards_played: 7, buildings: o.town ? o.town.buildings.filter((b) => b.key).length : 0, cat: SEED_PETS[o.username] ? SEED_PETS[o.username].name : null, achievements: 2, friends: 1, charity: o.top_charity }))) };
    }
    if (path === '/admin/lobbyists') return demoLobbyists(new URLSearchParams(qs || '').get('username'));
    if (path === '/admin/requests') return { requests: demoRequests.slice().reverse(), bugs: demoBugs.slice().reverse() };
    if (path === '/admin/switches') { TownRules.migrate(town); return { username: user.username, unlock_all: !!town.admin_all_open, deal_all: !!town.admin_deal_all }; }
    if (path === '/friends') {
      const list = [...friends].map(findPlayer).filter(Boolean).map(friendRow).sort((a, b) => b.quarter_donated - a.quarter_donated || a.username.localeCompare(b.username));
      return { friends: list, added_you: 2, waiting: waiting(), max: 50, your_username: user.username, is_guest: user.is_guest };
    }
    if (/^\/players\/[^/]+\/wall$/.test(path)) {
      const owner = ownerName(decodeURIComponent(path.split('/')[2])); if (!owner) fail('No player by that name.', 404);
      if (!wallOpenTo(owner)) fail(`Only people ${owner} has added can see this wall.`, 403);
      return { posts: wallFor(owner), max: 280 };
    }
    if (path.startsWith('/players/')) return { player: profileOf(decodeURIComponent(path.slice(9))) };
    if (path === '/auth/options') return { google: false, google_client_id: null, password_min: 8 };
    if (path === '/assets') return { assets: ASSETS };
    if (path === '/charities') return { charities: CHARITIES };
    // Past Lobbyfests: none yet (the first is January 1, 2027).
    if (path === '/lobbyfests') return { lobbyfests: [] };
    // The weekly beat: your own charity is featured this week, ×1.25.
    if (path === '/events/current' || path === '/admin/events') {
      const c = CHARITIES.find((x) => x.id === (user.charity_id || 6));
      const ev = { id: 1, kind: 'featured_charity', starts_on: isoDay(-2), ends_on: isoDay(4), charity_id: c.id, charity_name: c.name, multiplier: 1.25, title: 'Featured charity', blurb: '' };
      return path === '/events/current' ? { events: [ev] } : { events: [ev], today };
    }
    // Reminders need a real server (and its keys); the demo has neither.
    if (path === '/push/key') return { key: null, hour: 17 };
    if (path === '/config') return { ...RULES, badges: BADGES };
    if (path.startsWith('/quote/')) { const a = find(decodeURIComponent(path.slice(7))); if (!a) fail('Not in the game.', 404); return { symbol: a.symbol, ...priceOf(a), source: 'demo' }; }
    if (path === '/trickle') {
      const totals = CHARITIES.map((c) => { const ds = donations.filter((d) => d.charity_id === c.id); const q = ds.reduce((s, d) => s + d.amount, 0); return { ...c, quarter_total: q, all_time: q + q * 1.8, quarter_donors: new Set(ds.map((d) => d.user)).size }; });
      const qt = totals.reduce((s, c) => s + c.quarter_total, 0); const pool = 140;
      // The same rules as the real split (src/game.js lobbyfestSplit): $100 minimum, under $5 left out and rerun.
      const pot = Math.max(pool, 100);
      let inn = totals.filter((c) => c.quarter_total > 0);
      for (;;) { const t = inn.reduce((s, c) => s + c.quarter_total, 0); const under = inn.filter((c) => t && pot * c.quarter_total / t < 5); if (!under.length || under.length === inn.length) break; inn = inn.filter((c) => !under.includes(c)); }
      const it = inn.reduce((s, c) => s + c.quarter_total, 0);
      return { quarter: '2026-Q4', quarter_ends_at: quarterEndsAt(), demo: true, pool_usd: pool, payout_usd: pot, min_usd: 100, charity_min_usd: 5, quarter_total: round2(qt), all_time: round2(totals.reduce((s, c) => s + c.all_time, 0)), quarter_donors: 5,
        charities: totals.map((c) => ({ ...c, share: qt ? c.quarter_total / qt : 0, est_usd: inn.includes(c) && it ? round2(pot * c.quarter_total / it) : 0, left_out: c.quarter_total > 0 && !inn.includes(c) })).sort((a, b) => b.quarter_total - a.quarter_total)
          .map((c, i, all) => ({ ...c, rank: i + 1, gap_to_next: i === 0 ? 0 : round2(Math.max(0, all[i - 1].quarter_total - c.quarter_total)) })) };
    }
    if (path === '/leaderboard') {
      const friendsOnly = params.get('friends') === '1';
      const inScope = (name) => !friendsOnly || name === user.username || friends.has(name);
      const myQ = quarterOf(user.username);
      const all_time = [...otherPlayers.map((p) => ({ username: p.username, donated: p.donated, realized_pnl: p.realized_pnl, streak: p.streak, quarter: quarterOf(p.username) })), { username: user.username, donated: user.total_donated, quarter: myQ, realized_pnl: user.realized_pnl, streak: user.streak }]
        .filter((r) => r.donated > 0 && inScope(r.username)).sort((a, b) => b.quarter - a.quarter || b.donated - a.donated);
      const mine = positions.filter((p) => (p.status === 'closed' || p.status === 'rolled') && p.closed_day === today).map((p) => ({ username: user.username, symbol: p.symbol, invested: p.invested, proceeds: p.proceeds, gain_pct: (p.proceeds - p.invested) / p.invested, tier: p.tier }));
      const last_24h = [{ username: 'ravi_k', symbol: 'SOL', invested: 100, proceeds: 212, gain_pct: 1.12, tier: 'Legend' }, { username: 'erin', symbol: 'COST', invested: 50, proceeds: 63.5, gain_pct: 0.27, tier: 'Nice' }, ...mine,
        { username: 'moonshot_mia', symbol: 'DOGE', invested: 40, proceeds: 44.1, gain_pct: 0.1025, tier: 'Respectable' },
        { username: 'bagholder_ben', symbol: 'GME', invested: 80, proceeds: 0, gain_pct: -1, tier: 'Rest in peace' }].filter((r) => inScope(r.username)).sort((a, b) => b.gain_pct - a.gain_pct);
      const held = [
        ...positions.filter((p) => p.status === 'open').map((p) => ({ username: user.username, ...shape(p) })),
        ...otherPlayers.flatMap((pl) => pl.positions().map((p) => ({ username: pl.username, ...shape(p) }))),
      ].filter((r) => inScope(r.username)).map((r) => ({ username: r.username, symbol: r.symbol, name: r.name, invested: r.invested, value: r.value != null ? r.value : r.invested, swing_pct: r.swing_pct, multiplier_now: r.multiplier_now, matured: r.matured, ride_count: r.ride_count || 0, priced: r.value != null }));
      const biggest = held.sort((a, b) => b.value - a.value).slice(0, 25);
      return { quarter: '2026-Q4', quarter_ends_at: quarterEndsAt(), friends_only: friendsOnly, all_time, last_24h, biggest };
    }
    fail('Not found.', 404);
  }

  async function post(path, body = {}) {
    await sleep(160);
    if (path.startsWith('/auth/')) {
      if (path === '/auth/google' || path === '/auth/link-google') fail('Google sign-in is not available in the demo.');
      if (path === '/auth/logout-all') return { ok: true };
      if (path === '/auth/device-code') return { code: 'DEMO-CODE', expires_at: new Date(Date.now() + 15 * 60e3).toISOString(), ttl_minutes: 15 };
      if (path === '/auth/redeem-code') fail("Device codes don't work in the demo; nothing is saved to begin with.");
      if (path === '/auth/username') { if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username || '')) fail('Usernames are 3–20 letters, numbers or underscores.'); user.username = body.username; return { user: publicUser() }; }
      if (path === '/auth/password') { if (String(body.password || '').length < 8) fail('Passwords need at least 8 characters.'); user.has_password = true; return { token: 'demo', user: publicUser() }; }
      if (path === '/auth/claim' || path === '/auth/register') { if (!/^[A-Za-z0-9_]{3,20}$/.test(body.username || '')) fail('Usernames are 3–20 letters, numbers or underscores.'); if (String(body.password || '').length < 8) fail('Passwords need at least 8 characters.'); user.has_password = true; donations.forEach((d) => { if (d.user === user.username) d.user = body.username; }); user.username = body.username; user.is_guest = false; }
      if (path === '/auth/login') { if (!body.username) fail('Wrong username or password.', 401); user.username = body.username; user.is_guest = false; }
      return { token: 'demo', user: publicUser() };
    }
    if (path === '/charity/choose') {
      const c = CHARITIES.find((x) => x.id === Number(body.charity_id));
      if (!c) fail("That charity isn't on the list.");
      const had = !!user.charity_id;
      let moved = 0;
      if (!had) {
        const mine = donations.filter((d) => d.user === user.username);
        const have = new Map(); for (const d of mine) have.set(d.charity_id, round2((have.get(d.charity_id) || 0) + d.amount));
        for (const [id, n] of have) if (id !== c.id && n > 0) { donations.push({ charity_id: id, amount: -n, user: user.username }, { charity_id: c.id, amount: n, user: user.username }); moved = round2(moved + n); }
      }
      user.charity_id = c.id;
      const me = await get('/me');
      return { ok: true, moved, charity: { id: c.id, name: c.name }, user: publicUser(), donations_by_charity: me.donations_by_charity };
    }
    if (path === '/charity-requests') {
      if (String(body.name || '').trim().length < 2) fail("What's the charity called?");
      demoRequests.push({ id: demoRequests.length + 1, name: String(body.name).trim().slice(0, 100), url: String(body.url || '').trim(), reason: String(body.reason || '').trim().slice(0, 600), status: 'new', created_at: new Date().toISOString(), username: user.username });
      return { ok: true };
    }
    if (path === '/bugs') {
      if (String(body.description || '').trim().length < 4) fail('Say a few words about what went wrong.');
      demoBugs.push({ id: demoBugs.length + 1, description: String(body.description).trim().slice(0, 2000), url: String(body.url || ''), client: String(body.client || '').slice(0, 300), status: 'new', created_at: new Date().toISOString(), username: user.username });
      return { ok: true };
    }
    if (path === '/admin/transactions/undo') {
      const ref = String(body.ref || ''), dry = body.dry_run === true;
      if (ref[0] === 'l') {
        const i = Number(ref.slice(1)) - 9000, o = otherPlayers[i];
        if (!o || demoUndone.has(o.username)) fail('That one is already gone.', 404);
        const want = -(110 + i * 10), before = o.cash, after = round2(Math.max(0, before + want));
        if (!dry) { demoUndone.add(o.username); o.cash = after; }
        return { ok: true, dry_run: dry, username: o.username, label: 'allowance', note: 'Takes the allowance back.', cash: round2(after - before), cash_wanted: want, cash_before: before, lobbyists: 0, pnl: 0, reopened: [], items: [] };
      }
      const p = positions.find((x) => x.id === Number(ref.slice(1))); if (!p) fail('That one is already gone.', 404);
      const want = round2((p.ride_count || p.status === 'gift' ? 0 : p.invested) - (p.closed_at && p.status !== 'rolled' ? (p.proceeds || 0) - (p.tax || 0) : 0));
      const before = user.cash, after = round2(Math.max(0, before + want));
      if (!dry) { positions.splice(positions.indexOf(p), 1); user.cash = after; }
      return { ok: true, dry_run: dry, username: user.username, label: `${p.symbol} position`, cash: round2(after - before), cash_wanted: want, cash_before: before, lobbyists: 0, pnl: 0, reopened: [],
        items: [{ kind: p.status === 'gift' ? 'gift' : p.ride_count ? 'ride' : 'buy', what: p.symbol, invested: p.invested, multiplier: p.multiplier, status: p.status, proceeds: p.proceeds == null ? null : p.proceeds, tax: p.tax == null ? null : p.tax }] };
    }
    if (path === '/admin/lobbyists/remove') {
      const info = demoLobbyists(body.username), dry = body.dry_run === true;
      let removed = 0;
      for (const t of [].concat(body.take || [])) {
        const c = info.donations_by_charity.find((x) => x.id === Number(t && t.charity_id));
        const k = c ? round2(Math.min(Number(t.amount) || 0, c.amount)) : 0;
        if (k <= 0) continue;
        removed = round2(removed + k);
        if (dry) continue;
        if (info.username === user.username) donations.push({ charity_id: c.id, amount: -k, user: user.username });
        else { const o = otherPlayers.find((x) => x.username === info.username); o.donated = round2(Math.max(0, o.donated - k)); }
      }
      if (!removed) fail("They don't have those lobbyists this quarter.");
      if (!dry && info.username === user.username) user.total_donated = round2(Math.max(0, user.total_donated - removed));
      return { ok: true, dry_run: dry, username: info.username, removed, donations_by_charity: demoLobbyists(info.username).donations_by_charity };
    }
    if (path === '/admin/users/remove') {
      const names = [...new Set([].concat(body.usernames || []).map((n) => String(n).toLowerCase()))];
      if (names.includes(user.username.toLowerCase())) fail(`Admin accounts can't be removed here (${user.username}).`);
      const list = names.map((n) => otherPlayers.find((o) => o.username.toLowerCase() === n));
      if (!list.length || list.some((x) => !x)) fail('No player by that name.', 404);
      const summary = list.map((o) => ({ username: o.username, is_guest: false, cash: o.cash, lobbyists: o.donated, quarter_lobbyists: round2(o.donated * 0.6), positions: 9, followers: friends.has(o.username) ? 1 : 0 }));
      const word = list.length === 1 ? list[0].username : String(list.length);
      if (body.dry_run === true) return { ok: true, dry_run: true, confirm_with: word, users: summary };
      if (String(body.confirm || '').trim().toLowerCase() !== word.toLowerCase()) fail(`To confirm, type ${list.length === 1 ? 'the username' : 'the number of players'}: ${word}`);
      for (const o of list) { otherPlayers.splice(otherPlayers.indexOf(o), 1); friends.delete(o.username); }
      return { ok: true, removed: list.length, users: summary };
    }
    if (path.startsWith('/admin/requests/')) {
      const [, , , kind, id] = path.split('/');
      const list = kind === 'charity' ? demoRequests : demoBugs;
      const r = list.find((x) => x.id === Number(id)); if (!r) fail('Not found.', 404);
      r.status = body.status; return { ok: true };
    }
    if (path === '/lobbyists/assign') {
      const mine = donations.filter((d) => d.user === user.username);
      const have = new Map();
      for (const d of mine) have.set(d.charity_id, round2((have.get(d.charity_id) || 0) + d.amount));
      let moved = 0;
      if (Array.isArray(body.allocation)) {
        const total = round2([...have.values()].filter((n) => n > 0).reduce((a, n) => a + n, 0));
        const want = new Map(body.allocation.map((a) => [Number(a.charity_id), round2(Number(a.amount))]));
        const asked = round2([...want.values()].reduce((a, n) => a + n, 0));
        if ([...want.values()].some((n) => !(n >= 0))) fail('Each charity needs a lobbyist count of zero or more.');
        if (Math.abs(asked - total) > 0.011) fail(`That's ${asked} lobbyists; you have ${total} this quarter. Every one needs a charity.`);
        for (const id of new Set([...have.keys(), ...want.keys()])) {
          const diff = round2((want.get(id) || 0) - Math.max(0, have.get(id) || 0));
          if (Math.abs(diff) < 0.01) continue;
          donations.push({ charity_id: id, amount: diff, user: user.username });
          if (diff > 0) moved = round2(moved + diff);
        }
      }
      if (body.default_charity_id != null) {
        if (!CHARITIES.some((c) => c.id === Number(body.default_charity_id))) fail("That charity isn't on the list.");
        user.charity_id = Number(body.default_charity_id);
      }
      const now = donations.filter((d) => d.user === user.username);
      const split = CHARITIES.map((c) => { const amt = round2(now.filter((d) => d.charity_id === c.id).reduce((a, d) => a + d.amount, 0)); return { id: c.id, name: c.name, slug: c.slug, amount: Math.max(0, amt), times: 0, all_time: amt }; })
        .filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
      return { ok: true, moved, user: { ...publicUser(), quarter_donated: round2(split.reduce((a, c) => a + c.amount, 0)) }, donations_by_charity: split };
    }
    if (path === '/admin/grant') {
      const cash = Math.max(0, Number(body.cash) || 0), lob = Math.max(0, Number(body.lobbyists) || 0);
      if (!cash && !lob) fail('Grant something: cash, lobbyists, or both.');
      user.cash = round2(user.cash + cash); user.total_donated = round2(user.total_donated + lob);
      if (lob) donations.push({ charity_id: user.charity_id || 1, amount: lob, user: user.username });
      return { ok: true, user: publicUser(), town: townView() };
    }
    if (path === '/admin/reset') {
      positions.length = 0; earned.clear(); user.cash = 100; user.total_donated = 0; user.realized_pnl = 0; user.streak = 1; user.vested = false; user.charity_id = null;
      for (let i = donations.length - 1; i >= 0; i--) if (donations[i].user === user.username) donations.splice(i, 1);
      friends.clear();
      for (const k of Object.keys(town)) delete town[k];
      Object.assign(town, TownRules.fresh());
      TownRules.tick(town, townCtx());
      return { ok: true, self: true };
    }
    if (path === '/town/cat/name' || path === '/town/cat/buy' || path === '/town/cat/wear') {
      const r = path.endsWith('/name') ? TownRules.nameCat(town, body)
        : path.endsWith('/buy') ? TownRules.buyCatItem(town, String(body.item || ''), user.cash)
          : TownRules.wearCatItem(town, String(body.item || ''), body.on !== false);
      if (r.error) fail(r.error);
      if (r.cash) user.cash = round2(user.cash + r.cash);
      return { ok: true, user: publicUser(), town: townView() };
    }
    if (path === '/admin/switches') {
      const want = {};
      if (typeof body.unlock_all === 'boolean') want.unlockAll = body.unlock_all;
      if (typeof body.deal_all === 'boolean') want.dealAll = body.deal_all;
      if (TownRules.isUnlocked(user.total_donated)) TownRules.ensureIssues(town, townCtx());
      const r = TownRules.adminSwitch(town, townCtx(), want);
      return { ok: true, ...r, user: publicUser(), town: townView() };
    }
    if (path === '/admin/unlock') {
      const r = TownRules.adminUnlock(town, body.all === true ? '*' : [].concat(body.issue_id || []));
      if (!r.unlocked) fail('No such card.');
      return { ok: true, unlocked: r.unlocked, user: publicUser(), town: townView() };
    }
    if (path === '/admin/deal') {
      if (!TownRules.isUnlocked(user.total_donated)) fail("TrickleTown isn't open for this player yet: they need a lobbyist first (grant one).");
      if (body.all === true) { const ids = TownRules.dealAllUnlocked(town, townCtx()); if (!ids.length) fail('Every unlocked card is already on the agenda.'); return { ok: true, dealt: ids, user: publicUser(), town: townView() }; }
      const r = TownRules.deal(town, String(body.issue_id || ''));
      if (r.error) fail(r.error);
      return { ok: true, dealt: r.dealt, user: publicUser(), town: townView() };
    }
    if (path === '/achievements/claim' || path === '/vest') {
      const key = path === '/vest' ? 'first_buy' : String(body.key || '');
      const a = ACH.find((x) => x.key === key); if (!a) fail('No such achievement.');
      achView(); const e = earned.get(key);
      if (!e) fail(`Not yet: ${a.how}`);
      if (e.claimed_at) fail('Already in your pocket. Mommy and Daddy only pay once.');
      const amount = a.gift, profit = amount, tax = round2(profit * RULES.tax_rate), net = round2(amount - tax);
      const charity = CHARITIES.find((c) => c.id === user.charity_id) || CHARITIES.find((c) => c.id === Number(body.charity_id)) || CHARITIES[0];
      const hireCost = TownRules.hireCost(town); const lobbyists = round2(tax / hireCost);
      positions.push({ id: nextId++, symbol: 'GIFT', name: a.title, asset_type: 'stock', multiplier: 1, invested: 0, status: 'gift', proceeds: amount, profit, tax, lobbyists, tier: 'Gift', charity_id: charity.id, collected: true, gift: true, closed_day: today, closed_at: new Date().toISOString() });
      user.cash = round2(user.cash + net); user.total_donated = round2(user.total_donated + lobbyists); user.realized_pnl = round2(user.realized_pnl + profit); user.charity_id = user.charity_id || charity.id;
      donations.push({ charity_id: charity.id, amount: lobbyists, user: user.username });
      Object.assign(e, { claimed_at: new Date().toISOString(), lobbyists });
      TownRules.ensureIssues(town, townCtx());
      return { ok: true, user: publicUser(), town: townView(), achievements: achView(), receipt: { position_id: nextId - 1, symbol: 'GIFT', name: a.title, invested: 0, value: amount, profit, tax, net, tier: 'Gift', lobbyists, hire_cost: hireCost, collected: true, gift: true, achievement: { key, title: a.title, from: a.from }, charity } };
    }
    if (path === '/buy') {
      const a = find(body.symbol); const amount = round2(Number(body.amount));
      if (!a) fail('Pick something from the list.'); if (!(amount >= 0.01)) fail('Invest at least a penny.');
      if (amount > user.cash) fail(`You only have $${user.cash.toFixed(2)} to invest.`);
      const q = priceOf(a); user.cash = round2(user.cash - amount);
      const p = { id: nextId++, symbol: a.symbol, name: a.name, asset_type: a.type, multiplier: a.multiplier, invested: amount, entry_price: q.price, opened_at: new Date().toISOString(), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS).toISOString(), status: 'open' };
      positions.push(p); return { ok: true, position: shape(p), cash: user.cash, quote: q };
    }
    if (path === '/town/decide') {
      if (!TownRules.isUnlocked(user.total_donated)) fail('TrickleTown opens when you hire your first full lobbyist.');
      const r = TownRules.decide(town, String(body.issue_id || ''), body.side, user.cash);
      if (r.error) fail(r.error);
      user.cash = round2(Math.max(0, user.cash + r.cash));
      // How the other landlords answered today: invented, but stable per card.
      const n = 5 + Math.floor(hash(String(body.issue_id) + today) * 40); const pPreston = Math.round(n * (0.35 + hash(String(body.issue_id)) * 0.4));
      const crowd = { preston: pPreston + (body.side === 'preston' ? 1 : 0), dolores: n - pPreston + (body.side === 'dolores' ? 1 : 0) };
      return { ok: true, cash_change: r.cash, fx: r.fx, noted: r.noted, side: r.side, crowd, user: publicUser(), town: townView() };
    }
    if (path === '/town/upgrade') {
      if (!TownRules.isUnlocked(user.total_donated)) fail('TrickleTown opens when you hire your first full lobbyist.');
      const r = TownRules.upgrade(town, String(body.slot || ''), String(body.key || ''), user.cash, townCtx());
      if (r.error) fail(r.error);
      user.cash = round2(user.cash + r.cash);
      const dealt = TownRules.dealNewUnlocks(town, townCtx());
      return { ok: true, user: publicUser(), town: townView(), fresh_cards: dealt.map((id) => (TownRules.ISSUES.find((i) => i.id === id) || {}).title) };
    }
    if (path === '/town/build') {
      if (!TownRules.isUnlocked(user.total_donated)) fail('TrickleTown opens when you hire your first full lobbyist.');
      const r = TownRules.build(town, String(body.slot || ''), String(body.key || ''), user.cash, today);
      if (r.error) fail(r.error);
      user.cash = round2(user.cash + r.cash);
      const dealt = TownRules.dealNewUnlocks(town, townCtx());
      return { ok: true, user: publicUser(), town: townView(), fresh_cards: dealt.map((id) => (TownRules.ISSUES.find((i) => i.id === id) || {}).title) };
    }
    if (/^\/players\/[^/]+\/wall$/.test(path)) {
      const owner = ownerName(decodeURIComponent(path.split('/')[2])); if (!owner) fail('No player by that name.', 404);
      if (!wallOpenTo(owner)) fail(`Only people ${owner} has added can write here.`, 403);
      // Same clean-up as the server's cleanWallBody.
      const text = String(body.body || '').normalize('NFC').replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n').replace(/(?!\n|\u200D)[\p{Cc}\p{Cf}]/gu, '')
        .replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) fail('Write something first.');
      if ([...text].length > 280) fail('Keep it to 280 characters.');
      if (!walls.has(owner)) walls.set(owner, []);
      walls.get(owner).unshift({ id: wallNext++, author: user.username, body: text, at: new Date().toISOString() });
      return { ok: true, posts: wallFor(owner) };
    }
    if (/^\/wall\/\d+\/delete$/.test(path)) {
      const id = Number(path.split('/')[2]);
      for (const [owner, list] of walls) {
        const i = list.findIndex((w) => w.id === id);
        if (i >= 0) { if (list[i].author !== user.username && owner !== user.username) break; list.splice(i, 1); return { ok: true, posts: wallFor(owner) }; }
      }
      fail('No such post.', 404);
    }
    if (path === '/friends/seen') { followSeen = true; return { ok: true }; }
    if (path === '/friends/add') {
      const t = findPlayer(body.username);
      if (String(body.username || '').toLowerCase() === user.username.toLowerCase()) fail("That's you. You're already on your own side.");
      if (!t) fail('No player by that name. Usernames are case-insensitive; check the spelling. (In the demo, try ravi_k or bagholder_ben.)', 404);
      friends.add(t.username); return { ok: true, username: t.username, friend_count: friends.size };
    }
    if (path === '/friends/invite') return { ok: true, username: String(body.from || '') };
    if (path === '/friends/remove') { const t = findPlayer(body.username); if (t) friends.delete(t.username); return { ok: true, friend_count: friends.size }; }
    if (path === '/ride') {
      const p = positions.find((x) => x.id === Number(body.position_id)); if (!p) fail('No such position.', 404); if (p.status !== 'open') fail('Already collected.');
      settleMatured();
      if (!p.matured_at) fail("It hasn't matured yet. You can only let a matured position ride.");
      if (!(p.matured_value >= 0.01)) fail("There's nothing left to ride.");
      // Riding is taxed too, at half the rate: the profit so far is realized,
      // the lobbyists get hired, and what's left rolls into a fresh 24 hours.
      const rate = RULES.tax_rate * RULES.ride_tax_factor;
      const q = priceOf(find(p.symbol)); const profit = round2(p.matured_value - p.invested);
      const tax = profit > 0 ? round2(profit * rate) : 0; const net = round2(p.matured_value - tax);
      const deferred = profit > 0 ? round2(profit * RULES.tax_rate - tax) : 0;
      const mults = rideMults(p);
      const charity = tax > 0 ? (CHARITIES.find((c) => c.id === user.charity_id) || CHARITIES.find((c) => c.id === Number(body.charity_id)) || CHARITIES[0]) : null;
      const hireCost = TownRules.hireCost(town); const lobbyists = tax > 0 ? round2(tax / hireCost) : 0;
      Object.assign(p, { status: 'rolled', closed_day: today, closed_at: new Date().toISOString(), proceeds: p.matured_value, profit, tax, lobbyists, tier: tierFor(p.invested, p.matured_value), charity_id: charity ? charity.id : null, collected: true });
      user.total_donated = round2(user.total_donated + lobbyists); user.realized_pnl = round2(user.realized_pnl + profit); if (charity) user.charity_id = user.charity_id || charity.id;
      if (lobbyists > 0) donations.push({ charity_id: charity.id, amount: lobbyists, user: user.username });
      const n = { id: nextId++, symbol: p.symbol, name: p.name, asset_type: p.asset_type, multiplier: mults.ceiling, mult_floor: mults.floor, invested: net, entry_price: q.price, opened_at: new Date().toISOString(), opened_day: today, matures_at: new Date(Date.now() + HOLD_MS).toISOString(), status: 'open', rolled_from: p.id, ride_count: (p.ride_count || 0) + 1, origin_invested: p.origin_invested != null ? p.origin_invested : p.invested, deferred_tax: deferred };
      positions.push(n);
      return { ok: true, position: shape(n), user: publicUser(), rolled: { from: p.id, value: p.matured_value, profit, tax, rate, deferred, lobbyists, hire_cost: hireCost, net, tier: p.tier, mult_floor: mults.floor, multiplier: mults.ceiling, charity: charity ? { id: charity.id, name: charity.name } : null }, quote: q };
    }
    if (path === '/sell') {
      const p = positions.find((x) => x.id === Number(body.position_id)); if (!p) fail('No such position.', 404); if (p.status !== 'open') fail('Already collected.');
      settleMatured();
      const exitPrice = p.matured_at ? p.matured_price : priceOf(find(p.symbol)).price;
      const live = valueOf(p, exitPrice, p.matured_at ? new Date(p.matures_at).getTime() : Date.now()); if (p.matured_at) live.value = p.matured_value;
      // A ride sold early owes the half of the tax it skipped; matured, it has earned it back.
      const s = settle(p.invested, live.value, p.matured_at ? 0 : (p.deferred_tax || 0));
      // A profit needs a charity; fall back to the player's usual one if none came through.
      let charity = null;
      if (s.tax > 0) {
        charity = CHARITIES.find((c) => c.id === user.charity_id) || CHARITIES.find((c) => c.id === Number(body.charity_id)) || CHARITIES[0];
      }
      const hireCost = TownRules.hireCost(town);
      const lobbyists = s.tax > 0 ? round2(s.tax / hireCost) : 0;
      Object.assign(p, { status: 'closed', closed_day: today, closed_at: new Date().toISOString(), proceeds: live.value, profit: s.profit, tax: s.tax, lobbyists, tier: s.tier, charity_id: charity ? charity.id : null, collected: !!p.matured_at });
      user.cash = round2(user.cash + s.net); user.total_donated = round2(user.total_donated + lobbyists); user.realized_pnl = round2(user.realized_pnl + s.profit); if (charity) user.charity_id = user.charity_id || charity.id;
      if (lobbyists > 0) donations.push({ charity_id: charity.id, amount: lobbyists, user: user.username });
      return { ok: true, user: publicUser(), receipt: { position_id: p.id, symbol: p.symbol, name: p.name, invested: p.invested, value: live.value, ...live, ...s, lobbyists, hire_cost: hireCost, collected: !!p.matured_at, exit_price: exitPrice, charity } };
    }
    // Admin forms: accepted, and forgotten (the demo saves nothing).
    if (['/admin/lobbyfests', '/admin/lobbyfests/delete', '/admin/events', '/admin/events/delete'].includes(path)) return { ok: true };
    if (path === '/push/subscribe' || path === '/push/unsubscribe') fail("Reminders need the real site.", 400);
    fail('Not found.', 404);
  }

  // First /me of the page load behaves like the day's first visit, so the
  // coin toss and the allowance toast show in the demo.
  let firstMe = true;
  const origGet = get;
  get = async function (path) {
    const out = await origGet(path);
    if (path === '/me' && firstMe) {
      firstMe = false;
      out.allowance = { amount: 120 + TownRules.income(town), streak: 3, base: 120, town_income: TownRules.income(town) };
      // A night's worth of news for "While you were out".
      out.user.last_seen_at = new Date(Date.now() - 30 * 3600e3).toISOString();
      if (out.town) out.town.expired_yesterday = 2;
    }
    return out;
  };

  let token = 'demo';
  window.API = { token: () => token, setToken: (t) => { token = t; }, get, post, demo: true };
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.textContent = 'Demo. The prices are invented and move fast, the money is pretend, and nothing is saved.';
    document.body.prepend(b);
  });
})();
