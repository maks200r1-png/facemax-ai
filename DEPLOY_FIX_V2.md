# iOS deploy fix v2

The workflow now purges all legacy `AltIcons`, `AppIconPlugin`, `AppIcon-Day*`, and `AppIcon-Streak*` PBX references after restoring custom plugins. The purge is embedded directly in `.github/workflows/ios-build.yml`, so it also protects builds when an older restore script was accidentally committed.
