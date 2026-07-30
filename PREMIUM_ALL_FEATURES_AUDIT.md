# Premium all-features audit

Date: 2026-07-30

## Result

All user-facing paid entry points use the same fresh `checkPremium(false)` gate through `ensurePremiumForAction()`:

- New face scan (both bottom-nav entry and final scan start)
- Full AI report
- Glow Up Plan
- Skin plan / Jawline plan
- Compare scans
- Daily hub
- Food Scanner (screen entry and scan submission)
- Calorie tracker
- Water tracker
- Morning routine
- Exercise program
- Meal Plan (screen entry and generation)

None of these feature handlers calls `facemax.purchase()`, `restorePurchases()`, or `markPremiumActiveLocally()`. Purchases can start only from the explicit paywall checkout handler, and restore can start only from the explicit Restore Purchases handler.

## Server protection

Expired users receive HTTP 402 from all paid API endpoints:

- `/api/full-report`
- `/api/food-scan`
- `/api/glow-plan`
- `/api/skin-plan`
- `/api/jawline-plan`
- `/api/dating-photo`
- `/api/haircut-guide`
- `/api/meal-plan` GET/POST

The backend mirrors only an expiration verified from RevenueCat. Feature requests never extend `premium_until`.

## Fixes included

1. RevenueCat plugin startup race: `initRevenueCat()` waits up to 12 seconds for the Capacitor Purchases bridge. This fix is central, so it applies to every paid feature, not only face scanning.
2. Glow Up Plan 402 handling: it now rechecks RevenueCat, shows the paywall when inactive, and retries exactly once when the backend mirror is still syncing.
3. Subscription audit expanded to verify every paid endpoint, the startup wait, and that normal feature actions cannot initiate purchases, restore purchases, or grant Premium locally.

## Validation

- `node tests/subscription-audit.mjs` — PASS
- `node --check web/js/native-bridge.js` — PASS
- `node --check workers/api/src/worker.js` — PASS
- Extracted inline scripts from `web/index.html` — syntax PASS
- `web/index.html` and `ios/App/App/public/index.html` are identical
- `web/js/native-bridge.js` and `ios/App/App/public/js/native-bridge.js` are identical
