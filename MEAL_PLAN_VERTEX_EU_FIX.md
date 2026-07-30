# Meal Plan reliability fix — Google Vertex EU only

## Privacy routing

All AI calls remain pinned to:

- model: `google/gemini-2.5-flash-lite`
- provider endpoint: `google-vertex/eu`
- `allow_fallbacks: false`
- `data_collection: deny`

No alternate AI provider or region is permitted.

## What was wrong

The previous stability patch incorrectly enabled provider fallbacks. That change has been reverted.

The Meal Plan had several failure paths that do not exist, or are much less likely, in the smaller Glow Up response:

1. The model had to produce a long nested response with 4–5 meal entries plus 12–16 extra Eat/Limit cards.
2. The schema allowed any order/count of meal slots, while later code rejected responses without exactly one Morning, Midday and Evening entry.
3. A single incomplete field caused the entire response to be rejected immediately.
4. The restriction checker used raw substring matching. Safe phrases such as `oat milk`, `peanut butter`, `buckwheat`, or explanatory text containing `without dairy` could be rejected incorrectly.
5. The output limit was lower than the Meal Plan's response size needed in some generations.
6. The client required an exact schema-version match even when the returned AI plan itself was complete and valid.
7. A client timeout could show an error even if the Worker finished and saved the plan moments later.

Without production Worker logs, it is not possible to prove which one caused a specific failed attempt. All of these were real Meal-Plan-only failure paths and have been corrected.

## Changes

- Restored strict Google Vertex EU-only routing globally.
- Meal Plan structured output now uses fixed `morning`, `midday`, `evening`, and `snacks` fields, then converts them to the existing UI array.
- Added one content-level retry when the model returns complete JSON that fails Meal Plan validation. The retry uses the same Gemini model and the same Vertex EU endpoint.
- Increased Meal Plan output allowance to 4096 tokens.
- Kept network retries on the same Vertex EU endpoint only.
- Added compatibility normalization for Breakfast/Lunch/Dinner labels from an in-flight older response.
- Fixed dietary restriction validation to inspect recommended food names/ingredients rather than warning text.
- Added plant-milk, plant-butter, and plant-cream exceptions so safe lactose-free/vegan plans are not falsely rejected.
- The client now accepts any complete, AI-sourced full-day plan even if an older deployed Worker reports a different schema version.
- After a timeout/error, the client checks the server once for a plan that may already have completed and been saved.
- No static Meal Plan is inserted on failure.
- AI still selects every meal and every sticker.

## Not changed

- Glow Up Plan content or cache logic
- Face Scan
- Food Scanner
- subscriptions, paywall, RevenueCat, or Restore Purchase
- notification logic
- `.github` workflows
