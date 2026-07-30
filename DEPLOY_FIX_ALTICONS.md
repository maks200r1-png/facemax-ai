# iOS deployment fix — stale AltIcons references

The previous GitHub Actions run reached Xcode Archive but failed because
`project.pbxproj` still referenced deleted files:

- `AltIcons/AppIcon-Streak7@2x.png`
- `AltIcons/AppIcon-Streak7@3x.png`
- `AppIconPlugin.swift`

Fixes included:

1. `ios/App/scripts/restore_plugins_pbxproj.py` now removes every legacy
   alternate-icon object and reference before restoring CameraOvalPlugin and
   ScreenshotPlugin.
2. `.github/workflows/ios-build.yml` checks after every `cap sync` that none of
   `AltIcons`, `AppIcon-Streak`, or `AppIconPlugin` remains in project.pbxproj.
3. The normal application icon remains in
   `Assets.xcassets/AppIcon.appiconset`.

Also note: the Fastlane log reported HTTP 403 while pushing newly generated
certificates/profiles to the Match repository. The GitHub token used by
`MATCH_GIT_BASIC_AUTHORIZATION` needs write access to that certificates repo.
