# GitHub Actions iOS deploy fix

Fixed the post-`cap sync` restore step:

- removed the obsolete requirement for `ios/App/App/AltIcons/`;
- removed references to the missing `AppIconPlugin.swift` / `.m`;
- kept restoration of the existing `CameraOvalPlugin` and `ScreenshotPlugin` files;
- the normal iOS AppIcon in `Assets.xcassets/AppIcon.appiconset` is unchanged.
