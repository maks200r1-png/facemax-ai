# Signing fix v3

- Normal CI/TestFlight runs use Fastlane Match in readonly mode.
- `force: true` was removed so a new Apple Distribution certificate is not created on every build.
- Manual workflow runs expose a `bootstrap_signing` checkbox for a one-time writable Match bootstrap.
- The Match repository defaults to `maks200r1-png/facemax-ai-cert`.

Before the one-time bootstrap, revoke at least one unusable Apple Distribution certificate if the Apple account is at its certificate limit, and make sure `MATCH_GIT_BASIC_AUTHORIZATION` has Contents read/write access to the Match repository.
