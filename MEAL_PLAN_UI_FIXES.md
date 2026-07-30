# Meal Plan UI update

Updated the Meal Plan screen in both:

- `web/index.html`
- `ios/App/App/public/index.html`

## Changes

- Rebuilt the profile form as a mobile app interface with segmented controls, larger inputs, choice cards, and larger tap targets.
- Removed the old browser-like select-heavy layout.
- Reduced secondary copy and removed repeated meal descriptions.
- Added a compact plan header with an icon-only regenerate action.
- Replaced long tab labels with `Day`, `Eat`, and `Limit`.
- Restyled food cards with the same blue-purple-pink gradient used by the main app actions.
- Increased meal names and useful details while clamping descriptions to two lines.
- Added responsive rules for smaller iPhones.

Subscription and server logic were not changed in this UI pass.
