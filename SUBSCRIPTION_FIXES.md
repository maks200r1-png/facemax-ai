# Subscription fixes

- Quiz and generic feature paywalls close immediately after RevenueCat confirms a purchase/trial; backend sync no longer blocks navigation.
- Restore Purchases closes quiz or generic feature paywalls and is guarded against repeated taps.
- Restore no longer grants access from expired entries in `entitlements.all`.
- Purchase no longer grants a fabricated 24-hour entitlement when RevenueCat reports no active entitlement.
- Native paywall state is checked from RevenueCat `CustomerInfo`; stale local storage cannot keep an expired subscription unlocked.
- Backend mirror receives the actual entitlement expiration, so a free trial is not mirrored as a full billing period.

Run `npm install`, then `npm run cap:sync`, open the iOS workspace, clean the build folder, and build a new TestFlight version.
