# Luminar Loader (C++ / Dear ImGui + DirectX11)

## Подробный гайд по сборке (пошагово)

---

### Шаг 1: Установи Visual Studio 2022

Если ещё нет — скачай **Visual Studio 2022 Community** (бесплатная):
https://visualstudio.microsoft.com/downloads/

При установке выбери:
- **"Разработка классических приложений на C++"**

Это установит компилятор MSVC, Windows SDK, CMake.

---

### Шаг 2: Установи vcpkg (менеджер пакетов для C++)

Открой **PowerShell** (от администратора не обязательно) и выполни:

```powershell
cd C:\
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat
```

Теперь vcpkg установлен в `C:\vcpkg`.

---

### Шаг 3: Установи curl через vcpkg

```powershell
C:\vcpkg\vcpkg install curl:x64-windows-static
```

Подожди пока скачает и скомпилирует (2-5 минут).

---

### Шаг 4: Скачай Dear ImGui

```powershell
cd C:\Users\DustGames\Desktop\excellent\loader-cpp
git clone https://github.com/ocornut/imgui.git libs/imgui
```

Это скачает ImGui прямо в папку `libs/imgui/` проекта.

---

### Шаг 5: Собери проект

```powershell
cd C:\Users\DustGames\Desktop\excellent\loader-cpp
mkdir build
cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static
cmake --build . --config Release
```

---

### Шаг 6: Забери exe

Готовый файл будет тут:
```
C:\Users\DustGames\Desktop\excellent\loader-cpp\build\Release\LuminarLoader.exe
```

Это один .exe файл, без зависимостей. Можно раздавать пользователям.

---

## Если что-то не работает

### "cmake не найден"
Открой **Developer PowerShell for VS 2022** (ищи в меню Пуск) — там cmake уже в PATH.

### "git не найден"
Скачай Git: https://git-scm.com/download/win

### "curl не найден при cmake"
Убедись что путь к vcpkg правильный:
```
-DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
```

### Ошибки компиляции ImGui
Убедись что `libs/imgui/` содержит файлы:
- `imgui.cpp`, `imgui.h`
- `imgui_draw.cpp`, `imgui_tables.cpp`, `imgui_widgets.cpp`
- `backends/imgui_impl_win32.cpp`, `backends/imgui_impl_win32.h`
- `backends/imgui_impl_dx11.cpp`, `backends/imgui_impl_dx11.h`

---

## Структура проекта

```
loader-cpp/
├── CMakeLists.txt          ← Конфигурация сборки
├── README.md               ← Этот файл
├── libs/
│   └── imgui/              ← Dear ImGui (git clone)
│       ├── imgui.cpp/h
│       ├── imgui_draw.cpp
│       ├── imgui_tables.cpp
│       ├── imgui_widgets.cpp
│       └── backends/
│           ├── imgui_impl_win32.cpp/h
│           └── imgui_impl_dx11.cpp/h
└── src/
    ├── main.cpp            ← WinMain, DirectX11, ImGui рендер-луп
    ├── app.cpp/h           ← UI: логин, запуск, настройки
    ├── auth.cpp/h          ← HTTP авторизация через curl
    ├── hwid.cpp/h          ← HWID (совместим с Java версией)
    ├── session.cpp/h       ← Токен сессии (XOR-шифрование)
    ├── downloader.cpp/h    ← Скачивание файлов с прогрессом
    ├── launcher.cpp/h      ← Запуск Minecraft (CreateProcess)
    └── config.cpp/h        ← Настройки (RAM, разрешение)
```

## Функционал
- Авторизация через API (login/verify) — тот же бэкенд что и Java лоадер
- HWID привязка (полностью совместима с Java версией)
- Скачивание client.jar и minecraft.jar с прогресс-баром
- Запуск Minecraft с настраиваемой RAM/разрешением
- Сохранение сессии (XOR, тот же ключ и формат что в Java)
- Тёмная тема с красным акцентом (как в Java версии)
- Borderless окно с перетаскиванием за верхнюю часть
- Закруглённые углы (Windows 11)
- Один .exe без зависимостей
