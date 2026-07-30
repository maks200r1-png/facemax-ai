# FaceMax AI — UI overhaul

This pass unifies the most dated in-app screens under one mobile design system.

## Updated screens

- Calories
  - Replaced browser-like selects with large segmented choices and activity cards.
  - Simplified copy and made the daily target/result visually dominant.
  - Kept all existing calculator IDs and calculation logic.
- Profile
  - Replaced stacked web cards with iOS-style grouped settings rows.
  - Removed the duplicate Restore Purchases entry.
  - Kept reminders, gender calibration, privacy, terms, history deletion and account deletion.
- Internal premium paywall
  - Added a clean three-plan selector (weekly/monthly/yearly) with one primary CTA.
  - Kept Restore Purchases and StoreKit price bindings.
  - The quiz/prePay paywall was not changed.
- Food Scanner result
  - Shows only three quick face-impact takeaways by default.
  - Full metrics, ingredients, swaps and timing are tucked into a disclosure panel.
- Full AI report
  - Reorganized the photo, score, summary and detailed metrics into a clearer hierarchy.
- Exercise detail
  - Made the exercise visual the focus, simplified the timer controls and added a sticky completion action.

## Technical notes

- `web/index.html` and `ios/App/App/public/index.html` are identical.
- Existing subscription flow and RevenueCat purchase functions remain in place.
- Existing element IDs used by JavaScript were preserved.
- Inline JavaScript and `web/js/native-bridge.js` passed syntax checks.
- `npm run build:web` passed.
