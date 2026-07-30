# Meal Plan current-app compatibility fix

Root cause: the installed/source iOS client still uses Meal Plan schema version 3 and accepts only:
- exactly one Morning card;
- exactly one Midday card;
- exactly one Evening card;
- one or two Snack cards.

The later Worker returned the version 5 flexible structure (one or two main-period cards and zero to two snacks). The Worker could successfully generate a plan, but the current client rejected that response and displayed a generic generation error. Other AI features were unaffected.

This package restores Worker response compatibility without changing the app:
- schema_version remains 3;
- output shape exactly matches the current iOS validator;
- all dishes and stickers still come from AI;
- duplicate stickers trigger one best-effort retry but never make the second valid plan fail;
- text is shortened at word boundaries without ellipses;
- previous saved meal names/stickers are sent to AI to reduce repetition;
- no new iOS build is required for this rollback.

After deployment, `/health` must show:

`meal-plan-v3-current-app-compatible`
