# One-time iOS signing reset

Run `.github/workflows/ios-signing-reset.yml` manually and enter `DELETE_AND_RECREATE`.
The workflow revokes App Store signing assets, creates one new Apple Distribution certificate/profile, and pushes them to the Match repository.
After success, use the normal iOS build workflow with `bootstrap_signing` disabled.
