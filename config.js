// Where the backend lives. Change this to your Heroku app URL after deploying
// heroku-trickledown, e.g. 'https://trickledown-api-abc123.herokuapp.com'.
// Leave off the trailing slash.
window.TRICKLE_CONFIG = {
  API_BASE: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://YOUR-HEROKU-APP.herokuapp.com',
  SITE_URL: 'https://trickledown.stevenhester.com',
};
