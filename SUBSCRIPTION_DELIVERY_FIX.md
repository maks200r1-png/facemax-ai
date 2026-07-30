# FaceMax AI — исправление доставки подписки в Worker

## Найденная причина

В предыдущей версии Worker начал требовать новый `REVENUECAT_SECRET_API_KEY` для каждого запроса синхронизации подписки. GitHub Actions не изменялись и этот Cloudflare secret автоматически не создавали. Если secret не был установлен вручную, `/api/apple-receipt-verify` отвечал `503`, локальный RevenueCat entitlement уже был активен, но запись Premium в `PREMIUM_KV` не появлялась. Из-за этого платные AI-эндпоинты возвращали `402 premium_required`, а приложение показывало общий `Try again`.

Дополнительно клиент отправлял Worker локальный `user_id`, а не всегда фактический RevenueCat App User ID. Это могло ломать синхронизацию после смены идентификатора, например после Sign in with Apple.

## Что исправлено

- Worker больше не зависит от нового вручную установленного secret для чтения статуса подписки.
- Для read-only `GET /v1/subscribers/{app_user_id}` используется существующий публичный iOS SDK key; secret, если установлен, по-прежнему имеет приоритет.
- Клиент после покупки и Restore получает фактический RevenueCat App User ID через `Purchases.getAppUserID()` и отправляет его Worker.
- Поддерживаются RevenueCat anonymous IDs вида `$RCAnonymousID:...`.
- RevenueCat customer привязывается к одному локальному аккаунту в KV; повторная привязка к другому аккаунту блокируется.
- Restore по-прежнему не добавляет дни: сохраняется только точная дата активного entitlement из RevenueCat.
- Webhook Authorization проверяется, когда secret настроен. Без него webhook не может сам выдать или отобрать Premium: состояние повторно проверяется через RevenueCat API.

## Изменённые файлы

- `workers/api/src/worker.js`
- `workers/api/wrangler.toml`
- `web/js/native-bridge.js`
- `ios/App/App/public/js/native-bridge.js`
- `tests/subscription-audit.mjs`

Файлы `.github`, Face Scan, Glow Up Plan, дизайн, RevenueCat products, paywall и нативные плагины не менялись.

## Проверка

- `node tests/subscription-audit.mjs` — PASS
- `npm run build:web` — PASS
- JavaScript syntax check — PASS
- `.github` SHA-256 совпадают с предыдущим архивом
