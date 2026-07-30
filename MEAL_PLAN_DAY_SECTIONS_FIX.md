# Meal Plan full-day section fix

## Confirmed issue

The previous build required the AI to return Morning, Midday, Evening and Snack slots, but the app rendered every meal inside one shared `Your day` list. The slot was only a small line inside each meal card, so the daily structure was easy to miss and did not look like separate morning/day/evening sections.

## Changes

- Meal Plan now renders four visible groups in order:
  - Morning
  - Midday
  - Evening
  - Snacks
- Each group uses the existing meal-card design. No new tool, navigation item or unrelated design was added.
- Meal-plan schema was raised from v2 to v3.
- Local and server caches are accepted only when they contain exactly:
  - one Morning meal;
  - one Midday meal;
  - one Evening meal;
  - one or two Snacks.
- Old or malformed cached plans are discarded and must be generated again by AI.
- AI still chooses the food sticker/emoji for every meal and recommendation.

## Unchanged

- Subscription and Restore Purchase logic.
- Paywall and RevenueCat integration.
- Face Scan, Food Scanner, Glow Up Plan and other tools.
- `.github` workflows.

## Verification

- Web and iOS bundled HTML are byte-identical.
- Worker JavaScript syntax check passed.
- Web worker build passed.
- AI-only audit passed.
- Subscription audit passed.
- Full-day UI/cache audit passed.
