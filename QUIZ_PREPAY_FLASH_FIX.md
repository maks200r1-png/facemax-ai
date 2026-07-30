# Quiz capture → Pre-Pay flash fix

## Cause
On iOS, returning from the native camera/photo picker can restore WKWebView without transient HTML classes while the capture screen remains active. `openScreen()` previously only removed `fm-quiz-active` when leaving quiz screens; it did not restore the class when opening or resuming `capture`/`prePay`. The fixed bottom navigation could therefore appear for a frame before the Pre-Pay screen opened.

## Fix
- `openScreen()` now derives `fm-quiz-active` from the destination screen in both directions.
- `onbSetPhoto()` restores quiz chrome before rendering a returned native photo.
- `onbProceedToScan()` restores quiz chrome before the async premium check.
- The loading screen also hides app navigation during an active scan transition.
- Pre-Pay no longer fades in from transparent on its first frame.
- Async front/side photo processing is pinned to the original photo target, preventing a fast Continue tap from writing the front image into the side slot.

## Scope
Web UI and bundled iOS web UI only. No Worker/API changes.
