# Luminar Auth Backend

Node.js + Express + SQLite + JWT auth server для лоадера Luminar.

## Локальный запуск

```bash
npm install
npm start
```

Слушает на `http://localhost:3000`.

## Деплой на Render.com (бесплатно)

1. Залей папку `loader-backend` в отдельный GitHub-репозиторий.
2. Зарегистрируйся на https://render.com через GitHub.
3. New + → **Web Service** → выбери репо.
4. Render сам подхватит `render.yaml`. Жми **Apply**.
5. Через ~2 минуты получишь URL вида `https://luminar-auth.onrender.com`.
6. Открой Settings → Environment и **скопируй** значения `JWT_SECRET` и `ADMIN_KEY` — они тебе понадобятся.
7. Этот URL вставь в лоадер (`AuthApi.BASE_URL`) и в клиент (`AuthGate.API_URL`).

> Важно: на Free-плане сервис засыпает после 15 минут простоя. Первый запрос
> после простоя занимает ~30 сек (cold start). Это нормально.

## Endpoints

| Method | Path | Body | Описание |
|--------|------|------|----------|
| POST | `/api/register` | `{username, password, hwid}` | Регистрация |
| POST | `/api/login` | `{username, password, hwid}` | Логин |
| POST | `/api/verify` | `{token, hwid}` | Проверить токен |
| GET  | `/api/health` | - | Health check |

### Admin (header `x-admin-key: <ADMIN_KEY>`)

| Method | Path | Описание |
|--------|------|----------|
| POST | `/api/admin/users` | Создать аккаунт вручную |
| GET  | `/api/admin/users` | Список всех |
| DELETE | `/api/admin/users/:id` | Удалить |
| POST | `/api/admin/reset-hwid/:id` | Сбросить HWID-привязку |
| POST | `/api/admin/ban/:id` | Забанить |
| POST | `/api/admin/unban/:id` | Разбанить |

### Пример: создать аккаунт другу

```bash
curl -X POST https://luminar-auth.onrender.com/api/admin/users \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"friend","password":"qwerty123"}'
```

Дальше друг логинится через лоадер, и при первом логине сервер привяжет
его HWID. Если он переустановит винду — ты сбросишь HWID командой:

```bash
curl -X POST https://luminar-auth.onrender.com/api/admin/reset-hwid/3 \
  -H "x-admin-key: YOUR_ADMIN_KEY"
```

(где `3` — ID юзера из `/api/admin/users`)
