# Настройка Email для подтверждения регистрации

## Что добавлено:

✅ Система подтверждения email с 6-значным кодом
✅ Отправка кода на почту при регистрации
✅ Страница ввода кода `/verify-email`
✅ Повторная отправка кода
✅ Блокировка входа для неподтвержденных аккаунтов

---

## Настройка Gmail SMTP

### 1️⃣ Создайте App Password в Gmail:

1. Откройте https://myaccount.google.com/security
2. Включите **2-Step Verification** (если еще не включено)
3. Перейдите в **App passwords**: https://myaccount.google.com/apppasswords
4. Выберите:
   - **App:** Mail
   - **Device:** Other (Custom name) → введите "Luminar"
5. Нажмите **Generate**
6. Скопируйте сгенерированный пароль (16 символов)

### 2️⃣ Добавьте переменные окружения на Vercel:

1. Откройте Vercel → Settings → Environment Variables
2. Добавьте:

```
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password-16-chars
EMAIL_FROM=Luminar <noreply@luminar.com>
```

3. Нажмите **Save**
4. Сделайте **Redeploy**

---

## Альтернативные SMTP сервисы

### Mailgun (бесплатно до 5000 писем/месяц):

1. Зарегистрируйтесь на https://www.mailgun.com/
2. Получите SMTP credentials
3. Измените в `server.js`:

```javascript
transporter = nodemailer.createTransport({
  host: 'smtp.mailgun.org',
  port: 587,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});
```

### SendGrid (бесплатно до 100 писем/день):

1. Зарегистрируйтесь на https://sendgrid.com/
2. Создайте API Key
3. Измените в `server.js`:

```javascript
transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',
    pass: process.env.EMAIL_PASS // Your SendGrid API Key
  }
});
```

---

## Режим разработки (без email)

Если переменные `EMAIL_USER` и `EMAIL_PASS` не установлены:
- Код подтверждения выводится в консоль сервера
- Код возвращается в ответе API (только для разработки)
- Пользователь может увидеть код на странице регистрации

**⚠️ В production обязательно настройте email!**

---

## Как работает:

### Регистрация:
1. Пользователь вводит username, email, password
2. Система создает аккаунт с `email_verified = 0`
3. Генерируется 6-значный код (действителен 10 минут)
4. Код отправляется на email
5. Пользователь перенаправляется на `/verify-email?email=...`

### Подтверждение:
1. Пользователь вводит код
2. Система проверяет код и срок действия
3. Устанавливает `email_verified = 1`
4. Выдает JWT токен
5. Перенаправляет в профиль

### Вход:
- **Веб-сайт:** Требует подтвержденный email
- **Лоадер:** Не требует подтверждения (для совместимости)

---

## Тестирование:

### Без настройки email:
1. Зарегистрируйтесь на `/register`
2. Код появится в сообщении на странице
3. Введите код на `/verify-email`

### С настроенным email:
1. Зарегистрируйтесь
2. Проверьте почту
3. Введите код из письма

---

## База данных:

Добавлены таблицы:
- `email_verifications` - хранит коды подтверждения
- Колонка `email_verified` в таблице `users`

---

## API Endpoints:

### POST /api/register
Создает аккаунт и отправляет код

**Request:**
```json
{
  "username": "player123",
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Verification code sent to your email",
  "email": "user@example.com",
  "code": "123456" // только если email не настроен
}
```

### POST /api/verify-email
Подтверждает email

**Request:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response:**
```json
{
  "ok": true,
  "token": "jwt-token",
  "subscription": { ... }
}
```

### POST /api/resend-code
Отправляет новый код

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "New code sent",
  "code": "654321" // только если email не настроен
}
```

---

## Готово! 🎉

Система подтверждения email настроена и готова к использованию.
