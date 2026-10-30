// When the US stock market is open, so the Buy box can say so when it isn't.
//
// Regular hours only: 9:30am to 4pm Eastern, weekdays, minus NYSE holidays,
// with 1pm closes on the early-close days. Prices in the game come from the
// regular session, so a stock bought outside it sits still until the bell.
// Crypto never closes.
//
// HOLIDAYS and EARLY come from NYSE's published calendar (announced Dec 2025,
// through 2028). Add the next years when NYSE publishes them; after the last
// listed year every weekday counts as open.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Market = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
  ]);
  const EARLY = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
  const TZ = 'America/New_York';
  const HOUR = 3600e3;

  let fmt = null;
  // Eastern wall-clock parts of an instant.
  function etParts(ms) {
    if (!fmt) fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = {};
    for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
  }
  // The instant an Eastern wall-clock time happens.
  function etToMs(y, m, d, h, mi) {
    const guess = Date.UTC(y, m - 1, d, h, mi);
    const off = (ms) => { const p = etParts(ms); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60e3) * 60e3; };
    let t = guess - off(guess);
    const o2 = off(t);
    if (guess - o2 !== t) t = guess - o2;
    return t;
  }
  const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // The session on one Eastern calendar day, or null.
  function sessionOn(y, m, d) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const k = key(y, m, d);
    if (wd === 0 || wd === 6 || HOLIDAYS.has(k)) return null;
    return { day: k, open: etToMs(y, m, d, 9, 30), close: etToMs(y, m, d, EARLY.has(k) ? 13 : 16, 0), early: EARLY.has(k) };
  }

  // Sessions that overlap [from, to), in order.
  function sessions(from, to) {
    const out = [];
    const s = etParts(from);
    for (let i = 0; i < 40; i++) {
      const dt = new Date(Date.UTC(s.y, s.m - 1, s.d + i));
      const sess = sessionOn(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      if (!sess) continue;
      if (sess.open >= to) break;
      if (sess.close > from) out.push(sess);
    }
    return out;
  }

  // Where the market stands at `now`, for a position held `holdHours`.
  //   open        trading right now
  //   closes_at   when today's session ends (if open)
  //   next_open   when the next session starts (after today's, if open)
  //   open_hours  hours of trading inside the hold
  //   quiet       closed now, or the hold catches under half a normal day of
  //               trading (a Friday afternoon, the eve of a holiday)
  function status(now = Date.now(), holdHours = 24) {
    const end = now + holdHours * HOUR;
    const within = sessions(now, end);
    const cur = within.find((x) => x.open <= now && now < x.close) || null;
    let openMs = 0;
    for (const x of within) openMs += Math.max(0, Math.min(x.close, end) - Math.max(x.open, now));
    const next = within.find((x) => x.open > now) || sessions(now, now + 20 * 24 * HOUR).find((x) => x.open > now) || null;
    const openHours = Math.round(openMs / HOUR * 10) / 10;
    return {
      open: !!cur,
      closes_at: cur ? cur.close : null,
      next_open: next ? next.open : null,
      open_hours: openHours,
      quiet: !cur || openHours < 3.25,
    };
  }

  return { status, sessions, HOLIDAYS, EARLY };
}));
