// The coin. Pure drawing: takes numbers, returns SVG markup. No app state here.
//
//   Coin.front({ positions, cash, preview, grow })  the ring of wedges + the fan of bills
//   Coin.back({ slices })                           a donut of lobbyists by charity
//
// Geometry: 320×320 viewBox. Milled edge 150–160, wedge ring 84–146, inset
// center under 84. Angles clockwise from 12 o'clock. Positions come first
// (oldest first), then the cash sector, so a slice carved from the start of
// the cash sector sits right where the next wedge will appear.
//
// Wedges are labeled with the dollars in them and colored by how they're doing:
// pale to strong green for gains, pale to strong rust for losses, dark when
// busted, a gold edge once matured. The return itself lives in the tooltip.
window.Coin = (function () {
  const CX = 160, CY = 160, R = 146, RI = 84, RM = (R + RI) / 2;
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

  // Linear blend of two hex colours, k in 0..1.
  function mix(a, b, k) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('');
  }
  // Colour by outcome. Intensity saturates around ±60%.
  function wedgeFill(p) {
    if (p.quote_error) return '#C9D4D9';
    if (p.busted) return '#0F2430';
    const s = p.swing_pct || 0;
    const k = Math.min(1, Math.abs(s) / 0.6);
    if (s > 0) return mix('#DDF0E6', '#2E9C72', k);
    if (s < 0) return mix('#F4E1DC', '#C04A35', k);
    return '#CDE4EB';
  }
  const money = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(n % 1 ? 2 : 0)}`);

  function label(a0, sweep, lines, cls = '', light = false) {
    if (sweep < 20) return '';
    const [x, y] = polar(RM, a0 + sweep / 2);
    const second = sweep >= 34 ? lines[1] : null;
    return `<text class="wedge-label ${cls} ${light ? 'light' : ''}" x="${f(x)}" y="${f(y)}" text-anchor="middle">
      <tspan x="${f(x)}" dy="${second ? '-0.1em' : '0.35em'}" class="wl-ticker">${esc(lines[0])}</tspan>
      ${second ? `<tspan x="${f(x)}" dy="1.25em" class="wl-sub">${esc(second)}</tspan>` : ''}
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
      const [x, y] = polar(RM + 2, a);
      out += `<g class="bill" transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})">
        <rect x="-10" y="-20" width="20" height="40" rx="2"/>
        <rect x="-7.5" y="-17.5" width="15" height="35" rx="1" class="bill-inner"/>
        <text y="4" text-anchor="middle" class="bill-text">$</text>
      </g>`;
    }
    return out;
  }

  // The coin body: milled edge, raised rim, the inset center.
  function body(back) {
    const k = back ? ' back' : '';
    return `
      <circle cx="${CX}" cy="${CY}" r="159" class="coin-edge${k}"/>
      <circle cx="${CX}" cy="${CY}" r="155" class="coin-reed${k}"/>
      <circle cx="${CX}" cy="${CY}" r="150" class="coin-rim${k}"/>
      <circle cx="${CX}" cy="${CY}" r="${R + 1}" class="coin-field${k}"/>`;
  }
  function center(back) {
    const k = back ? ' back' : '';
    return `<circle cx="${CX}" cy="${CY}" r="${RI}" class="coin-hole${k}"/>
      <circle cx="${CX}" cy="${CY}" r="${RI - 3}" class="coin-hole-inner${k}"/>`;
  }

  // positions: [{ id, symbol, invested, value, swing_pct, busted, quote_error, matured }]
  // cash: number, preview: { amount } | null, grow: { id, t } | null (t in 0..1)
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
      const sw = p.busted ? Math.max(deg(p.v), 3) : deg(p.v);
      if (sw <= 0) continue;
      const cls = ['wedge', p.quote_error ? 'stale' : p.busted ? 'busted' : p.swing_pct > 0 ? 'up' : p.swing_pct < 0 ? 'down' : 'flat', p.matured ? 'matured' : ''].join(' ');
      wedges += `<path class="${cls}" data-id="${p.id}" d="${sector(a, sw)}" style="fill:${wedgeFill(p)}" tabindex="0" role="button" aria-label="${esc(p.symbol)}, ${money(p.invested)} in"></path>`;
      const strong = !p.busted && !p.quote_error && Math.abs(p.swing_pct || 0) >= 0.45;
      labels += label(a, sw, [p.symbol, p.busted ? 'gone' : money(p.invested)], p.busted ? 'busted' : '', p.busted || strong);
      a += sw;
    }
    const cashSweep = deg(cashShown);
    let cashLayer = '';
    if (cashSweep > 0) {
      cashLayer += `<path class="cash-sector" d="${sector(a, cashSweep)}" role="button" tabindex="0" aria-label="${money(cashShown)} free to spend"/>`;
      cashLayer += bills(a, cashSweep, cashShown);
      if (preview && preview.amount > 0) {
        const sw = Math.min(cashSweep, deg(preview.amount));
        cashLayer += `<path class="preview-slice" d="${sector(a, sw, RI - 3, R + 3)}"/>`;
      }
    }
    return `<svg class="coin-svg" viewBox="0 0 320 320" aria-label="Your money as a coin">
      ${body(false)}
      ${wedges}${cashLayer}${labels}
      ${total <= 0 ? `<circle cx="${CX}" cy="${CY}" r="${RM}" class="coin-empty-ring"/>` : ''}
      ${center(false)}
    </svg>`;
  }

  // slices: [{ name, amount }]
  function back({ slices }) {
    const total = slices.reduce((s, c) => s + c.amount, 0);
    let a = 0, wedges = '', labels = '';
    slices.forEach((c, i) => {
      const sw = total > 0 ? (c.amount / total) * 360 : 0;
      if (sw <= 0) return;
      wedges += `<path class="bwedge b${i % 6}" d="${sector(a, sw)}"><title>${esc(c.name)}: ${c.amount} lobbyists</title></path>`;
      const short = c.name.length > 14 ? c.name.split(/[\s:]+/)[0] : c.name;
      labels += label(a, sw, [short, `${c.amount % 1 ? c.amount.toFixed(2).replace(/0$/, '') : c.amount}`], 'back', true);
      a += sw;
    });
    return `<svg class="coin-svg" viewBox="0 0 320 320" aria-label="Your lobbyists by charity">
      ${body(true)}
      ${total > 0 ? wedges + labels : `<circle cx="${CX}" cy="${CY}" r="${RM}" class="coin-empty-ring back"/>`}
      ${center(true)}
      <path class="back-emblem" transform="translate(${CX - 10} ${CY + 22}) scale(1.5)" d="M5 0 C5 4 1 6.5 1 9.5 a4 4 0 0 0 8 0 C9 6.5 5 4 5 0Z"/>
    </svg>`;
  }

  return { front, back };
})();
