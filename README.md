# Trickle Down — front end

The daily game. Fake money, real market, real charity. This is the static site
that runs on GitHub Pages; the API it talks to lives in `heroku-trickledown`.

No build step. Plain HTML, CSS, and JS.

```
index.html        the shell: masthead, tabs, screens, bottom sheets
config.js         API_BASE and SITE_URL — the only thing you must edit
css/style.css     the whole look; design tokens at the top
js/coin.js        draws the coin (SVG): wedges, bills, the village, the advocates
js/town.js        TrickleTown rules + the card deck (byte-identical to the backend's src/town.js)
js/explainer.js   the two tutorials
js/app.js         screens, carving, collect/sell/ride, the flip, TrickleTown Hall, the Site Office, boards, friends, player sheets
js/api.js         fetch wrapper with the auth token
js/demo-api.js    in-memory fake API for demo mode (see below)
favicon.svg       the droplet
```

## Run it locally

1. Start the backend (`heroku-trickledown`) on port 3000.
2. Serve this folder with anything: `python3 -m http.server 8080` or `npx serve`.
3. Open `http://localhost:8080`. `config.js` points at `localhost:3000` when the
   page itself is on localhost.

## Demo mode

Open `index.html?demo` and the game runs entirely in the browser against
invented prices that move fast, with a seeded portfolio. Nothing is saved.
Good for showing someone the loop in thirty seconds, and for working on the
design without a server. It is opt-in only: a build whose `config.js` still
has the placeholder backend URL shows a "not connected yet" notice (with a
link to the demo) rather than quietly running the fake game.

## The landing page

Hero, three one-line pitches, then "Take the employee training" (the
orientation deck; when taken before signing up its last slide ends in the
three ways in), then Create an account / Play as a guest, with Sign in as a
smaller line under them. Nobody sees a tutorial until they've chosen a way
in, and nobody sees it twice. Anyone setting a password gets a plain note
that this is a beta: hashed, rate-limited, HTTPS, but no reset, no 2FA, one
person's project, so don't reuse a password from elsewhere.

## Accounts

Three ways an account follows you: username + password ("Keep this
account"), Google, or a device code (Account → "Use on another device", then
Sign in → "Use a code" on the other device; 15 minutes, works once, guests
included). If the backend lists your username in `ADMIN_USERNAMES`, Account
also shows an Admin section, aimed at you or at a player you name: grant cash
and lobbyists; deal any card onto today's agenda or unlock cards (one, or the
whole deck); or reset to a brand-new account, which on your own account also
replays the training, the gift, the first hire and the TrickleTown tour.

Everyone starts as a guest (lives in that browser). "Keep this account" turns
it into a username + password account, or links a Google account, keeping
everything. Account (in the footer) changes the username, sets or changes the
password (which signs out every other device), links Google, and signs out
everywhere. Google sign-in appears only when the backend reports a client id
(`/auth/options`); `config.js` can also carry it as a head start. The token
lives in `localStorage` and goes out as a Bearer header; see the backend
README's Security section for the rest.

## Friends

Leaders → Friends: add anyone by username. It's one-way and silent; they see
you only if they add you back. You get a friends-only toggle on both boards,
a "erin bought NVDA" line under the crowd strip on Today, and a sheet for any
player (tap a name anywhere): their coin with live wedges, standing, rank,
cash in play, favourite charity, and a summary of their village. Guests can
add friends but can't be added, since a guest's name isn't shareable; the
account sheet and the share card both carry your username once you've
claimed one. In demo mode, `ravi_k` and `bagholder_ben` are addable.

## Deploy to GitHub Pages

1. Edit `config.js`: set `API_BASE` to your Heroku app URL (no trailing slash)
   and `SITE_URL` to where the site will live.
2. Push to GitHub. Settings → Pages → deploy from the `main` branch, root.
3. If you use a custom domain, add a `CNAME` file containing it, the same way as
   your other GitHub Pages sites.
4. Make sure the backend's `CORS_ORIGIN` includes this site's origin
   (`https://stevenbhester.github.io` and/or your custom domain).

## The picker and the ticker

`GET /assets` returns the featured list; typing searches the server
(`/assets/search?q=`), debounced, because the universe is thousands of
names. After a buy, the live ticker polls `/quotes?fresh=1` every 3 seconds
and backs off to a minute while the page is open; values are recomputed in
`valueLive()` (the server's formula) and the coin and rows repaint in place.
The demo keeps its small local list and no ticker.

## Money

Play money is shown in thousands: a unit from the API is $1K, a thousand
units is $1M, one decimal at most (`money()` in `js/app.js`, mirrored in
`js/coin.js` for wedge labels). Under $0.1K it falls back to plain dollars
so a $40 tax doesn't round to nothing. Real stock prices use `price()` and
stay in real dollars. The amount input takes thousands too (its suffix
says K).

## Design notes

- One accent colour (water blue), one display face (Big Shoulders Display) for
  the wordmark and money, one text face (Public Sans, the US government's
  typeface, which is the joke).
- The Today screen is a coin with a milled edge. The front is a ring: open
  positions as wedges labelled with the dollars in them and coloured by how
  they're doing (pale to strong green or rust, dark when busted, a gold edge
  once matured); uninvested cash as a fan of $10 bills; cash free to spend in
  the centre. Hover a wedge for the return, the multiplier now, and the time
  to maturity. Pick a stock, then an amount (dollars or a chip), and a dashed
  slice shows where the wedge will land. Tap a wedge to collect it (matured)
  or sell early (selling a ride early also pays the half of the tax it
  deferred). The back is
  TrickleTown: the village on the coin, with the payroll (lobbyists by
  charity), your rank, and the records under it. A taxed cash-out flips the
  coin; the day's first load tosses it in.
- TrickleTown (tails) has a construction zone with one lot per plot. Tapping
  a lot, on the coin or in the list, opens the Site Office: three pitches to
  build from, then upgrade proposals as cards (pitch vs. objection) that
  unlock over time or on conditions. The advisors' daily cards live in
  TrickleTown Hall, the same card modal.
- Play-money tax hires lobbyists at a dollar a head; they are never shown as
  dollars. Fractional lobbyists are drawn clipped to the fraction, head first.
- Outcomes get a deadpan tier name (Pocket change, Nice, Heater, Legend, Paper
  cut, Rest in peace). Tiers show on the receipt, in the records, on the
  24-hour board, and in the share text.
- Ranks: Intern, Staffer, Consultant, Lobbyist, Fixer, Kingmaker, Shadow Cabinet.
- The ad slot in the footer is a labelled placeholder until there's an ad network.
