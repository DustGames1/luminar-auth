# 📋 Инструкция: Как обновить версию клиента через админ панель

## 🎯 Цель
Когда вы выпускаете новое обновление клиента, нужно изменить версию на сервере. После этого все пользователи при запуске лоадера автоматически скачают обновление.

---

## 🔧 Шаги:

### 1. Подготовка нового клиента
1. Загрузите новый `client.zip` на GitHub Releases
2. URL должен быть: `https://github.com/DustGames1/luminar-auth/releases/download/luminar/client.zip`

### 2. Установка новой версии через админ панель

#### Вариант A: Через веб-интерфейс (если добавлен в админ панель)
1. Откройте: `https://luminar-five-drab.vercel.app/admin`
2. Введите ADMIN_KEY
3. Найдите раздел "Client Version"
4. Измените версию (например: `1.0.0` → `1.1.0`)
5. Нажмите "Save"

#### Вариант B: Через API напрямую
```bash
# С помощью curl (замените YOUR_ADMIN_KEY на ваш ключ)
curl -X POST https://luminar-five-drab.vercel.app/api/admin/version \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"version": "1.1.0"}'
```

#### Вариант C: Через PowerShell
```powershell
$headers = @{
    "Content-Type" = "application/json"
    "x-admin-key" = "YOUR_ADMIN_KEY"
}
$body = @{
    version = "1.1.0"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://luminar-five-drab.vercel.app/api/admin/version" `
    -Method POST `
    -Headers $headers `
    -Body $body
```

### 3. Проверка
Проверьте что версия обновилась:
```bash
curl https://luminar-five-drab.vercel.app/api/client-version
# Должно вернуть: 1.1.0
```

---

## 🚀 Что происходит после обновления версии:

1. **Пользователь запускает LuminarLoader.exe**
2. **Лоадер проверяет**: `/api/client-version` возвращает `1.1.0`
3. **Сравнивает** с локальной версией в `C:\Luminar\version.txt` (например `1.0.0`)
4. **Видит что версии разные** → начинает обновление
5. **Скачивает** `client.zip` с GitHub
6. **Распаковывает во временную папку** `C:\Luminar\temp_update`
7. **Обновляет ТОЛЬКО**:
   - ✅ `jar\client.jar`
   - ✅ `game\libraries\*.jar`
   - ✅ `game\natives\*.dll`
8. **НЕ ТРОГАЕТ**:
   - ✅ `game\resourcepacks\` (все паки остаются)
   - ✅ `game\config\` (все конфиги остаются)
   - ✅ `game\options.txt` (настройки остаются)
   - ✅ `game\saves\` (сохранения остаются)
9. **Записывает новую версию** в `version.txt`: `1.1.0`
10. **Запускает игру** с новой версией

---

## 📦 Структура client.zip

Убедитесь что ваш `client.zip` имеет правильную структуру:

```
client.zip
├── jar/
│   └── client.jar           ← Обновленный jar
├── java/                    ← Java runtime (если нужен)
│   └── bin/javaw.exe
└── game/
    ├── libraries/           ← Библиотеки
    │   ├── lib1.jar
    │   └── lib2.jar
    ├── natives/             ← Нативные библиотеки
    │   ├── native1.dll
    │   └── native2.dll
    └── versions/            ← Версии Minecraft (если нужны)
        └── 1.16.5/
```

**Важно**: НЕ включайте в `client.zip`:
- ❌ `resourcepacks/` (пользовательские паки)
- ❌ `config/` (пользовательские конфиги)
- ❌ `options.txt` (настройки пользователя)
- ❌ `saves/` (миры пользователя)

---

## 🔍 Отладка

### Проверить текущую версию на сервере:
```bash
curl https://luminar-five-drab.vercel.app/api/client-version
```

### Проверить версию в базе данных (PostgreSQL):
```sql
SELECT * FROM settings WHERE key = 'client_version';
```

### Установить версию вручную в базе:
```sql
INSERT INTO settings (key, value) VALUES ('client_version', '1.1.0')
ON CONFLICT (key) DO UPDATE SET value = '1.1.0';
```

---

## ⚠️ Важные примечания:

1. **Номер версии** должен быть уникальным для каждого обновления
2. **Формат версии**: Рекомендуется `X.Y.Z` (например: `1.0.0`, `1.1.0`, `2.0.0`)
3. **client.zip** должен быть доступен по URL до изменения версии
4. **Проверьте** что client.zip правильно упакован и содержит все нужные файлы
5. **Не изменяйте версию** пока client.zip не загружен на GitHub

---

## ✅ Чеклист перед обновлением:

- [ ] Новый `client.jar` готов и протестирован
- [ ] Создан `client.zip` с правильной структурой
- [ ] `client.zip` загружен на GitHub Releases: `https://github.com/DustGames1/luminar-auth/releases/download/luminar/client.zip`
- [ ] Проверен доступ к client.zip (можно скачать по URL)
- [ ] Выбран новый номер версии (например: `1.1.0`)
- [ ] Обновлена версия через API или админ панель
- [ ] Проверено что `/api/client-version` возвращает новую версию
- [ ] Протестирован лоадер на тестовом аккаунте

---

## 🎉 Готово!

После выполнения всех шагов, все пользователи при следующем запуске лоадера автоматически получат обновление **без потери** своих ресурспаков, конфигов и настроек игры!

---

*Последнее обновление: 2 июня 2026*
