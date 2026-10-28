// Tutorials, as two short decks in the voice of a cheerful holding company.
// Every title should work on its own: read just the titles and you know the
// game. The body is flavor and optional detail.
//
//   Explainer.open({ deck, rules, onDone, onClose })
//     deck     'main' (first open) or 'town' (after your first full lobbyist)
//     onDone   called when the last slide's button is pressed
//     onClose  called whenever the deck closes, finished or not
//   Explainer.seen(deck)   true once that deck has been finished or closed
//   Explainer.isOpen()
window.Explainer = (function () {
  const KEYS = { main: 'trickledown.oriented', town: 'trickledown.town-intro' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shared shapes, in the same 20×40 footprint the game uses.
  const bill = (x, y, cls = '', rot = 0) => `<g class="x-bill ${cls}" transform="translate(${x} ${y}) rotate(${rot})"><rect x="-10" y="-20" width="20" height="40" rx="2"/><rect x="-7.5" y="-17.5" width="15" height="35" rx="1" class="in"/><text y="5" text-anchor="middle">$</text></g>`;
  const suit = (x, y, cls = '', s = 1) => `<g class="x-suit ${cls}" transform="translate(${x} ${y}) scale(${s})"><circle cx="9" cy="5.5" r="4.5"/><path d="M3 12 h12 l1.5 14 h-15 z"/><path class="tie" d="M9 12 l1.6 0 l-0.3 9 l-0.5 1.4 l-0.5 -1.4 z"/><rect x="4.5" y="26" width="4" height="13" rx="0.5"/><rect x="9.5" y="26" width="4" height="13" rx="0.5"/><rect class="case" x="15" y="21" width="5" height="7" rx="0.8"/></g>`;
  const coin = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r + 5}" class="x-rim"/><circle cx="${cx}" cy="${cy}" r="${r}" class="x-field"/>`;
  const arrow = (x1, x2, y) => `<path d="M${x1} ${y} L${x2} ${y}" class="x-arrow"/><path d="M${x2 - 6} ${y - 6} L${x2 + 2} ${y} L${x2 - 6} ${y + 6}" class="x-arrow"/>`;
  const svg = (inner) => `<svg viewBox="0 0 280 150" class="x-art">${inner}</svg>`;

  function wedge(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    const L = a1 - a0 > 180 ? 1 : 0;
    return `M${x0} ${y0} A${r1} ${r1} 0 ${L} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${L} 0 ${x3} ${y3} Z`;
  }

  // A little town on a strip of grass, for the town deck.
  const miniTown = (extra = '') => `
    <rect x="0" y="0" width="280" height="104" fill="#CDE4EB"/><circle cx="240" cy="30" r="12" fill="#F2D06B"/>
    <rect x="0" y="104" width="280" height="46" fill="#9BC48F"/>
    <rect x="56" y="40" width="26" height="64" fill="#9FB6C2" stroke="#4F6874"/><path d="M56 40 L69 28 L82 40 Z" fill="#D4A72C"/>
    <rect x="160" y="72" width="44" height="32" fill="#E7C48F" stroke="#8A6A3A"/><path d="M156 72 L182 54 L208 72 Z" fill="#B0412E"/>
    ${extra}`;

  // A portrait with a speech bubble, for meeting the advocates.
  const person = (who, quote) => `<div class="x-art x-person ${who}">
      ${window.Coin ? window.Coin[who](92) : ''}
      <div class="x-bubble">${esc(quote)}</div>
    </div>`;

  function mainDeck(r) {
    const pct = Math.round(r.tax_rate * 100);
    return [
      {
        kicker: 'Welcome to Trickle Down',
        title: 'Fake money. Real charity.',
        art: svg(`
          ${coin(46, 70, 28)}<text x="46" y="82" text-anchor="middle" class="x-big">$</text>
          ${arrow(84, 104, 70)}
          ${suit(112, 52, '', 0.85)}${suit(130, 52, '', 0.85)}${suit(148, 52, '', 0.85)}
          ${arrow(172, 192, 70)}
          <rect x="204" y="52" width="52" height="38" fill="#fff" stroke="#8EA3AC"/><path d="M200 52 L230 34 L260 52 Z" fill="#1879A0"/>
          <text x="230" y="78" text-anchor="middle" fill="#B0412E" font-size="18">♥</text>
          <text x="46" y="122" text-anchor="middle" class="x-small">fake money</text>
          <text x="139" y="122" text-anchor="middle" class="x-small">lobbyists</text>
          <text x="230" y="122" text-anchor="middle" class="x-small">real charity</text>`),
        body: 'A daily stock game. Your wins steer real ad money to charity. Losing costs you nothing.',
        fine: 'Presented by Trickle Down Holdings, which believes wealth trickles down and has built a website to check.',
        next: 'Show me how',
      },
      {
        title: `Get $${r.daily_base} every day`,
        art: svg(`
          ${coin(140, 88, 50)}
          ${bill(104, 20, 'fall f1', -18)}${bill(140, 8, 'fall f2', 4)}${bill(176, 20, 'fall f3', 20)}
          <text x="140" y="96" text-anchor="middle" class="x-big">+$${r.daily_base}</text>
          <g class="x-days">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${12 + i * 13}" y="128" width="10" height="10" rx="2" class="${i < 4 ? 'on' : ''}"/>`).join('')}<text x="12" y="122" class="x-small">streak</text></g>`),
        body: `Fake, obviously. Come back daily and it grows, up to $${r.daily_cap}. Miss a day and it resets.`,
        fine: 'Loyalty is our most valuable product. Yours, specifically.',
      },
      {
        title: 'Bet it on real stocks',
        art: svg(`
          ${coin(140, 78, 58)}<circle cx="140" cy="78" r="26" class="x-hole"/>
          <path d="${wedge(140, 78, 26, 58, 0, 120)}" class="x-wedge up"/>
          <path d="${wedge(140, 78, 26, 58, 120, 190)}" class="x-wedge down"/>
          <path d="${wedge(140, 78, 26, 58, 200, 300)}" class="x-wedge slice"/>
          <text x="176" y="62" class="x-tag">NVDA</text><text x="146" y="128" class="x-tag">DOGE</text>
          <text x="52" y="140" text-anchor="middle" class="x-tag gold">your slice</text>`),
        body: 'Stocks, crypto, funds. Real prices. Carve off as much as you like.',
        fine: 'Congratulations: you are now an investor. Please update your professional networking profile.',
      },
      {
        title: `Hold ${r.hold_hours} hours for ×10`,
        art: svg(`
          <line x1="24" y1="118" x2="256" y2="118" class="x-axis"/>
          <path d="M24 112 L256 26" class="x-ramp"/>
          <circle r="7" class="x-runner"><animateMotion dur="3.2s" repeatCount="indefinite" path="M24 112 L256 26"/></circle>
          <text x="20" y="136" class="x-small">buy: ×1</text><text x="256" y="136" text-anchor="end" class="x-small">${r.hold_hours}h: ×10</text>
          <circle cx="256" cy="26" r="9" class="x-gold"/>
          <line x1="110" y1="80" x2="110" y2="124" class="x-early"/><text x="110" y="136" text-anchor="middle" class="x-small">sell early: ×4</text>`),
        body: 'Your bet starts at the real move and ramps to ten times it (five for crypto). Sell early any time, or let a winner ride: half the tax now, and the multiplier keeps climbing.',
        fine: 'Investments can reach $0. They cannot go below $0. Legal checked.',
      },
      {
        title: 'Profits hire lobbyists',
        art: svg(`
          ${bill(32, 70, 'hop h1')}${bill(56, 70, 'hop h2')}
          ${arrow(78, 102, 70)}
          <rect x="110" y="70" width="82" height="44" rx="3" class="x-desk"/>
          <text x="151" y="98" text-anchor="middle" class="x-desk-text">RECRUITER</text>
          ${suit(141, 34, '', 0.9)}
          ${arrow(196, 216, 70)}
          ${suit(224, 52, 'pop p1')}${suit(246, 52, 'pop p2')}`),
        body: `${pct}% of every win is taxed. Not to the government, silly. To your Local Lobbyist Recruiter. Losses are free.`,
        fine: 'Fractional lobbyists are hired fractionally. Please do not ask which fraction.',
      },
      {
        title: 'Lobbyists win charities real cash',
        art: svg(`
          <g class="x-march">${[0, 1, 2, 3, 4].map((i) => suit(6 + i * 20, 64, '', 0.85)).join('')}</g>
          ${arrow(112, 148, 84)}
          ${[['Ducks', 58], ['Pigeons', 34], ['Socks', 18]].map(([n, h], i) => `
            <rect x="${160 + i * 38}" y="${108 - h}" width="28" height="${h}" class="x-bar b${i}"/>
            <text x="${174 + i * 38}" y="124" text-anchor="middle" class="x-small">${n}</text>`).join('')}
          <text x="268" y="24" text-anchor="end" class="x-tag gold">real money, by headcount</text>`),
        body: "Every quarter, this site's ad revenue is split between charities by how many lobbyists each one has.",
        fine: r.demo
          ? 'The money will be real. The charities in this demo are not. Pigeons With Dignity regrets the inconvenience.'
          : 'This is how democracy works now. Receipts are posted on the Lobby page.',
      },
      {
        title: 'Your first win unlocks more',
        art: svg(`
          ${miniTown()}
          <rect x="0" y="0" width="280" height="150" fill="#EDF1F2" opacity=".82"/>
          <rect x="96" y="40" width="88" height="56" rx="6" fill="#fff" stroke="#0F2430" stroke-width="2"/>
          <path d="M126 60 v-8 a14 14 0 0 1 28 0 v8" fill="none" stroke="#0F2430" stroke-width="4"/>
          <rect x="120" y="60" width="40" height="28" rx="4" fill="#0F2430"/>
          <text x="140" y="80" text-anchor="middle" fill="#F2D06B" font-size="16" font-weight="900">?</text>
          <text x="140" y="122" text-anchor="middle" class="x-tag">something is being built</text>`),
        body: 'Hire your first full lobbyist and they will need somewhere to live. We will show you around then.',
        fine: 'Trickle Down Holdings is building something. It is either a community or a revenue stream.',
        next: 'Start playing',
      },
    ];
  }

  function townDeck() {
    return [
      {
        kicker: 'Your first lobbyist moved in',
        title: 'Welcome to TrickleTown',
        art: svg(miniTown(`${suit(120, 72, '', 0.9)}<text x="140" y="140" text-anchor="middle" class="x-tag">flip the coin: tails is TrickleTown</text>`)),
        body: 'Your lobbyists live here now. You own all of it.',
        fine: 'Congratulations on becoming a landlord. It happens to the best of us.',
      },
      {
        title: 'Buildings pay or cost you',
        art: svg(`
          <rect x="0" y="104" width="280" height="46" fill="#9BC48F"/>
          <rect x="34" y="56" width="80" height="48" fill="#8E2232"/><rect x="34" y="50" width="80" height="8" fill="#D4A72C"/>
          <text x="74" y="86" text-anchor="middle" fill="#F2D06B" font-size="20" font-weight="900">$ $ $</text>
          <text x="74" y="130" text-anchor="middle" class="x-tag up">+ allowance</text>
          <rect x="168" y="58" width="76" height="46" fill="#fff" stroke="#8EA3AC"/>
          <rect x="200" y="62" width="12" height="26" fill="#2E9C72"/><rect x="193" y="69" width="26" height="12" fill="#2E9C72"/>
          <text x="206" y="130" text-anchor="middle" class="x-tag down">− upkeep</text>`),
        body: 'Tap an empty lot and pick from three pitches. Casinos and tenements pay into your daily allowance; co-ops and clinics cost upkeep. Later, each building gets proposals for upgrades.',
        fine: 'Every lot offers an extractive option, a compromise, and a decent one. We put them in that order for a reason.',
      },
      {
        title: 'Happy town, cheaper lobbyists',
        art: svg(`
          <text x="70" y="40" text-anchor="middle" class="x-tag">happy</text>
          <rect x="20" y="50" width="100" height="12" rx="6" fill="#DDE6E9"/><rect x="20" y="50" width="88" height="12" rx="6" fill="#2E9C72"/>
          <text x="70" y="100" text-anchor="middle" class="x-big">$0.65</text><text x="70" y="120" text-anchor="middle" class="x-small">per lobbyist</text>
          <text x="210" y="40" text-anchor="middle" class="x-tag">miserable</text>
          <rect x="160" y="50" width="100" height="12" rx="6" fill="#DDE6E9"/><rect x="160" y="50" width="18" height="12" rx="6" fill="#C04A35"/>
          <text x="210" y="100" text-anchor="middle" class="x-big" fill="#B0412E">$1.35</text><text x="210" y="120" text-anchor="middle" class="x-small">and they quit</text>`),
        body: 'Happy residents make the recruiter cheaper. Sick ones quit before Lobbyfest, and quitters don\'t count.',
        fine: 'Morale is a mindset. Health is a line on a chart.',
      },
      {
        title: 'Meet Preston: more money',
        art: person('preston', 'Have you considered a casino? Have you considered two casinos?'),
        body: 'Preston Yield, your Value Extraction Partner. Every idea he brings makes your number go up.',
        fine: 'He has a deck. He always has a deck.',
      },
      {
        title: 'Meet Dolores: happier lobbyists',
        art: person('dolores', 'They would like a park. A park-shaped park.'),
        body: "Dolores Pike, Lobbyist for Lobbyists. Her ideas usually cost you, and usually keep your town alive.",
        fine: 'She once asked for a ball pit. She will ask again.',
      },
      {
        title: "It's all optional",
        art: svg(`
          ${coin(80, 70, 40)}<text x="80" y="82" text-anchor="middle" class="x-big">$</text>
          <text x="80" y="134" text-anchor="middle" class="x-tag">heads: the game</text>
          <circle cx="200" cy="70" r="45" class="x-rim"/><circle cx="200" cy="70" r="40" fill="#CDE4EB"/>
          <path d="M160 82 L240 82 A40 40 0 0 1 160 82 Z" fill="#9BC48F"/>
          <rect x="186" y="54" width="12" height="28" fill="#9FB6C2"/><rect x="204" y="66" width="18" height="16" fill="#E7C48F"/>
          <text x="200" y="134" text-anchor="middle" class="x-tag gold">tails: bonus</text>`),
        body: 'Ignore TrickleTown and the stock game works exactly the same. Once you\'ve built something, though, the residents expect you to show up: unplayed cards cost a little happiness. Drop by when you want a bigger allowance or cheaper lobbyists: tap Speak with your advisors, play the day\'s cards, buy a building or an upgrade. The ▲▼ hints show which way each choice pushes.',
        fine: 'Unanswered issues expire at midnight. Dolores will mention it. Preston will invoice for it.',
        next: 'Visit TrickleTown',
      },
    ];
  }

  let dlg, i = 0, list = [], current = null;

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'sheet explainer';
    dlg.setAttribute('aria-label', 'How Trickle Down works');
    dlg.innerHTML = `
      <div class="sheet-body">
        <div class="x-head">
          <span class="x-brand">Trickle Down Holdings<br><span class="x-sub"></span></span>
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
    dlg.querySelector('.close').onclick = () => close(false);
    dlg.querySelector('[data-x="back"]').onclick = () => go(i - 1);
    dlg.querySelector('[data-x="next"]').onclick = () => (i === list.length - 1 ? close(true) : go(i + 1));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(false); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
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
        ${s.kicker ? `<div class="x-step">${esc(s.kicker)}</div>` : ''}
        <h2>${esc(s.title)}</h2>
        <p class="x-body">${esc(s.body)}</p>
        <p class="x-fine">${esc(s.fine)}</p>
      </div>`;
    dlg.querySelector('.x-dots').innerHTML = list.map((_, k) => `<button type="button" role="tab" aria-selected="${k === i}" aria-label="Slide ${k + 1}" data-k="${k}"></button>`).join('');
    dlg.querySelectorAll('.x-dots button').forEach((b) => { b.onclick = () => go(Number(b.dataset.k)); });
    dlg.querySelector('[data-x="back"]').disabled = i === 0;
    dlg.querySelector('[data-x="next"]').textContent = s.next || 'Next';
  }

  function markSeen(deck) { try { localStorage.setItem(KEYS[deck], '1'); } catch (e) { /* private mode */ } }

  function close(done) {
    if (!current) return;
    const c = current;
    current = null;
    markSeen(c.deck);
    if (dlg && dlg.open) dlg.close();
    if (done && c.onDone) c.onDone();
    if (c.onClose) c.onClose();
  }

  function open({ deck = 'main', rules, onDone, onClose } = {}) {
    const r = Object.assign({ daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, demo: true }, rules || {});
    if (!dlg) build();
    if (current) close(false);
    current = { deck, onDone, onClose };
    list = deck === 'town' ? townDeck() : mainDeck(r);
    dlg.querySelector('.x-sub').textContent = deck === 'town' ? 'TrickleTown Resident Services' : 'New Associate Orientation';
    go(0);
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('[data-x="next"]').focus();
  }

  function seen(deck = 'main') { try { return localStorage.getItem(KEYS[deck]) === '1'; } catch (e) { return false; } }
  function isOpen() { return !!current; }

  return { open, seen, isOpen };
})();
