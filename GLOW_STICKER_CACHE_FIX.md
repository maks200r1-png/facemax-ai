# Glow Up Plan sticker cache fix

## Root cause
The Worker already required every AI-generated Glow Up task to contain a unique emoji/sticker. The client, however, trusted any cached object marked `source: "openrouter"` without validating `steps[].e`. A partial response cached while the app and Worker were on different versions could therefore remain in localStorage and render six empty sticker containers until the next cache refresh.

## Changes
- Added client-side validation for all six AI-selected task stickers.
- Invalid in-memory and localStorage plans are rejected and removed.
- Network responses are validated before they can be cached or rendered.
- Bumped the Glow Up Plan cache version from `v5` to `v6`, forcing one clean regeneration.
- Kept the Worker-side AI sticker validation unchanged.
- Updated both `web/index.html` and `ios/App/App/public/index.html` identically.
- Did not change `.github`, subscriptions, paywall, RevenueCat, Face Scan, Meal Plan, or native plugins.
