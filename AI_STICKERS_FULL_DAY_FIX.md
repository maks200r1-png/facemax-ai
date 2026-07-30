# AI stickers and full-day meal plan fix

Verified against the latest AI-only project build.

## What was wrong

- Glow Up task emojis were selected by hardcoded keyword rules in the client.
- Food Scanner swap emojis came from a fixed client-side array.
- Meal Plan accepted missing emojis and substituted generic food emojis.
- Meal Plan only required 4+ arbitrary meal entries, so the AI response was not structurally guaranteed to cover morning, midday and evening.

## What changed

- Every Glow Up task now contains an AI-generated `e` field. The Worker requires six non-empty AI-selected emojis and rejects duplicate task emojis.
- The client renders the exact emoji returned with each Glow Up task. Keyword mappings and fallback sticker arrays were removed.
- Meal Plan requires AI-selected emojis for every meal and every Eat/Limit item. Missing stickers invalidate the AI response; no generic sticker is inserted.
- Meal Plan now requires one `Morning`, one `Midday`, one `Evening`, and one or two `Snack` entries.
- Food Scanner swaps now include an AI-selected `e` field. The old fixed swap emoji array was removed.
- Glow Up cache was bumped to `v5` so older plans without AI-selected task stickers are not reused.
- Meal Plan schema was bumped to version `2`; legacy cached plans are purged and regenerated through AI.

Static navigation icons and fixed metric-category icons remain static UI assets. They do not represent AI-generated recommendations.

## Verification

- Worker JavaScript syntax: passed.
- All inline application scripts syntax: passed.
- AI-only endpoint tests: passed.
- Subscription/paywall/restore audit: passed.
- Web build: passed.
- Cloudflare site Worker build: passed.
- `web/index.html` and iOS public `index.html`: identical.
- `.github` workflows: unchanged.
