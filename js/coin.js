// The coin. Pure drawing: takes numbers, returns SVG markup. No app state here.
//
//   Coin.front({ positions, cash, preview })  the ring of wedges + the fan of bills
//   Coin.back({ slices })                     a donut of donations by charity
//
// Geometry: 320×320 viewBox, ring between radius 84 and 150, angles clockwise
// from 12 o'clock. Positions come first (oldest first), then the cash sector,
// so a slice carved from the start of the cash sector sits right where the
// next wedge will appear.
window.Coin = (function () {
  const CX = 160, CY = 160, R = 150, RI = 84, RM = (R + RI) / 2;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function polar(r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }
  const f = (n) => n.toFixed(2);

  function sector(a0, sweep, r0 = RI, r1 = R) {
    sweep = Math.max(0, Math.min(359.99, sweep));
    if (sweep <= 0) return '';
    const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a0 + sweep);
    const [xi1, yi1] = polar(r0, a0 + sweep), [xi0, yi0] = polar(r0, a0);
    const large = sweep > 180 ? 1 : 0;
    return `M${f(x0)} ${f(y0)} A${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)} L${f(xi1)} ${f(yi1)} A${r0} ${r0} 0 ${large} 0 ${f(xi0)} ${f(yi0)} Z`;
  }

  function label(a0, sweep, lines, cls = '') {
    if (sweep < 22) return '';
    const [x, y] = polar(RM, a0 + sweep / 2);
    const first = lines[0], second = sweep >= 38 ? lines[1] : null;
    return `<text class="wedge-label ${cls}" x="${f(x)}" y="${f(y)}" text-anchor="middle">
      <tspan x="${f(x)}" dy="${second ? '-0.15em' : '0.35em'}" class="wl-ticker">${esc(first)}</tspan>
      ${second ? `<tspan x="${f(x)}" dy="1.2em" class="wl-sub">${esc(second)}</tspan>` : ''}
    </text>`;
  }

  // A fan of bills along the cash sector. One bill per $10, 1..20 of them.
  function bills(a0, sweep, cash) {
    if (sweep <= 0 || cash <= 0) return '';
    const n = Math.max(1, Math.min(20, Math.ceil(cash / 10)));
    const step = sweep / n;
    let out = '';
    for (let i = 0; i < n; i++) {
      const a = a0 + step * (i + 0.5);
      const [x, y] = polar(RM, a);
      out += `<g class="bill" transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})">
        <rect x="-11" y="-21" width="22" height="42" rx="2"/>
        <rect x="-8" y="-18" width="16" height="36" rx="1" class="bill-inner"/>
        <text y="4" text-anchor="middle" class="bill-text">$</text>
      </g>`;
    }
    return out;
  }

  // positions: [{ id, symbol, value, swing_pct, busted, quote_error }], cash: number,
  // preview: { amount } | null, grow: { id, t } | null (t in 0..1)
  function front({ positions, cash, preview, grow }) {
    const items = positions.map((p) => {
      let v = p.quote_error ? p.invested : p.value;
      if (grow && grow.id === p.id) v *= grow.t;
      return { ...p, v };
    });
    let cashShown = cash;
    if (grow) { const g = items.find((p) => p.id === grow.id); if (g) cashShown += (g.quote_error ? g.invested : g.value) * (1 - grow.t); }
    const total = items.reduce((s, p) => s + p.v, 0) + cashShown;
    const deg = (v) => (total > 0 ? (v / total) * 360 : 0);

    let a = 0, wedges = '', labels = '';
    for (const p of items) {
      const sw = p.busted ? Math.max(deg(p.v), 2.5) : deg(p.v);
      if (sw <= 0) continue;
      const cls = p.quote_error ? 'stale' : p.busted ? 'busted' : p.swing_pct > 0 ? 'up' : p.swing_pct < 0 ? 'down' : 'flat';
      wedges += `<path class="wedge ${cls}" data-id="${p.id}" d="${sector(a, sw)}" tabindex="0" role="button" aria-label="${esc(p.symbol)}, ${p.busted ? 'gone' : 'worth $' + p.v.toFixed(2)}"><title>${esc(p.symbol)} ${p.busted ? 'RIP' : '$' + p.v.toFixed(2)}</title></path>`;
      const sub = p.quote_error ? '?' : p.busted ? 'RIP' : `${p.swing_pct > 0 ? '+' : ''}${Math.round(p.swing_pct * 100)}%`;
      labels += label(a, sw, [p.symbol, sub], cls);
      a += sw;
    }
    const cashSweep = deg(cashShown);
    let cashLayer = '';
    if (cashSweep > 0) {
      cashLayer += `<path class="cash-sector" d="${sector(a, cashSweep)}"/>`;
      cashLayer += bills(a, cashSweep, cashShown);
      if (preview && preview.amount > 0) {
        const sw = Math.min(cashSweep, deg(preview.amount));
        cashLayer += `<path class="preview-slice" d="${sector(a, sw, RI - 4, R + 4)}"/>`;
      }
    }
    return `<svg class="coin-svg" viewBox="0 0 320 320" aria-label="Your money as a ring">
      <circle cx="${CX}" cy="${CY}" r="${R + 6}" class="coin-rim"/>
      <circle cx="${CX}" cy="${CY}" r="${RI}" class="coin-hole"/>
      ${wedges}${cashLayer}${labels}
      ${total <= 0 ? `<circle cx="${CX}" cy="${CY}" r="${RM}" class="coin-empty-ring"/>` : ''}
    </svg>`;
  }

  // slices: [{ name, amount }]
  function back({ slices }) {
    const total = slices.reduce((s, c) => s + c.amount, 0);
    let a = 0, wedges = '', labels = '';
    slices.forEach((c, i) => {
      const sw = total > 0 ? (c.amount / total) * 360 : 0;
      if (sw <= 0) return;
      wedges += `<path class="bwedge b${i % 6}" d="${sector(a, sw)}"><title>${esc(c.name)} $${c.amount.toFixed(2)}</title></path>`;
      const short = c.name.length > 14 ? c.name.split(/[\s:]+/)[0] : c.name;
      labels += label(a, sw, [short, `$${c.amount.toFixed(2)}`], 'back');
      a += sw;
    });
    return `<svg class="coin-svg" viewBox="0 0 320 320" aria-label="Your donations by charity">
      <circle cx="${CX}" cy="${CY}" r="${R + 6}" class="coin-rim back"/>
      ${total > 0 ? wedges + labels : `<circle cx="${CX}" cy="${CY}" r="${RM}" class="coin-empty-ring back"/>`}
      <circle cx="${CX}" cy="${CY}" r="${RI}" class="coin-hole back"/>
      <path class="back-emblem" transform="translate(${CX - 10} ${CY + 24}) scale(1.6)" d="M5 0 C5 4 1 6.5 1 9.5 a4 4 0 0 0 8 0 C9 6.5 5 4 5 0Z"/>
    </svg>`;
  }

  return { front, back };
})();
