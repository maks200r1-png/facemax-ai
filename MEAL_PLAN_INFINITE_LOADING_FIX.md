# Meal Plan infinite loading fix

## Root cause

The app had an unhandled state in `openMeals()`:

- the Worker returned `{ ok: true, exists: true }`;
- the saved plan did not pass the current client schema validator;
- the code handled only `exists && valid` and `!exists`;
- `exists && invalid` matched neither branch, so `mealPlanState` remained `loading` forever.

This is why a failed/partial plan could become an endless spinner after reopening the app. Character compaction could expose a schema mismatch, but the permanent spinner itself was an app state-machine bug.

## Fix

- invalid saved plans now clear the local cache and return to the form;
- GET failures and malformed responses always settle to `form` (or keep a valid cached plan);
- a 26-second watchdog protects opening/reconciliation;
- a 135-second watchdog protects generation;
- returning from iOS background after 15 seconds of suspended loading restores the form instead of a frozen spinner;
- both `web/index.html` and the bundled iOS `public/index.html` contain the fix.

A new iOS/TestFlight build is required because this is client-side UI state logic.
