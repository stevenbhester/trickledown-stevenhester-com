// The orientation pamphlet. A modal of six slides, each with a small animated
// SVG, in the voice of a cheerful holding company that loves you as an asset.
//
//   Explainer.open({ rules })   rules: { daily_base, streak_bonus, daily_cap, tax_rate, hold_hours, demo } (optional)
//   Explainer.seen()            true once someone has finished or closed it
window.Explainer = (function () {
  const KEY = 'trickledown.oriented';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shared shapes, in the same 20×40 footprint the game uses.
  const bill = (x, y, cls = '', rot = 0) => `<g class="x-bill ${cls}" transform="translate(${x} ${y}) rotate(${rot})"><rect x="-10" y="-20" width="20" height="40" rx="2"/><rect x="-7.5" y="-17.5" width="15" height="35" rx="1" class="in"/><text y="5" text-anchor="middle">$</text></g>`;
  const suit = (x, y, cls = '', s = 1) => `<g class="x-suit ${cls}" transform="translate(${x} ${y}) scale(${s})"><circle cx="9" cy="5.5" r="4.5"/><path d="M3 12 h12 l1.5 14 h-15 z"/><path class="tie" d="M9 12 l1.6 0 l-0.3 9 l-0.5 1.4 l-0.5 -1.4 z"/><rect x="4.5" y="26" width="4" height="13" rx="0.5"/><rect x="9.5" y="26" width="4" height="13" rx="0.5"/><rect class="case" x="15" y="21" width="5" height="7" rx="0.8"/></g>`;
  const coin = (cx, cy, r, hole = true) => `<circle cx="${cx}" cy="${cy}" r="${r + 5}" class="x-rim"/><circle cx="${cx}" cy="${cy}" r="${r}" class="x-field"/>${hole ? `<circle cx="${cx}" cy="${cy}" r="${r * 0.45}" class="x-hole"/>` : ''}`;

  function wedge(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    const L = a1 - a0 > 180 ? 1 : 0;
    return `M${x0} ${y0} A${r1} ${r1} 0 ${L} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${L} 0 ${x3} ${y3} Z`;
  }

  function slides(r) {
    const pct = Math.round(r.tax_rate * 100);
    return [
      {
        title: 'Receive your stipend',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          ${coin(140, 88, 50, false)}
          ${bill(104, 20, 'fall f1', -18)}${bill(140, 8, 'fall f2', 4)}${bill(176, 20, 'fall f3', 20)}
          <text x="140" y="96" text-anchor="middle" class="x-big">+$${r.daily_base}</text>
          <g class="x-days">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${12 + i * 13}" y="128" width="10" height="10" rx="2" class="${i < 4 ? 'on' : ''}"/>`).join('')}<text x="12" y="122" class="x-small">streak</text></g>
        </svg>`,
        body: `Every day you check in, Trickle Down Holdings deposits <b>$${r.daily_base}</b> of entirely fictional money onto your coin. Come back tomorrow and we'll add $${r.streak_bonus} more. Keep coming back and we keep adding, up to $${r.daily_cap} a day, because loyalty is our most valuable product. Yours, specifically.`,
        fine: 'Missing a day resets your stipend. Absence is a form of theft.',
      },
      {
        title: 'Put your money to work',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          ${coin(140, 78, 58)}
          <path d="${wedge(140, 78, 26, 58, 0, 120)}" class="x-wedge up"/>
          <path d="${wedge(140, 78, 26, 58, 120, 190)}" class="x-wedge down"/>
          <path d="${wedge(140, 78, 26, 58, 200, 300)}" class="x-wedge slice"/>
          <text x="176" y="62" class="x-tag">NVDA</text><text x="146" y="128" class="x-tag">DOGE</text>
          <text x="52" y="140" text-anchor="middle" class="x-tag gold">your slice</text>
        </svg>`,
        body: 'Pick any stock, coin, or fund on our list of Approved Opportunities. Carve off a slice of your stipend. Congratulations: you are now an investor. Please update your professional networking profile accordingly.',
        fine: 'Past performance is not indicative of anything. Neither is current performance.',
      },
      {
        title: 'Patience is profitable',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          <line x1="24" y1="118" x2="256" y2="118" class="x-axis"/>
          <path d="M24 112 L256 26" class="x-ramp"/>
          <circle r="7" class="x-runner"><animateMotion dur="3.2s" repeatCount="indefinite" path="M24 112 L256 26"/></circle>
          <text x="20" y="136" class="x-small">0h ×1</text><text x="256" y="136" text-anchor="end" class="x-small">${r.hold_hours}h ×10</text>
          <circle cx="256" cy="26" r="9" class="x-gold"/>
          <line x1="110" y1="80" x2="110" y2="124" class="x-early"/><text x="110" y="136" text-anchor="middle" class="x-small">sell early: ×4</text>
          <text x="244" y="18" text-anchor="end" class="x-tag gold">mature</text>
        </svg>`,
        body: `Every investment ripens for <b>${r.hold_hours} hours</b>. At purchase it tracks the real market at ×1. By the end it's ×10 for stocks and ×5 for crypto, so Nvidia up 1.5% means your money up 15%. Get nervous and sell early at whatever multiplier you've accrued. We won't judge. We'll log it.`,
        fine: 'Investments can reach $0. They cannot go below $0. Legal checked.',
      },
      {
        title: 'Pay your taxes',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          ${bill(32, 70, 'hop h1')}${bill(56, 70, 'hop h2')}
          <path d="M78 70 L102 70" class="x-arrow"/><path d="M96 64 L104 70 L96 76" class="x-arrow"/>
          <rect x="110" y="70" width="82" height="44" rx="3" class="x-desk"/>
          <text x="151" y="98" text-anchor="middle" class="x-desk-text">RECRUITER</text>
          ${suit(141, 34, '', 0.9)}
          <path d="M196 70 L216 70" class="x-arrow"/><path d="M210 64 L218 70 L210 76" class="x-arrow"/>
          ${suit(224, 52, 'pop p1')}${suit(246, 52, 'pop p2')}
          <text x="140" y="140" text-anchor="middle" class="x-small">~$1 of tax = 1 lobbyist</text>
        </svg>`,
        body: `Cash out a profit and ${pct}% of it is taxed. Not to the government, silly. To your <b>Local Lobbyist Recruiter</b>, who converts it into lobbyists for the charity of your choice, at about a dollar a head. Happy lobbyists refer their friends, so the rate improves. Losses are untaxed. We're not monsters. We're a holding company.`,
        fine: 'Fractional lobbyists are hired fractionally. Please do not ask which fraction.',
      },
      {
        title: 'House your lobbyists',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          <rect x="0" y="104" width="280" height="46" fill="#9BC48F"/>
          <rect x="40" y="44" width="26" height="60" fill="#9FB6C2" stroke="#4F6874"/><path d="M40 44 L53 34 L66 44 Z" fill="#D4A72C"/>
          <text x="53" y="122" text-anchor="middle" class="x-small">extract</text>
          <rect x="118" y="70" width="44" height="34" fill="#E7C48F" stroke="#8A6A3A"/><path d="M114 70 L140 52 L166 70 Z" fill="#B0412E"/>
          <text x="140" y="122" text-anchor="middle" class="x-small">compromise</text>
          <rect x="206" y="66" width="44" height="38" fill="#fff" stroke="#8EA3AC"/><rect x="224" y="72" width="8" height="22" fill="#2E9C72"/><rect x="217" y="79" width="22" height="8" fill="#2E9C72"/>
          <text x="228" y="122" text-anchor="middle" class="x-small">care</text>
          ${suit(92, 64, 'pop p1', 0.8)}${suit(176, 64, 'pop p2', 0.8)}
          <text x="140" y="144" text-anchor="middle" class="x-small">flip the coin: tails is Lobbyton</text>
        </svg>`,
        body: 'Your lobbyists need somewhere to live, and you own all of it. Flip the coin to visit <b>Lobbyton</b>. Build tenements and casinos and they pay into your allowance. Build co-ops and clinics and they cost you, but happy lobbyists are cheaper to hire and healthy ones don\'t quit. Every day your advisor <b>Preston</b> and their advocate <b>Dolores</b> each make you an offer. You choose.',
        fine: 'Lobbyton is a company town. Company towns are historically very fun for the company.',
      },
      {
        title: 'Reinvest, or let it ride',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          ${coin(140, 76, 42, false)}
          <g class="x-spin"><path d="M140 18 A58 58 0 1 1 82 76" class="x-loop"/><path d="M76 66 L82 78 L90 68" class="x-loop"/></g>
          <text x="140" y="82" text-anchor="middle" class="x-big sm">+24h</text>
          <text x="140" y="146" text-anchor="middle" class="x-small">no tax, no recruiter, multiplier resets</text>
        </svg>`,
        body: "The rest of your profit goes back on your coin. Spend it on something new, or let a matured investment ride: the whole thing goes straight back in for another 24 hours, untaxed. Compound interest is just patience with ambition.",
        fine: 'Riding hires nobody. The Recruiter has noted your choice.',
      },
      {
        title: 'Lobbyfest',
        art: `<svg viewBox="0 0 280 150" class="x-art">
          <g class="x-march">${[0, 1, 2, 3, 4].map((i) => suit(6 + i * 20, 64, '', 0.85)).join('')}</g>
          ${[['Ducks', 58], ['Pigeons', 34], ['Socks', 18]].map(([n, h], i) => `
            <rect x="${160 + i * 38}" y="${108 - h}" width="28" height="${h}" class="x-bar b${i}"/>
            <text x="${174 + i * 38}" y="124" text-anchor="middle" class="x-small">${n}</text>`).join('')}
          <path d="M112 84 L148 84" class="x-arrow"/><path d="M142 78 L150 84 L142 90" class="x-arrow"/><text x="268" y="24" text-anchor="end" class="x-tag gold">real money, by headcount</text><text x="62" y="124" text-anchor="middle" class="x-small">to Lobbyfest</text>
        </svg>`,
        body: 'At the end of every quarter, every lobbyist in the game marches to <b>Lobbyfest</b>. The ads on this site earn real money, and it is divided between the charities by headcount: more lobbyists, bigger slice. Then everyone\'s payroll resets to zero. This is how democracy works now.',
        fine: r.demo
          ? 'The money will be real. The charities in this demo are not. Pigeons With Dignity regrets the inconvenience.'
          : 'Receipts are posted on the Lobby page after every Lobbyfest.',
      },
    ];
  }

  let dlg, i = 0, list = [];

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'sheet explainer';
    dlg.setAttribute('aria-label', 'How Trickle Down works');
    dlg.innerHTML = `
      <div class="sheet-body">
        <div class="x-head">
          <span class="x-brand">Trickle Down Holdings<br><span>New Associate Orientation</span></span>
          <button type="button" class="close" aria-label="Close">×</button>
        </div>
        <div class="x-stage" aria-live="polite"></div>
        <div class="x-dots" role="tablist"></div>
        <div class="x-nav">
          <button type="button" class="btn quiet" data-x="back">Back</button>
          <button type="button" class="btn primary" data-x="next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('.close').onclick = close;
    dlg.querySelector('[data-x="back"]').onclick = () => go(i - 1);
    dlg.querySelector('[data-x="next"]').onclick = () => (i === list.length - 1 ? close() : go(i + 1));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('cancel', () => markSeen());
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') go(i + 1);
      if (e.key === 'ArrowLeft') go(i - 1);
    });
  }

  function go(n) {
    i = Math.max(0, Math.min(list.length - 1, n));
    const s = list[i];
    dlg.querySelector('.x-stage').innerHTML = `
      <div class="x-slide">
        ${s.art}
        <div class="x-step">Step ${i + 1} of ${list.length}</div>
        <h2>${esc(s.title)}</h2>
        <p>${s.body}</p>
        <p class="x-fine">${esc(s.fine)}</p>
      </div>`;
    dlg.querySelector('.x-dots').innerHTML = list.map((_, k) => `<button type="button" role="tab" aria-selected="${k === i}" aria-label="Step ${k + 1}" data-k="${k}"></button>`).join('');
    dlg.querySelectorAll('.x-dots button').forEach((b) => { b.onclick = () => go(Number(b.dataset.k)); });
    dlg.querySelector('[data-x="back"]').disabled = i === 0;
    dlg.querySelector('[data-x="next"]').textContent = i === list.length - 1 ? 'I consent to prosperity' : 'Next';
  }

  function markSeen() { try { localStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ } }
  function close() { markSeen(); if (dlg && dlg.open) dlg.close(); }

  function open({ rules } = {}) {
    const r = Object.assign({ daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, demo: true }, rules || {});
    if (!dlg) build();
    list = slides(r);
    go(0);
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('[data-x="next"]').focus();
  }

  function seen() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }

  return { open, seen };
})();
