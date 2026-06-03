# Настройка Email для подтверждения регистрации

## Что добавлено:

✅ Система подтверждения email с 6-значным кодом
✅ Отправка кода на почту при регистрации
✅ Страница ввода кода `/verify-email`
✅ Повторная отправка кода
✅ Блокировка входа для неподтвержденных аккаунтов
✅ Поддержка Gmail, Mail.ru, Yandex и других SMTP

---

## 🚀 Быстрая настройка (Mail.ru - РЕКОМЕНДУЕТСЯ)

### Почему Mail.ru?
- ✅ Бесплатно
- ✅ Не требует App Password
- ✅ Работает сразу
- ✅ Поддержка русского языка

### Настройка Mail.ru:

1. **Создайте почту на Mail.ru** (если нет):
   - Перейдите на https://mail.ru
   - Зарегистрируйте новую почту (например: `Exclusive@mail.ru`)

2. **Включите SMTP в настройках:**
   - Войдите в почту
   - Настройки → Почтовые клиенты
   - Включите "Доступ по протоколу IMAP/POP3/SMTP"

3. **Добавьте на Vercel:**
   - Settings → Environment Variables
   - Добавьте:
   ```
   EMAIL_SERVICE=mail.ru
   EMAIL_USER=Exclusive@mail.ru
   EMAIL_PASS=ваш_пароль_от_почты
   EMAIL_FROM=Exclusive <Exclusive@mail.ru>
   ```
   - Нажмите **Save**
   - Сделайте **Redeploy**

4. **Готово!** Письма будут отправляться с вашей почты Mail.ru

---

## Альтернативные варианты:

### 1️⃣ Yandex Mail (Яндекс.Почта)

**Настройка:**
1. Создайте почту на https://mail.yandex.ru
2. Включите SMTP в настройках
3. Добавьте на Vercel:
   ```
   EMAIL_SERVICE=yandex
   EMAIL_USER=Exclusive@yandex.ru
   EMAIL_PASS=ваш_пароль
   EMAIL_FROM=Exclusive <Exclusive@yandex.ru>
   ```

---

### 2️⃣ Gmail (требует App Password)

**Настройка:**
1. Откройте https://myaccount.google.com/apppasswords
2. Включите 2FA (если еще не включено)
3. Создайте App Password для "Mail"
4. Скопируйте 16-символьный пароль
5. Добавьте на Vercel:
   ```
   EMAIL_SERVICE=gmail
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=app-password-16-chars
   EMAIL_FROM=Exclusive <noreply@Exclusive.com>
   ```

---

### 3️⃣ Mailgun (для больших объемов)

**Бесплатно до 5000 писем/месяц**

1. Зарегистрируйтесь на https://www.mailgun.com/
2. Получите SMTP credentials
3. Добавьте на Vercel:
   ```
   EMAIL_SERVICE=custom
   SMTP_HOST=smtp.mailgun.org
   SMTP_PORT=587
   SMTP_SECURE=false
   EMAIL_USER=postmaster@your-domain.mailgun.org
   EMAIL_PASS=your-mailgun-password
   EMAIL_FROM=Exclusive <noreply@your-domain.com>
   ```

---

### 4️⃣ SendGrid (для больших объемов)

**Бесплатно до 100 писем/день**

1. Зарегистрируйтесь на https://sendgrid.com/
2. Создайте API Key
3. Добавьте на Vercel:
   ```
   EMAIL_SERVICE=custom
   SMTP_HOST=smtp.sendgrid.net
   SMTP_PORT=587
   SMTP_SECURE=false
   EMAIL_USER=apikey
   EMAIL_PASS=your-sendgrid-api-key
   EMAIL_FROM=Exclusive <noreply@your-domain.com>
   ```

---

## Режим разработки (без email)

Если переменные `EMAIL_USER` и `EMAIL_PASS` не установлены:
- ✅ Код выводится в консоль сервера
- ✅ Код возвращается в ответе API
- ✅ Код показывается на странице регистрации
- ⚠️ **Не подходит для production!**

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
