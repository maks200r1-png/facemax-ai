# Superseded AI stability note

The earlier multi-provider routing change was incorrect for FaceMax AI's privacy design and has been reverted.

The current implementation routes every AI request only to `google-vertex/eu` with `allow_fallbacks: false`. Meal Plan reliability is handled inside its own schema, validation, retry, timeout, and cache-recovery logic without changing AI provider or region.

See `MEAL_PLAN_VERTEX_EU_FIX.md`.
