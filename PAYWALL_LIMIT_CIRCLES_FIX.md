# Expired-subscription paywall correction

- Replaced the inaccurate “Unlimited AI scans” benefit with “Up to 50 AI scans per day”.
- Confirmed the backend premium limit is `DAILY_SCAN_LIMIT = 50`.
- Prevented the benefit check circles from shrinking into ovals on narrow iPhone layouts by fixing their flex basis and minimum width.
- Updated both `web/index.html` and `ios/App/App/public/index.html`.
- Rebuilt `dist/worker.js`.
