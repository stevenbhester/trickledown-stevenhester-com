// The welcome-back performance review chart. Pure drawing plus its own
// animation loop: takes series of [time, dollars] points, draws one line per
// position on a shared clock, and sweeps that clock from the first buy to the
// last maturity, each line's ticker riding at its head. No app state here.
//
//   const c = Review.chart(el, { start, end, series }, { money, reduced, onTick, onDone })
//   c.play()      sweep from start to end (or jump to the end with reduced motion)
//   c.finish()    jump to the end
//   c.destroy()   stop the loop
//
// series: [{ label, color, points: [[ms, dollars], ...], ended, quiet }]
//   color is a CSS colour (the app passes var(--s1) ... so the theme repaints).
//   ended: the line stops at its last point (it matured); otherwise it runs to
//   `end` (still live). quiet: a thin unlabeled line (past the eight colours).
// onTick(t, values): every frame, with each series' value at t (null before it
// starts). onDone(): once, when the sweep lands.
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const H1 = 3600e3;
  let uid = 0;

  function el(name, attrs, parent) {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  // The value of a series at time t: linear between points, null before the
  // first, held at the last after it.
  function valueAt(pts, t) {
    if (!pts.length || t < pts[0][0]) return null;
    if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
    const [t0, v0] = pts[lo], [t1, v1] = pts[hi];
    return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }

  // Hour ticks on local time: 3 AM, 6 AM ... and the weekday at midnight.
  function timeTicks(start, end, maxTicks) {
    const steps = [1, 2, 3, 4, 6, 8, 12, 24, 48];
    const hours = (end - start) / H1;
    const step = steps.find((s) => hours / s <= maxTicks) || 48;
    const d = new Date(start);
    d.setMinutes(0, 0, 0);
    if (step <= 24) d.setHours(Math.ceil(d.getHours() / step) * step);
    const out = [];
    for (let t = d.getTime(); t <= end; t += step * H1) {
      if (t < start) continue;
      const x = new Date(t);
      const midnight = x.getHours() === 0;
      out.push({ t, label: midnight ? x.toLocaleDateString([], { weekday: 'short' }) : x.toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, ' ') });
    }
    return out;
  }

  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  // Rough label widths at 11px, so labels can dodge each other without a
  // layout pass every frame.
  const textW = (bold, plain) => bold.length * 7.2 + plain.length * 6.3 + 4;

  function chart(host, data, opts = {}) {
    const id = ++uid;
    const money = opts.money || ((v) => `$${Math.round(v)}`);
    const { start, end } = data;
    const span = Math.max(1, end - start);
    const series = data.series.map((s, i) => ({ ...s, i, pts: s.points.filter((p) => p[0] <= end) }));

    const W = Math.max(280, Math.round(host.clientWidth || 340));
    const H = Math.round(Math.max(210, Math.min(280, W * 0.62)));

    // Y: every value any line touches, on round ticks.
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const [, v] of s.pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < Math.max(0.05, hi * 0.04)) { const pad = Math.max(0.05, hi * 0.04); lo -= pad; hi += pad; }
    const step = niceStep((hi - lo) / 4);
    lo = Math.max(0, Math.floor(lo / step) * step);
    hi = Math.ceil(hi / step) * step;
    const yTicks = [];
    for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(Math.round(v * 1000) / 1000);

    host.innerHTML = '';
    const svg = el('svg', { class: 'rv-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, host);
    svg.setAttribute('aria-label', opts.label || 'Each position’s value over the stretch');

    // Measure the real label widths once (the widest value each line reaches),
    // so the right gutter always fits them and they never fold back over the lines.
    const probe = el('text', { class: 'rv-lab', x: -999, y: -999 }, svg);
    const pt = el('tspan', { class: 'rv-lab-t' }, probe), pv = el('tspan', { class: 'rv-lab-v', dx: 4 }, probe);
    const measure = (a, b, fallback) => {
      pt.textContent = a; pv.textContent = b;
      let w = 0;
      try { w = probe.getComputedTextLength(); } catch (e) { /* not rendered */ }
      return w > 0 ? w : fallback;
    };
    for (const s of series) {
      const widest = s.pts.reduce((m, [, v]) => (money(v).length > m.length ? money(v) : m), '');
      s.w = s.quiet ? 0 : measure(s.label, widest, textW(s.label, widest)) + 4;
    }
    const tickW = Math.max(...yTicks.map((v) => measure('', money(v), money(v).length * 6.4)));
    probe.remove();
    const M = { l: Math.round(tickW + 10), r: Math.round(Math.max(40, ...series.map((s) => s.w)) + 10), t: 12, b: 24 };
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    const X = (t) => M.l + (t - start) / span * pw;
    const Y = (v) => M.t + ph - (v - lo) / (hi - lo) * ph;

    // Recessive grid and axes: hairlines and muted labels.
    const grid = el('g', { class: 'rv-grid' }, svg);
    for (const v of yTicks) {
      el('line', { x1: M.l, x2: M.l + pw, y1: Y(v), y2: Y(v) }, grid);
      el('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'rv-axis' }, grid).textContent = money(v);
    }
    for (const tk of timeTicks(start, end, Math.max(2, Math.floor(pw / 58)))) {
      const x = X(tk.t);
      el('line', { x1: x, x2: x, y1: M.t + ph, y2: M.t + ph + 4, class: 'rv-tick' }, grid);
      el('text', { x, y: H - 6, 'text-anchor': 'middle', class: 'rv-axis' }, grid).textContent = tk.label;
    }

    // The lines, revealed left to right by one clip as the clock sweeps.
    const defs = el('defs', {}, svg);
    const clip = el('clipPath', { id: `rv-clip-${id}` }, defs);
    const clipRect = el('rect', { x: 0, y: 0, width: 0, height: H }, clip);
    const lines = el('g', { 'clip-path': `url(#rv-clip-${id})` }, svg);
    // Quiet lines (past the eight colours) underneath, the coloured ones on top.
    for (const s of [...series.filter((x) => x.quiet), ...series.filter((x) => !x.quiet)]) {
      if (!s.pts.length) continue;
      const d = s.pts.map(([t, v], k) => `${k ? 'L' : 'M'}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      el('path', { d, class: s.quiet ? 'rv-line quiet' : 'rv-line', style: `stroke:${s.color}` }, lines);
      // Where it was bought: a small open ring.
      if (!s.quiet) el('circle', { cx: X(s.pts[0][0]), cy: Y(s.pts[0][1]), r: 3, class: 'rv-buy', style: `stroke:${s.color}` }, lines);
    }

    const cursor = el('line', { x1: 0, x2: 0, y1: M.t, y2: M.t + ph, class: 'rv-cursor' }, svg);
    const heads = el('g', {}, svg);
    for (const s of [...series.filter((x) => x.quiet), ...series.filter((x) => !x.quiet)]) {
      s.g = el('g', { class: s.quiet ? 'rv-head quiet' : 'rv-head' }, heads);
      s.leader = el('line', { class: 'rv-leader' }, s.g);
      s.dot = el('circle', { r: s.quiet ? 2.5 : 4.5, class: 'rv-dot', style: `fill:${s.color}` }, s.g);
      s.bg = el('rect', { class: 'rv-lab-bg', rx: 3, height: 15, width: s.w + 4 }, s.g);
      s.text = el('text', { class: 'rv-lab' }, s.g);
      s.tk = el('tspan', { class: 'rv-lab-t' }, s.text); s.tk.textContent = s.label;
      s.tv = el('tspan', { class: 'rv-lab-v', dx: 4 }, s.text);
    }

    // Draw the clock at time t. `reveal` is how far the lines are drawn (the
    // sweep reveals as it goes; scrubbing afterwards keeps them all).
    function paint(t, reveal = t, showCursor = true) {
      clipRect.setAttribute('width', Math.max(0, X(reveal) + 1));
      cursor.setAttribute('x1', X(t)); cursor.setAttribute('x2', X(t));
      cursor.style.opacity = showCursor ? 1 : 0;
      const values = [];
      const labels = [];
      for (const s of series) {
        const first = s.pts.length ? s.pts[0][0] : Infinity;
        const last = s.pts.length ? s.pts[s.pts.length - 1][0] : -Infinity;
        if (t < first) { s.g.style.display = 'none'; values.push(null); continue; }
        const at = Math.min(t, last);
        const v = valueAt(s.pts, at);
        values.push(v);
        s.g.style.display = '';
        s.g.classList.toggle('done', t >= last && s.ended);
        const hx = X(at), hy = Y(v);
        s.dot.setAttribute('cx', hx); s.dot.setAttribute('cy', hy);
        if (s.quiet) continue;
        const txt = money(v);
        if (s.tv.textContent !== txt) s.tv.textContent = txt;
        labels.push({ s, hx, hy, x: hx + 8, y: hy, w: s.w });
      }
      // Labels dodge each other where their boxes overlap, nearest first.
      labels.sort((a, b) => a.hy - b.hy);
      const placed = [];
      const LH = 15;
      const clash = (L, y) => placed.find((p) => L.x < p.x + p.w && p.x < L.x + L.w && Math.abs(y - p.y) < LH);
      for (const L of labels) {
        // The nearest free spot, below or above.
        let down = L.hy, up = L.hy, hit;
        for (let n = 0; n < 24 && (hit = clash(L, down)); n++) down = hit.y + LH;
        for (let n = 0; n < 24 && (hit = clash(L, up)); n++) up = hit.y - LH;
        L.y = (up >= M.t && L.hy - up < down - L.hy) || down > M.t + ph + 6 ? up : down;
        placed.push(L);
      }
      for (const L of placed) {
        L.s.text.setAttribute('x', L.x); L.s.text.setAttribute('y', L.y + 4);
        L.s.bg.setAttribute('x', L.x - 2); L.s.bg.setAttribute('y', L.y - 7.5);
        const off = Math.abs(L.y - L.hy) > 3;
        L.s.leader.style.display = off ? '' : 'none';
        if (off) {
          const ax = L.x > L.hx ? L.x - 2 : L.x + L.w + 2;
          L.s.leader.setAttribute('x1', L.hx); L.s.leader.setAttribute('y1', L.hy);
          L.s.leader.setAttribute('x2', ax); L.s.leader.setAttribute('y2', L.y);
        }
      }
      if (opts.onTick) opts.onTick(t, values);
    }

    let raf = 0, done = false, scrubbing = false;
    function land() {
      cancelAnimationFrame(raf); raf = 0;
      paint(end, end, false);
      if (!done) { done = true; if (opts.onDone) opts.onDone(); }
    }
    function play() {
      cancelAnimationFrame(raf);
      done = false;
      if (opts.reduced) { land(); return; }
      const ms = opts.duration || 5200;
      const t0 = performance.now();
      const frame = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        if (k >= 1) { land(); return; }
        const t = start + span * ease(k);
        paint(t);
        raf = requestAnimationFrame(frame);
      };
      paint(start);
      raf = requestAnimationFrame(frame);
    }

    // After the sweep: drag or hover across the chart to read any moment.
    const tAt = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = (ev.clientX - r.left) * (W / r.width);
      return start + Math.max(0, Math.min(1, (x - M.l) / pw)) * span;
    };
    svg.addEventListener('pointermove', (ev) => { if (!done) return; scrubbing = true; paint(tAt(ev), end, true); });
    svg.addEventListener('pointerdown', (ev) => { if (!done) return; scrubbing = true; paint(tAt(ev), end, true); });
    const rest = () => { if (done && scrubbing) { scrubbing = false; paint(end, end, false); } };
    svg.addEventListener('pointerleave', rest);
    svg.addEventListener('pointercancel', rest);
    svg.addEventListener('pointerup', (ev) => { if (ev.pointerType !== 'mouse') rest(); });

    paint(start, start, false);
    return {
      play,
      finish: land,
      get done() { return done; },
      destroy() { cancelAnimationFrame(raf); raf = 0; },
    };
  }

  window.Review = { chart, valueAt };
})();
