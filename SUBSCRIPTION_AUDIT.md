# FaceMax AI — аудит подписок

Дата проверки: 23 июля 2026 года.

## Итог

До этого аудита подписочная логика была исправлена не полностью. В проекте оставались пути, которые могли создать или сохранить Premium без подтверждённой активной подписки. Эти пути устранены.

## Исправленная причина лишних дней после Restore Purchase

Раньше клиент отправлял на Worker собственные `productId` и `premium_until`, а Worker при отсутствии проверенной даты мог самостоятельно вычислить новый срок по тарифу. Поэтому Restore Purchase мог превратиться в выдачу нового периода Premium.

Теперь:

- Restore Purchase не вычисляет и не добавляет срок;
- клиент принимает только активный RevenueCat entitlement с точным идентификатором `premium`;
- принимаются только точные product ID FaceMax AI;
- записи из `entitlements.all`, истёкшие подписки и посторонние entitlements игнорируются;
- клиент отправляет Worker только текущий `user_id`;
- Worker сам запрашивает RevenueCat через серверный secret key;
- срок Premium берётся только из точного `expires_date` RevenueCat;
- если entitlement неактивен, Worker очищает старый сохранённый Premium;
- Restore с истёкшей подпиской возвращает `No active purchases found` и не закрывает paywall;
- старый небезопасный Restore по произвольному User ID отключён и перенаправлен на официальный Apple Restore Purchases.

## Что видит пользователь после окончания подписки

Главный экран, Profile, Settings и History остаются доступны. При открытии платной функции выполняется свежая проверка RevenueCat. Если подписка истекла, открывается существующий paywall с тремя вариантами:

1. Weekly
2. Monthly
3. Yearly

Проверка добавлена или подтверждена для:

- нового Face Scan;
- полного Face Scan report;
- Glow Up Plan;
- Compare scans;
- Skin plan;
- Jawline plan;
- Daily debloat;
- Food Scanner;
- Calorie tracker;
- Water tracker;
- Morning routine;
- Exercise program;
- Meal plan.

Платные API-эндпоинты также возвращают `402 premium_required`, если серверный срок Premium истёк.

## Поведение событий подписки

- `INITIAL_PURCHASE`, `RENEWAL` и восстановление: Worker заново сверяет entitlement с RevenueCat и сохраняет только точную дату окончания.
- `CANCELLATION`: доступ не отбирается раньше оплаченной даты.
- `BILLING_ISSUE`: доступ сохраняется до фактической даты окончания или конца grace period, которую сообщает RevenueCat.
- `EXPIRATION` и `REFUND`: Premium отзывается.
- `TEST`: не выдаёт Premium.
- события посторонних entitlements и неизвестных product ID игнорируются.
- RevenueCat webhook без правильного Authorization secret отклоняется.
- Apple Server Notification проверяет подпись, bundle ID и точный product ID перед изменением Premium.

## Дополнительное усиление

- удалён встроенный в приложение client sync secret;
- удалён shipped localStorage-флаг `FACEMAX_DEV_PREMIUM`, который мог локально обходить paywall;
- ручные `/api/test-grant` и `/api/payment-success` недоступны без серверного `ADMIN_SECRET` и возвращают 404;
- активный RevenueCat customer одного пользователя нельзя переиспользовать для другого `user_id`;
- web-версия и iOS public bundle синхронизированы.

## Настройка RevenueCat перед production deploy

Новая ручная установка `REVENUECAT_SECRET_API_KEY` больше не обязательна для доставки покупки в Worker. Для read-only проверки `GET /v1/subscribers/{app_user_id}` Worker использует существующий публичный iOS SDK key; если server secret установлен, он имеет приоритет.

`REVENUECAT_WEBHOOK_AUTH` рекомендуется настроить и указать тем же значением в RevenueCat Webhooks. Если он не настроен, webhook не может сам изменить Premium: Worker всё равно повторно читает фактический entitlement из RevenueCat перед записью в KV.

В RevenueCat Dashboard необходимо проверить:

- entitlement ID строго `premium`;
- к нему подключены `com.facemaxai.app.weekly`, `com.facemaxai.app.monthly` и `com.facemaxai.app.yearly`;
- эти три продукта присутствуют в Current Offering;
- webhook указывает на `https://facemax-api.voou96329.workers.dev/api/revenuecat-webhook`.

После обновления достаточно задеплоить Worker и собрать новый iOS/TestFlight build.

## Что проверено автоматически

Автоматические тесты покрывают:

- expired restore;
- unrelated entitlement;
- unknown product;
- точную дату активной подписки;
- отсутствие добавления дней;
- очистку старого backend Premium;
- webhook authentication;
- cancellation, billing/expiry/refund semantics;
- защиту от переноса подписки на другой user ID;
- серверные 402 для платных функций;
- недоступность ручных grant endpoints без admin secret;
- ровно три тарифа в обоих основных paywall;
- наличие общего premium gate у всех платных входов;
- совпадение web/iOS файлов;
- синтаксис JS и сборку web/Worker.

Полный вывод находится в `SUBSCRIPTION_TEST_RESULTS.txt`.

## Что всё ещё нужно проверить на реальном iPhone/TestFlight

Среда аудита — Linux, поэтому реальная StoreKit Sandbox-транзакция здесь не выполнялась. Перед релизом необходимо пройти один короткий TestFlight сценарий:

1. Купить Weekly и убедиться, что Premium active показывает точную дату Apple/RevenueCat.
2. Нажать Restore Purchase при активной подписке — дата не должна увеличиться.
3. Нажать Restore Purchase на Apple ID без активной подписки — должен остаться paywall и появиться `No active purchases found`.
4. Отменить автопродление — доступ должен сохраняться до даты окончания.
5. После sandbox expiration открыть каждую платную функцию — должен появляться paywall Weekly / Monthly / Yearly.
6. Проверить Monthly и Yearly по одному разу.

## Изменённые файлы

- `web/index.html`
- `web/js/native-bridge.js`
- `ios/App/App/public/index.html`
- `ios/App/App/public/js/native-bridge.js`
- `workers/api/src/worker.js`
- `workers/api/wrangler.toml`
- `tests/subscription-audit.mjs`
