# Full Design Pass v5

## Redesigned

- Home dashboard: latest scan, today's Glow Up Plan, progress stats, quick tools, calorie card.
- Glow Up Plan: focus hero, weekly activity, task progress, task cards, metrics, tips and scan history cards.
- Daily Debloat hub cards and achievements.
- Water Tracker, Morning Routine and Exercise Program visual consistency.
- Compare Scans, AI tool details, History, upload card and bottom navigation.
- Existing redesigns for Meal Plan, Calories, Profile, internal three-plan paywall and Exercise Detail were retained.

## Intentionally unchanged

- Quiz flow and quiz paywall.
- Face Scan result and full AI report content/layout.
- Food Scanner flow and full Food Scan result content/layout.
- Premium access logic and RevenueCat flow.

## Technical checks

- `web/index.html` and `ios/App/App/public/index.html` are identical.
- Inline JavaScript syntax checked with Node.js.
- CSS parsed without syntax errors.
- Web tree validated with `npm run build:web`.
