# API для загрузки ключа шифрования

Добавьте эти эндпоинты в `server.js` для безопасной передачи ключа расшифровки.

## Новые эндпоинты

### 1. GET /api/encryption-key

Возвращает ключ расшифровки для авторизованного пользователя с активной подпиской.

```javascript
// В начале файла после других констант
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'YOUR_KEY_FROM_encryption-key.txt';

// Добавьте этот эндпоинт
app.get('/api/encryption-key', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [payload.username]);
    const user = result.rows[0];
    
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Banned' });
    
    const sub = getSubscription(user);
    if (!sub.active) return res.status(403).json({ error: 'No active subscription' });
    
    // Проверяем HWID
    const hwid = req.headers['x-hwid'];
    if (!hwid || hwid !== user.hwid) {
      return res.status(403).json({ error: 'HWID mismatch' });
    }
    
    // Логируем запрос ключа
    console.log(`[Key Request] User: ${user.username}, HWID: ${hwid}`);
    
    // Возвращаем ключ
    res.json({ key: ENCRYPTION_KEY });
    
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});
```

### 2. POST /api/security/report

Принимает отчёты о попытках взлома.

```javascript
app.post('/api/security/report', async (req, res) => {
  try {
    const { hwid, violation } = req.body;
    
    if (!hwid || !violation) {
      return res.status(400).json({ error: 'Missing data' });
    }
    
    // Логируем нарушение
    console.error(`[SECURITY VIOLATION] HWID: ${hwid}, Details: ${violation}`);
    
    // Сохраняем в базу
    await pool.query(
      'INSERT INTO security_violations (hwid, violation, timestamp) VALUES ($1, $2, NOW())',
      [hwid, violation]
    );
    
    // Можно автоматически банить при повторных нарушениях
    const violations = await pool.query(
      'SELECT COUNT(*) FROM security_violations WHERE hwid = $1 AND timestamp > NOW() - INTERVAL \'1 day\'',
      [hwid]
    );
    
    if (parseInt(violations.rows[0].count) >= 5) {
      // 5+ нарушений за день = автобан
      await pool.query(
        'UPDATE users SET banned = true WHERE hwid = $1',
        [hwid]
      );
      console.error(`[AUTO-BAN] HWID ${hwid} banned for repeated violations`);
    }
    
    res.json({ ok: true });
    
  } catch (e) {
    console.error('Security report error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});
```

### 3. Миграция базы данных

Создайте таблицу для логов нарушений:

```sql
CREATE TABLE IF NOT EXISTS security_violations (
  id SERIAL PRIMARY KEY,
  hwid TEXT NOT NULL,
  violation TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_violations_hwid ON security_violations(hwid);
CREATE INDEX idx_violations_timestamp ON security_violations(timestamp);
```

Добавьте в функцию инициализации БД в `server.js`:

```javascript
async function initDatabase() {
  try {
    // ... существующие таблицы ...
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_violations (
        id SERIAL PRIMARY KEY,
        hwid TEXT NOT NULL,
        violation TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_violations_hwid 
      ON security_violations(hwid)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_violations_timestamp 
      ON security_violations(timestamp)
    `);
    
    console.log('[DB] Security violations table ready');
    
  } catch (e) {
    console.error('DB init error:', e);
  }
}
```

## Настройка .env

Добавьте в `.env`:

```env
# Ключ шифрования клиента (из encryption-key.txt)
ENCRYPTION_KEY=ваш_ключ_base64_здесь
```

**ВАЖНО:** Никогда не коммитьте `.env` в репозиторий!

## Интеграция в лоудер

Обновите `AuthApi.java`:

```java
/**
 * Получает ключ расшифровки клиента с сервера
 */
public static String getDecryptionKey(String token) {
    try {
        String hwid = HwidUtil.get();
        
        HttpRequest req = HttpRequest.newBuilder()
            .uri(URI.create(BASE_URL + "/api/encryption-key"))
            .header("Authorization", "Bearer " + token)
            .header("X-HWID", hwid)
            .GET()
            .build();
            
        HttpResponse<String> resp = HttpClient.newHttpClient()
            .send(req, HttpResponse.BodyHandlers.ofString());
            
        if (resp.statusCode() != 200) {
            throw new SecurityException("Failed to get key: " + resp.statusCode());
        }
        
        String body = resp.body();
        return field(body, "key");
        
    } catch (Exception e) {
        throw new SecurityException("Key request failed: " + e.getMessage());
    }
}

/**
 * Отправляет отчёт о нарушении безопасности
 */
public static void reportViolation(String hwid, String violation) {
    try {
        String json = String.format("{\"hwid\":\"%s\",\"violation\":\"%s\"}", 
            hwid, violation.replace("\"", "\\\""));
            
        HttpRequest req = HttpRequest.newBuilder()
            .uri(URI.create(BASE_URL + "/api/security/report"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(json))
            .build();
            
        HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString());
        
    } catch (Exception e) {
        // Игнорируем ошибки отправки
    }
}
```

## Использование в LaunchView

Обновите `LaunchView.java`:

```java
private void startLaunch() {
    playBtn.setDisable(true);
    progress.setVisible(true);
    progress.setProgress(-1);
    statusLabel.setText("Подготовка...");

    new Thread(() -> {
        try {
            ensure(LaunchConfig.minecraftJar(), LaunchConfig.MINECRAFT_JAR_URL, "Minecraft");
            ensure(LaunchConfig.clientJar(), LaunchConfig.CLIENT_JAR_URL, "Exclusive");
            
            // Загружаем ключ с сервера
            Platform.runLater(() -> statusLabel.setText("Проверка безопасности..."));
            String token = Session.loadToken();
            String encryptionKey = AuthApi.getDecryptionKey(token);
            
            if (encryptionKey == null || encryptionKey.isEmpty()) {
                throw new SecurityException("Failed to obtain decryption key");
            }
            
            // Устанавливаем ключ
            ProtectedGameLauncher.setEncryptionKey(encryptionKey);
            
            Platform.runLater(() -> statusLabel.setText("Запуск..."));
            
            // Используем защищённый лаунчер
            Process p = ProtectedGameLauncher.launch();
            
            Thread.sleep(1500);
            if (!p.isAlive()) throw new RuntimeException("Код " + p.exitValue());
            Platform.runLater(() -> System.exit(0));
            
        } catch (SecurityException ex) {
            Platform.runLater(() -> {
                progress.setVisible(false);
                statusLabel.setText("Ошибка безопасности: " + ex.getMessage());
                playBtn.setDisable(false);
            });
        } catch (Exception ex) {
            Platform.runLater(() -> {
                progress.setVisible(false);
                statusLabel.setText("Ошибка: " + ex.getMessage());
                playBtn.setDisable(false);
            });
        }
    }).start();
}
```

## Безопасность

### Дополнительная защита ключа

1. **Ротация ключей**: Периодически меняйте ключ шифрования
2. **Rate limiting**: Ограничьте количество запросов ключа (например, 10/час на пользователя)
3. **IP validation**: Проверяйте подозрительные IP
4. **Версионирование**: Разные ключи для разных версий клиента

Пример rate limiting:

```javascript
const keyRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 10, // максимум 10 запросов
  message: { error: 'Too many key requests' }
});

app.get('/api/encryption-key', keyRequestLimiter, async (req, res) => {
  // ... код эндпоинта ...
});
```

## Мониторинг

Добавьте админ-панель для просмотра нарушений:

```javascript
app.get('/api/admin/violations', authenticateAdmin, async (req, res) => {
  const violations = await pool.query(`
    SELECT v.*, u.username 
    FROM security_violations v
    LEFT JOIN users u ON v.hwid = u.hwid
    ORDER BY v.timestamp DESC
    LIMIT 100
  `);
  
  res.json({ violations: violations.rows });
});
```

Это позволит отслеживать попытки взлома в реальном времени.
