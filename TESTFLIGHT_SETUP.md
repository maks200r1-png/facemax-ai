# Как настроить автодеплой в TestFlight через GitHub Actions

## Что происходит после настройки
Каждый раз когда ты пушишь в ветку `main` — GitHub сам собирает приложение
на виртуальном Mac и загружает в TestFlight. Руками ничего делать не надо.

---

## Шаг 1 — Создать приватное репо для сертификатов (Match)

Fastlane Match хранит твои iOS сертификаты и provisioning profiles
в отдельном приватном репо. Это безопасно — они зашифрованы.

1. Зайди на github.com → New repository
2. Название: `facemax-certificates` (любое)
3. **Private** — обязательно
4. Create repository
5. Скопируй URL репо: `https://github.com/ТВО_ИМЯ/facemax-certificates.git`

---

## Шаг 2 — Создать GitHub Personal Access Token

Нужен чтобы Actions мог читать репо с сертификатами.

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token (classic)
3. Название: `facemax-match`
4. Срок: No expiration
5. Права: поставь галочку **repo** (все подпункты)
6. Generate token
7. **Скопируй токен сразу** — потом не покажет

---

## Шаг 3 — Создать API ключ App Store Connect

1. Зайди на appstoreconnect.apple.com
2. Users and Access → Integrations → **App Store Connect API**
3. Нажми **+** → Generate API Key
4. Название: `GitHub Actions`
5. Access: **App Manager**
6. Download API Key (.p8 файл) — **скачается только один раз**
7. Запомни:
   - **Key ID** (10 символов, например `ABC123DEFG`)
   - **Issuer ID** (UUID вверху страницы)
   - Содержимое .p8 файла (открой в текстовом редакторе)

---

## Шаг 4 — Инициализировать Match (один раз, с Mac или в MacInCloud)

Этот шаг нужно сделать один раз чтобы создать сертификаты.
Нужен Mac с Fastlane (можно MacInCloud на 1 час — бесплатный триал).

```bash
# Установить Fastlane
brew install fastlane

# Перейти в папку iOS проекта
cd ios/App

# Установить зависимости
bundle install

# Инициализировать Match — создаст и загрузит сертификаты в приватное репо
bundle exec fastlane match init
# → выбери: git
# → вставь URL репо с сертификатами

bundle exec fastlane match appstore --app-identifier ai.facemax.app
# → придумай пароль для шифрования (запомни — это MATCH_PASSWORD)
# → войди в Apple ID если попросит
```

После этого в репо `facemax-certificates` появятся зашифрованные файлы.

---

## Шаг 5 — Добавить секреты в GitHub

Зайди в репо с кодом → Settings → Secrets and variables → Actions → New repository secret

Добавь по одному:

| Название секрета | Что вставить |
|---|---|
| `APP_STORE_CONNECT_KEY_ID` | Key ID из шага 3 (например `ABC123DEFG`) |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID из шага 3 (UUID) |
| `APP_STORE_CONNECT_API_KEY` | Содержимое .p8 файла (весь текст включая `-----BEGIN PRIVATE KEY-----`) |
| `MATCH_GIT_URL` | URL репо с сертификатами (`https://github.com/ТВО_ИМЯ/facemax-certificates.git`) |
| `MATCH_PASSWORD` | Пароль который придумал при `match appstore` |
| `GIT_TOKEN` | Personal Access Token из шага 2 |

---

## Шаг 6 — Убедиться что package.json есть в корне репо

Workflow делает `npm install` в корне. Убедись что в корне репо
(рядом с папкой `ios/`) лежит `package.json` с Capacitor зависимостями.

Если нет — создай его:

```json
{
  "name": "facemax",
  "version": "1.0.0",
  "dependencies": {
    "@capacitor/android": "^6.0.0",
    "@capacitor/app": "^6.0.0",
    "@capacitor/browser": "^6.0.0",
    "@capacitor/camera": "^6.0.0",
    "@capacitor/cli": "^6.0.0",
    "@capacitor/core": "^6.0.0",
    "@capacitor/device": "^6.0.0",
    "@capacitor/filesystem": "^6.0.0",
    "@capacitor/haptics": "^6.0.0",
    "@capacitor/ios": "^6.0.0",
    "@capacitor/local-notifications": "^6.0.0",
    "@capacitor/preferences": "^6.0.0",
    "@capacitor/share": "^6.0.0",
    "@capacitor/splash-screen": "^6.0.0",
    "@capacitor/status-bar": "^6.0.0",
    "@revenuecat/purchases-capacitor": "^8.0.0"
  }
}
```

---

## Шаг 7 — Запустить

```bash
git add .
git commit -m "Add TestFlight CI"
git push origin main
```

Потом: GitHub → репо → вкладка **Actions** → смотри лог в реальном времени.

Первая сборка займёт ~20-30 минут (CocoaPods долго ставится).
Последующие быстрее (~10-15 мин) благодаря кэшу.

---

## Если что-то пошло не так

- **Ошибка сертификата** → убедись что MATCH_PASSWORD правильный
- **Ошибка API key** → проверь что .p8 скопирован полностью включая заголовок
- **pod install failed** → скорее всего версии не совпадают, напиши — разберёмся
- **npm install failed** → нет package.json в корне (см. шаг 6)
