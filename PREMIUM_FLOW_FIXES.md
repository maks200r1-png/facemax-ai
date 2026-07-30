# Premium flow fixes

## Scope

The onboarding/quiz paywalls (`prePay` and `quizPaywall`) were intentionally left unchanged.

The separate in-app premium gate is now the single paywall used after an existing subscription or trial has expired.

## Updated behavior

- Every paid entry point performs a fresh RevenueCat/backend subscription check before opening.
- An inactive entitlement opens the in-app paywall with weekly, monthly, and yearly products.
- The app remembers the exact action the user attempted.
- A successful purchase or Restore Purchases resumes that action automatically.
- Rapid purchase and restore taps are de-duplicated to avoid multiple StoreKit requests.
- Expired RevenueCat history in `entitlements.all` never unlocks the app; only `entitlements.active` is accepted.
- A stale local premium flag can no longer keep access forever. Local access is bounded by the real expiration date, or by a short 15-minute post-purchase bridge while RevenueCat/server state synchronizes.
- If both RevenueCat and the backend cannot verify access after that bridge, paid access fails closed rather than trusting stale state.
- Backend `402` responses route lapsed users to the in-app three-plan gate. Active customers get a short sync retry instead of a second payment prompt.

## Paid entry points covered

- New face scan
- Food scan
- Full AI report
- Glow Up plan
- Skin plan
- Jawline plan
- Scan comparison
- Meal plan viewing/generation

## TestFlight checklist

1. Start a Sandbox trial and confirm paid features open without another paywall.
2. Let the Sandbox subscription expire, foreground the app, then tap each paid feature above.
3. Confirm the in-app gate shows weekly, monthly, and yearly products.
4. Buy each product in separate Sandbox tests and confirm the originally requested feature resumes automatically.
5. Restore an active purchase from the gate and confirm the requested feature resumes.
6. Restore after all Sandbox subscriptions are expired and confirm the app says no active purchases were found and remains locked.
7. Confirm the onboarding quiz paywall layout and behavior are unchanged.

Real StoreKit/RevenueCat transactions must be validated on TestFlight or a StoreKit/Sandbox device. Static JavaScript, bundle parity, and build validation were completed in this package.
