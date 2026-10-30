// Where the backend lives. Change this to your Heroku app URL after deploying
// heroku-trickledown, e.g. 'https://trickledown-api-abc123.herokuapp.com'.
// Leave off the trailing slash. If you change the Heroku URL, change it in
// index.html's Content-Security-Policy (connect-src) too, or the game can't reach it.
window.TRICKLE_CONFIG = {
  API_BASE: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://trickle-down-io-ac476d1e18c9.herokuapp.com',
  SITE_URL: 'https://trickledown.stevenhester.com',
  // Optional. Your Google OAuth "Web application" client ID, the same one set
  // as GOOGLE_CLIENT_ID on the backend. Leave empty to hide Google sign-in.
  // (The backend's /auth/options also reports it, so this is just a head start.)
  GOOGLE_CLIENT_ID: '',
};
