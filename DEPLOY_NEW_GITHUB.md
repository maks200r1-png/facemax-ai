# Deployment settings for this archive

- App marketing version: `1.6`
- Match repository: `https://github.com/maks200r1-png/facemax-ai-cert.git`
- Match branch: `main` by default
- Normal TestFlight builds use Match in read-only mode.

Required GitHub Actions secrets:

- `APPLE_TEAM_ID`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_CONTENT`
- `MATCH_PASSWORD`
- `MATCH_GIT_BASIC_AUTHORIZATION`

If the certificate repository actually uses `master`, change `MATCH_GIT_BRANCH` in both workflow files or set the environment value to `master`.
