# Food Scanner calorie and card-colour fix

## Visual treatment

Colour was added selectively rather than to every card:

- score cards use a subtle FaceMax blue-purple gradient;
- Face Effect cards use green, amber or red tints according to their status;
- Key Ingredients cards use green, amber or red tints according to AI impact;
- Better Alternatives keep their existing green treatment;
- Best Time uses the FaceMax purple treatment;
- photo history and structural containers remain neutral to avoid visual overload.

The AI still decides the food analysis, ingredient impact, swaps, stickers and suitable time slots. The client only renders the semantic colours.

## Packaged-drink calories

The Food Scanner now requires `calories_est` to represent the full visible portion or full visible can/bottle, not a per-100-ml value.

For energy drinks, cola and soda:

- Zero/Diet/Sugar-Free products may legitimately be around 0–25 kcal when the variant is visibly confirmed;
- a regular drink cannot silently be treated as sugar-free;
- a low calorie result that conflicts with medium/high sugar is rejected;
- inconsistent output triggers one fresh analysis using the same pinned model and provider.

AI routing remains unchanged:

- `google/gemini-2.5-flash-lite`
- only `google-vertex/eu`
- provider fallbacks disabled
- data collection denied

Calorie values from a photo remain estimates unless a readable nutrition label and package size are visible.
