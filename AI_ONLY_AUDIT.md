# FaceMax AI — AI-only generation audit

Date: 2026-07-23

## Result

All user-facing features presented as AI-generated now accept content only when the Worker returns `source: "openrouter"`. If OpenRouter is missing, unreachable, or returns malformed/incomplete JSON, the request fails with an explicit error. The Worker does not substitute prewritten scores, reports, plans, meals, food analyses, or tool advice.

## AI-generated flows checked

- Face Scan / Full AI Report
- Glow Up Plan
- Meal Plan
- Food Scanner analysis
- Skin Plan
- Jawline Plan
- Profile-photo coach endpoint
- Haircut-guide endpoint
- Server face-presence check

## Changes made

### Glow Up Plan

- Removed the legacy prewritten fallback plan.
- Removed the hardcoded day-of-week focus rotation.
- The approach is selected from the latest scan metrics, current photo thumbnail, score changes, previous completion, streak, time of day, and onboarding answers (age range, goal, concerns, routine, available time, reason for starting).
- Exactly six AI steps and three AI metric notes are required.
- Missing or invalid AI output returns an error and is not cached.
- Cache version was moved to `v4`, so older plans generated under the canned rotation are not reused.
- A valid AI plan is generated once after local midnight or after a new scan, then the same AI-generated plan is cached for that day.

### Meal Plan

- Removed the static fallback menu.
- A plan is saved only after a valid OpenRouter response.
- Missing/invalid AI output does not overwrite the previous valid AI plan and does not create a new cached plan.
- Legacy fallback records in KV and legacy non-AI local cache entries are rejected.
- Dietary restrictions and dislikes are checked before saving. The validator checks recommended foods, while allowing the `avoid` section to name foods the user must avoid.
- Minimum supported age is 18.
- The plan is generated on first creation or manual regeneration, then the same AI-generated plan is kept as a durable reference.

### Face report

- Removed report backfilling with fixed scores/text.
- The Worker now requires the complete report schema and all score fields.
- Metrics-only reports now receive the current overall score, all current metrics, face shape, and gender in the prompt.
- Client storage/history accepts only complete reports marked as OpenRouter output; legacy unmarked reports are removed.

### Food Scanner

- Removed the generic fallback meal analysis.
- Added strict schema validation for the detected meal, scores, three ingredients, three AI swaps, AI benefit text, and AI-selected best eating time.
- Removed fixed percentage claims and fixed swap-benefit rotation from the client.
- Removed the client-side invented ingredient list when AI ingredients are missing.
- Removed fixed branded-calorie assumptions from the prompt; the model must use the visible product/variant, label, and portion when possible.
- Legacy food-scan history without confirmed OpenRouter source is removed.
- The fixed `No meal detected` object remains only as a non-food sentinel after the AI classifies the image as not food; it is not a meal plan or analysis fallback.

### Skin/Jawline/other AI tools

- Removed legacy static routines rendered beneath the AI response.
- Each tool requires a valid OpenRouter response with exactly six steps.
- On model failure the user sees an error instead of prewritten advice.

## What remains intentionally static

The following are normal application/UI logic, not generated AI content:

- paywall text, subscription plan buttons, navigation, and error messages;
- onboarding choices and preview/marketing cards;
- Daily Debloat, water tracker, exercise timer, notifications, and other explicitly non-AI features;
- colors, icons, score-bar thresholds, labels, and rendering logic;
- prompts, JSON schemas, safety rules, and validation rules used to constrain AI output.

## Important limitation

The app can guarantee that a displayed plan came from the configured AI provider and passed structural/restriction checks. It cannot guarantee that every model recommendation is objectively correct or medically optimal. AI output can still make mistakes; the code now avoids hiding model failure behind a canned plan.

## Files changed

- `workers/api/src/worker.js`
- `web/index.html`
- `ios/App/App/public/index.html`
- `tests/ai-only-audit.mjs` (new automated audit)

No file under `.github` was modified.
