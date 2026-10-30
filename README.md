# Trickle Down — front end

The daily game. Fake money, real market, real charity. This is the static site
that runs on GitHub Pages; the API it talks to lives in `heroku-trickledown`.

No build step. Plain HTML, CSS, and JS.

```
index.html        the shell: masthead (with the ☰ menu), screens, bottom sheets
config.js         API_BASE and SITE_URL — the only thing you must edit
css/style.css     the whole look; design tokens at the top
js/theme.js       light / dark / auto, decided in <head> before anything paints
js/coin.js        draws the coin (SVG): wedges, bills, the village, the advocates
js/town.js        TrickleTown rules + the card deck (byte-identical to the backend's src/town.js)
js/market.js      US stock market hours + NYSE holidays (for the quiet-market notice on Buy)
js/explainer.js   the two tutorials
js/app.js         screens, carving, collect/sell/ride, the flip, TrickleTown Hall, the Site Office, the menu, leaderboards, friends, profiles and walls
js/api.js         fetch wrapper with the auth token
js/demo-api.js    in-memory fake API for demo mode (see below)
js/review.js      the welcome-back performance review chart
sw.js             service worker: daily-reminder pushes and taps only, no caching
manifest.webmanifest  makes it installable (Share → Add to Home Screen)
favicon.svg       the droplet; icon-192.png / icon-512.png / apple-touch-icon.png are it as app icons
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

At phone width (under 1000px): the headline, both faces of a sample coin
("heads: your money", "tails: your lobbyists"), "Play as a guest · no
account", "Create an account", "60-second training first", the 18+ line, the
three pitches, and a live line from `/trickle` ("$100 to charity on January
1 · N players lobbying", the count only from 25 up). Wider than that, as
below.

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

## The menu, profiles, friends

Today's game is the page. Everything else is behind ☰: your profile,
Leaderboards, Friends, Lobbyfest & charities, Trophies, How to play, Report a
bug, Appearance, Account (and Admin, for admins).

Every username opens a profile (`#u/<name>`; yours is `#profile`): a
Robinhood-style chart of trading gains (positions only: gifts and town
spending don't move it; scrub it, 1W / 1M / 3M / All), win rate and best and
worst trades, what they're holding, their town (scores, buildings and
upgrades, how often they side with Preston or Dolores), lobbyists by
charity, trophies, and a wall.

Friends (☰ → Friends): add anyone by username. They're told ("erin added
you as a friend", a small card with an Add back button, once per browser),
and you stay in an "Added you" list on their Friends page until they add you
back or not. It's one-way until then: they see you only if they add you back.
Removing someone is silent. You get a friends-only board, a
"erin bought NVDA" line under the crowd strip on Today, and adding someone
lets them read and write on your wall. Nobody else can. You can delete
anything on your wall; they can delete their own posts. A red dot on ☰ means
someone wrote on yours. Guests can add friends but can't be added, since a
guest's name isn't shareable. In demo mode, `ravi_k` and `bagholder_ben` are
addable, and erin's and ravi_k's walls are open to you.

## Charities, requests, bug reports, admin

The charities are real (18, each 4 of 4 stars on Charity Navigator; the list
lives in the backend's `src/charities.js`). Players choose one right after
their first lobbyists, in the first-hire sheet: the cards show cause, one
line, stars and site, with the reminder that the default is where every new
lobbyist goes and that more lobbyists means a bigger share of the ad money.
Skipped, it comes back (a to-do line, and once a session on its own). Anyone
whose charity was retired gets the same chooser.

"Don't see yours? Request a charity" (in the chooser, Assign lobbyists,
Lobbyfest and the FAQ) sends a name, website and reason. ☰ → Report a bug sends
a description plus the page they were on (they can untick it). Both land on
☰ → Admin (`#admin`), which only admins see: every transaction in order, every
open position, every player with their numbers, and the requests and reports.
The server checks admin on every call; the page just asks.

☰ → Mission &amp; promises (`#promises`, also readable signed out, and linked
from the landing page, Lobbyfest and the FAQ) is the one page with no jokes:
the mission, a short version, and the full promises, which are the actual
commitment. Its numbers ($100 minimum, $5 per charity) match the backend's
`LOBBYFEST` rules; change them together. Last-updated date: `PROMISES_UPDATED`
in `js/app.js`.

TrickleTown → Assign lobbyists: type an amount (decimals fine) or step with
− / + by 0.1, 1, 5 or 10; a bar shows the split as it changes; Reset undoes.

Cleaning up (all from the admin page, each with a confirmation sheet that
shows exactly what will change, from a server dry run):
- Transactions → Delete: undoes that transaction (a position with its ride
  chain; money, lobbyists and P&L back where they were). Two taps.
- Players → Lobbyists: take some or all of a player's lobbyists away this
  quarter. Two taps.
- Players → Remove, or tick several → Remove…: deletes the accounts and
  everything of theirs. Type the username (or the count) to confirm. Admin
  accounts can't be removed.

## Deploy to GitHub Pages

1. Edit `config.js`: set `API_BASE` to your Heroku app URL (no trailing slash)
   and `SITE_URL` to where the site will live. `index.html` has a
   Content-Security-Policy: if the API URL changes, change its `connect-src`
   too, and if you add an ad network or analytics, add its domains, or the
   browser blocks them without a word.
2. Push to GitHub. Settings → Pages → deploy from the `main` branch, root.
3. If you use a custom domain, add a `CNAME` file containing it, the same way as
   your other GitHub Pages sites.
4. Make sure the backend's `CORS_ORIGIN` includes this site's origin
   (`https://stevenbhester.github.io` and/or your custom domain).
5. Each release: bump the `?v=` on the script and stylesheet tags in
   `index.html`, and put the same value in `version.txt`. The page checks
   `version.txt` (uncached) on load and when the tab comes back; if a newer
   build is live it reloads itself once, so nobody sits on a cached old page
   for GitHub Pages' ten minutes. If the
   release needs a newer server, raise `API_WANTS` in `js/app.js` to match
   `API_VERSION` in the backend's `src/routes.js`; signed in as an admin,
   the page shows a yellow bar while the server is behind.
6. This repo is only the page. Server files (`src/`, `scripts/`, `Procfile`,
   `package.json`, `app.json`) belong in the Heroku repo; here they're just
   public clutter.

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

## Light and dark

☰ → Appearance: Auto (follows the device, and changes with it), Light, or
Dark. The choice is per device (`localStorage`, key `trickledown.theme`;
Auto stores nothing) and syncs across open tabs. `js/theme.js` runs first
thing in `<head>`, before any stylesheet, and sets `data-theme` on `<html>`,
`color-scheme` (so form controls and scrollbars match) and the
`theme-color` the phone's browser bar uses. So there's no white flash.

Colours are tokens on `:root` in `css/style.css`; dark mode is one block of
the same tokens under `:root[data-theme="dark"]`, plus overrides for things
that draw with their own colours. Use a token for any new colour (`--card`
for a white surface, `--edge` for a strong border, `--inverse` /
`--on-inverse` for a solid ink chip, `--on-accent` for text on a water,
rise or sink fill, `--tip` for toasts). In light mode every token resolves
to the colour it replaced, so light mode is pixel for pixel what it was.

The drawings carry both palettes, so a switch repaints everything without a
re-render, open sheets included:

- The coin turns pewter instead of polished silver. Each wedge carries its
  light and dark fill (`--wf` / `--wfd`) and a label colour for each.
- TrickleTown is the same town at night: the sky and grass follow happiness
  as before, a moon and stars when it's happy, darker clouds when it isn't,
  windows lit.
- Building tiles, the portraits behind Preston, Dolores and the cat, and the
  tutorial art have dark versions. The achievement note is lamp-lit paper.
- Google's sign-in button is redrawn in its dark style.

On phones, double-tap doesn't zoom the page (`touch-action: manipulation`)
and every form field is at least 16px, which iOS Safari otherwise zooms into
when you tap it. Pinch zoom still works.

## Design notes

- One accent colour (water blue), one display face (Big Shoulders Display) for
  the wordmark and money, one text face (Public Sans, the US government's
  typeface, which is the joke).
- The Today screen is a coin with a milled edge and a two-way switch under
  it: **Portfolio** (the front) and **TrickleTown** (the back). The switch
  flips the coin; so does tapping the coin. The front is a ring: open
  positions as wedges labelled with the dollars in them and coloured by how
  they're doing (pale to strong green or rust, dark when busted, a gold edge
  once matured); uninvested cash as a fan of bills; cash free to spend in
  the centre. Under it: a to-do list, the buy box, and the positions, each
  with a 24-hour bar. Pick a stock, then an amount, and a dashed slice shows
  where the wedge will land. Tap a wedge to collect it (matured) or sell
  early. The day's first load tosses the coin in.
- TrickleTown is four things: the two scores on top (profit, happiness, with
  the lobbyist price and this quarter's headcount), Town Hall (the day's
  cards, and a link to the full deck in a sheet), the construction zone (one
  tile per lot; tapping a lot, on the coin or in the list, opens the Site
  Office), and Payroll (lobbyists by charity, the Assign button, your rank,
  the records). Tapping a building or an advisor on the coin opens the same
  sheets.
- Two tutorials, short: the employee training (4 slides, from the landing
  page or the ? button) and the TrickleTown tour (3 slides, the first time
  the town opens). The How page is a FAQ.
- Nothing pops out of nowhere. An achievement knocks first: a small card
  rises from the bottom, no backdrop, and the sheet opens when the player
  taps it. Sheets marked `soft` (the achievement, the first-hire ceremony)
  rise in while the backdrop fades up, and ease away on close.
- Receipts read as arithmetic: every tax amount carries a minus (`−$10K`),
  in receipts, the ride box, toasts and the hire ceremony; the achievement
  gift a plus. Negative money anywhere uses a true minus sign (−), joined to
  the `$` so they never split across lines.
- The stat strip over Town Hall and the Site Office is labelled "Your stats
  right now" and styled as a flat readout, not a card, so it can't be read
  as what the card below costs. After a pick, its small tags show what that
  pick changed.
- The buy amount reads as one figure, `$50K`: the `K` follows the digits as
  you type (`placeK` in `js/app.js`), not the far edge of the box.
- Play-money tax hires lobbyists at a dollar a head; they are never shown as
  dollars. Fractional lobbyists are drawn clipped to the fraction, head first.
- Outcomes get a deadpan tier name, a ladder each way: Pocket change (under
  +10%), Respectable, Nice, Heater, Legend (doubled or better); Paper cut
  (under −10%), Flesh wound, Taking on water, Comically disastrous (−50% or
  worse), Rest in peace (all of it). Tiers show on the receipt, in the
  records, on the 24-hour board, and set the share card's emoji and opening
  line.
- Share my day (bottom of Today) previews a short text card: "Trickle Down ·
  Day N · total", then Sold:, Riding: and Bought: rows (each trade with its
  tier emoji and %), and the link. Day N counts the account's days. Trading
  only.
- A new post on your wall: one quiet toast, a to-do line that opens your
  wall, and a dot on your avatar until you've read it.
- The deck: any card you've played opens to the situation, both pitches, and
  the side you took.
- The cat (day two): you name it and pick she/he and a coat. It lives in the
  village (tap it), has a row on the town panel, shows on your profile, and
  has a wardrobe from a $15K bow tie to a $1M crown. Portrait and village
  sprite are `Coin.catPortrait` and `Coin.catSprite` in `js/coin.js`.
- Link previews: `og.jpg` (1200×630) and the Open Graph / Twitter tags in
  `index.html` are what Slack, iMessage, Discord and X show when someone
  pastes the link. Crawlers don't run JavaScript, so the URLs there are
  absolute and fixed to trickledown.stevenhester.com. If you change the
  image, bump its `?v=`: Slack and iMessage cache previews by URL.
  `apple-touch-icon.png` is the home-screen icon.
- Ranks: Intern, Staffer, Consultant, Lobbyist, Fixer, Kingmaker, Shadow Cabinet.
- The ad slot in the footer is a labelled placeholder until there's an ad network.
