# Trickle Down — front end

The daily game. Fake money, real market, real charity. This is the static site
that runs on GitHub Pages; the API it talks to lives in `heroku-trickledown`.

No build step. Plain HTML, CSS, and JS.

```
index.html        the shell: masthead, tabs, screens, bottom sheets
config.js         API_BASE and SITE_URL — the only thing you must edit
css/style.css     the whole look; design tokens at the top
js/app.js         screens, rendering, buy / lock-in / share flows
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

Open `index.html?demo` (or any build where `config.js` still has the
placeholder backend URL) and the game runs entirely in the browser against
invented prices that move fast. Nothing is saved. Good for showing someone the
loop in thirty seconds, and for working on the design without a server.

## Deploy to GitHub Pages

1. Edit `config.js`: set `API_BASE` to your Heroku app URL (no trailing slash)
   and `SITE_URL` to where the site will live.
2. Push to GitHub. Settings → Pages → deploy from the `main` branch, root.
3. If you use a custom domain, add a `CNAME` file containing it, the same way as
   your other GitHub Pages sites.
4. Make sure the backend's `CORS_ORIGIN` includes this site's origin
   (`https://stevenbhester.github.io` and/or your custom domain).

## Design notes

- One accent colour (water blue), one display face (Big Shoulders Display) for
  the wordmark and money, one text face (Public Sans, the US government's
  typeface, which is the joke).
- The Today screen is a single vertical pipe: reservoir → market → basin. On a
  profitable lock-in a droplet runs down the pipe. That is the one piece of
  non-essential motion on the site, and it answers a tap.
- Outcomes get a deadpan tier name (Pocket change, Nice, Heater, Legend, Paper
  cut, Rest in peace). Tiers show on the receipt, in history, on the 24-hour
  board, and in the share text.
- The ad slot in the footer is a labelled placeholder until there's an ad network.
