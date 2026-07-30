# TestFlight premium re-check fix

## What was happening

Selecting a selfie did not directly grant or extend Premium. The scan flow calls a fresh RevenueCat subscription check before analysis. In TestFlight, that later check could discover an already auto-renewed Sandbox entitlement and then synchronize its exact expiration date to the backend, making it look as though the photo upload renewed the subscription.

The earlier Glow Up Plan check could incorrectly show the paywall when it ran immediately after app launch, before Capacitor had registered the RevenueCat `Purchases` plugin. It then fell back to a stale backend status. By the time the selfie was uploaded, the plugin was ready and the active entitlement was found.

## Fix

`initRevenueCat()` now waits up to 12 seconds for the native Purchases plugin before treating RevenueCat as unavailable. This makes Glow Up Plan, Face Scan, and other paid entry points use the same current native subscription state and prevents the false paywall → Premium-after-selfie sequence caused by plugin startup timing.

No photo-selection or scan handler writes Premium. Backend Premium is still granted only from a verified active RevenueCat/Apple entitlement.

## Validation

- Web and iOS native bridge files remain identical.
- JavaScript syntax checks pass.
- `tests/subscription-audit.mjs` passes.
