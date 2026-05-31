#pragma execution_character_set("utf-8")
#include "app.h"
#include "auth.h"
#include "hwid.h"
#include "session.h"
#include "config.h"
#include "downloader.h"
#include "launcher.h"
#include "imgui.h"
#include <windows.h>
#include <thread>
#include <atomic>
#include <cstring>
#include <cstdlib>
#include <filesystem>

namespace App {

static State s_state = State::Login;
static UserInfo s_userInfo;
static Progress s_progress;
static HWND s_hwnd = nullptr;

void setHwnd(void* hwnd) { s_hwnd = (HWND)hwnd; }

// Login state
static char s_loginUser[128] = "";
static char s_loginPass[128] = "";
static char s_loginError[256] = "";
static bool s_loginBusy = false;

// Settings state
static int s_ramSlider = 2048;

void init() {
    Config::load();
    s_ramSlider = Config::get().ramMb;

    auto token = Session::loadToken();
    if (token.has_value() && !token->empty()) {
        s_state = State::Launch;
        // Verify in background
        std::thread([]() {
            auto token = Session::loadToken();
            if (!token) { s_state = State::Login; return; }
            auto result = Auth::verify(*token, Hwid::get());
            if (!result.ok) {
                Session::logout();
                s_state = State::Login;
                return;
            }
            auto name = Auth::field(result.body, "username");
            auto uid = Auth::field(result.body, "uid");
            auto role = Auth::field(result.body, "role");
            auto until = Auth::field(result.body, "until");
            auto daysLeft = Auth::field(result.body, "daysLeft");

            strncpy(s_userInfo.username, name.c_str(), sizeof(s_userInfo.username) - 1);

            // UID
            if (!uid.empty() && uid != "null") {
                s_userInfo.uid = std::atoi(uid.c_str());
            }

            // Role
            if (!role.empty() && role != "null") {
                strncpy(s_userInfo.role, role.c_str(), sizeof(s_userInfo.role) - 1);
            } else {
                strncpy(s_userInfo.role, u8"Пользователь", sizeof(s_userInfo.role) - 1);
            }

            // Subscription
            if (!until.empty() && until != "null" && until != "0") {
                if (!daysLeft.empty() && daysLeft != "null") {
                    snprintf(s_userInfo.subscription, sizeof(s_userInfo.subscription),
                             u8"Подписка (%s дн.)", daysLeft.c_str());
                } else {
                    snprintf(s_userInfo.subscription, sizeof(s_userInfo.subscription), u8"Подписка активна");
                }
            } else {
                snprintf(s_userInfo.subscription, sizeof(s_userInfo.subscription), u8"Нет подписки");
            }

            s_userInfo.verified = true;
        }).detach();
    }
}

State getState() { return s_state; }
void setState(State state) { s_state = state; }
UserInfo& userInfo() { return s_userInfo; }
Progress& progress() { return s_progress; }

static void renderTitlebar() {
    ImVec2 windowSize = ImGui::GetIO().DisplaySize;
    ImGui::SetCursorPos({windowSize.x - 38, 8});

    ImGui::PushStyleColor(ImGuiCol_Button, {0, 0, 0, 0});
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.3f, 0.3f, 0.3f, 0.5f});
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.2f, 0.2f, 0.2f, 0.5f});

    // Minimize
    if (ImGui::Button(u8"\u2014", {28, 22})) {
        ShowWindow(s_hwnd, SW_MINIMIZE);
    }
    ImGui::SameLine();
    // Close
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.8f, 0.2f, 0.2f, 0.8f});
    if (ImGui::Button(u8"\u2715", {28, 22})) {
        PostQuitMessage(0);
    }
    ImGui::PopStyleColor(4);
}

static void renderLogin() {
    ImVec2 windowSize = ImGui::GetIO().DisplaySize;
    float cardW = 400, cardH = 320;
    float x = (windowSize.x - cardW) / 2;
    float y = (windowSize.y - cardH) / 2;

    ImGui::SetNextWindowPos({x, y});
    ImGui::SetNextWindowSize({cardW, cardH});
    ImGui::Begin("##login", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove);

    // Title
    ImGui::SetCursorPosX((cardW - ImGui::CalcTextSize("Luminar").x) / 2);
    ImGui::TextColored({0.94f, 0.94f, 0.96f, 1.0f}, "Luminar");
    ImGui::Spacing(); ImGui::Spacing();

    ImGui::TextColored({0.6f, 0.6f, 0.6f, 1.0f}, u8"Юзернейм");
    ImGui::PushItemWidth(-1);
    ImGui::InputText("##user", s_loginUser, sizeof(s_loginUser));
    ImGui::PopItemWidth();

    ImGui::Spacing();
    ImGui::TextColored({0.6f, 0.6f, 0.6f, 1.0f}, u8"Пароль");
    ImGui::PushItemWidth(-1);
    ImGui::InputText("##pass", s_loginPass, sizeof(s_loginPass), ImGuiInputTextFlags_Password);
    ImGui::PopItemWidth();

    ImGui::Spacing(); ImGui::Spacing();

    if (s_loginError[0] != '\0') {
        ImGui::TextColored({0.91f, 0.25f, 0.25f, 1.0f}, "%s", s_loginError);
    }

    ImGui::Spacing();

    if (s_loginBusy) {
        ImGui::TextColored({0.5f, 0.5f, 0.5f, 1.0f}, u8"Подключение...");
    } else {
        ImGui::PushStyleColor(ImGuiCol_Button, {0.91f, 0.25f, 0.25f, 1.0f});
        ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.94f, 0.28f, 0.28f, 1.0f});
        ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.80f, 0.21f, 0.21f, 1.0f});
        if (ImGui::Button(u8"Войти", {-1, 40})) {
            if (strlen(s_loginUser) == 0 || strlen(s_loginPass) == 0) {
                strncpy(s_loginError, u8"Заполните все поля", sizeof(s_loginError));
            } else {
                s_loginBusy = true;
                s_loginError[0] = '\0';
                std::thread([]() {
                    auto result = Auth::login(s_loginUser, s_loginPass, Hwid::get());
                    s_loginBusy = false;
                    if (result.ok) {
                        auto token = Auth::field(result.body, "token");
                        if (!token.empty()) Session::saveToken(token);
                        s_state = State::Launch;
                        // Re-init launch view
                        init();
                    } else {
                        auto err = Auth::field(result.body, "error");
                        strncpy(s_loginError, err.empty() ? u8"Ошибка авторизации" : err.c_str(), sizeof(s_loginError));
                    }
                }).detach();
            }
        }
        ImGui::PopStyleColor(3);
    }

    ImGui::End();
}

static void renderLaunch() {
    ImVec2 ws = ImGui::GetIO().DisplaySize;
    float pad = 16.0f;
    float topY = 44.0f; // below titlebar

    // === LEFT PANEL: Changelog (bordered card) ===
    float leftW = ws.x * 0.38f;
    float panelH = ws.y - topY - pad;
    ImGui::SetNextWindowPos({pad, topY});
    ImGui::SetNextWindowSize({leftW, panelH});
    ImGui::PushStyleColor(ImGuiCol_WindowBg, {0.055f, 0.055f, 0.065f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_Border, {0.35f, 0.08f, 0.08f, 0.7f});
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 14.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 1.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {16.0f, 16.0f});
    ImGui::Begin("##changelog", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar);

    ImGui::TextColored({0.45f, 0.45f, 0.5f, 1.0f}, u8"ЧЕНДЖЛОГ КЛИЕНТА");
    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::TextColored({0.9f, 0.9f, 0.93f, 1.0f}, "1.16.5");
    ImGui::SameLine(leftW - 130);
    ImGui::TextColored({0.45f, 0.45f, 0.5f, 1.0f}, "2026-05-14");
    ImGui::Spacing();

    ImGui::PushStyleColor(ImGuiCol_Button, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::SmallButton(u8"ОБНОВЛЕНО");
    ImGui::PopStyleColor(3);
    ImGui::SameLine();
    ImGui::TextColored({0.8f, 0.8f, 0.83f, 1.0f}, u8"(+) Watermark");
    ImGui::Spacing();

    ImGui::PushStyleColor(ImGuiCol_Button, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.12f, 0.28f, 0.12f, 1.0f});
    ImGui::SmallButton(u8"ОБНОВЛЕНО");
    ImGui::PopStyleColor(3);
    ImGui::SameLine();
    ImGui::TextColored({0.8f, 0.8f, 0.83f, 1.0f}, u8"(+) C++ Loader");

    ImGui::End();
    ImGui::PopStyleVar(3);
    ImGui::PopStyleColor(2);

    // === RIGHT PANEL (bordered card) ===
    float rightX = pad + leftW + pad;
    float rightW = ws.x - rightX - pad;
    ImGui::SetNextWindowPos({rightX, topY});
    ImGui::SetNextWindowSize({rightW, panelH});
    ImGui::PushStyleColor(ImGuiCol_WindowBg, {0.055f, 0.055f, 0.065f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_Border, {0.35f, 0.08f, 0.08f, 0.7f});
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 14.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 1.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {20.0f, 16.0f});
    ImGui::Begin("##rightpanel", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar);

    // Title "Luminar" centered
    float titleW = ImGui::CalcTextSize("Luminar").x;
    ImGui::SetCursorPosX((rightW - titleW) / 2 - 20);
    ImGui::TextColored({0.88f, 0.88f, 0.92f, 1.0f}, "Luminar");
    ImGui::Spacing();

    // Preview card (dark gradient box)
    float cardInnerW = rightW - 60;
    ImGui::SetCursorPosX(10);
    ImGui::PushStyleColor(ImGuiCol_ChildBg, {0.04f, 0.03f, 0.06f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_Border, {0.22f, 0.22f, 0.28f, 0.6f});
    ImGui::PushStyleVar(ImGuiStyleVar_ChildRounding, 10.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_ChildBorderSize, 1.0f);
    ImGui::BeginChild("##preview", {cardInnerW, 150}, true);
    ImGui::EndChild();
    ImGui::PopStyleVar(2);
    ImGui::PopStyleColor(2);

    ImGui::Spacing();

    // Version label centered
    ImGui::SetCursorPosX((rightW - 40 - 140) / 2);
    ImGui::TextColored({0.45f, 0.45f, 0.5f, 1.0f}, u8"ВЕРСИЯ КЛИЕНТА");
    ImGui::SetCursorPosX((rightW - 40 - 160) / 2);
    ImGui::PushItemWidth(160);
    static int verIdx = 0;
    static const char* versions[] = {"1.16.5"};
    ImGui::Combo("##ver", &verIdx, versions, 1);
    ImGui::PopItemWidth();

    // Push to bottom
    float remaining = ImGui::GetContentRegionAvail().y - 115;
    if (remaining > 0) ImGui::Dummy({0, remaining});

    // User card
    ImGui::PushStyleColor(ImGuiCol_ChildBg, {0.065f, 0.065f, 0.075f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_Border, {0.18f, 0.18f, 0.22f, 1.0f});
    ImGui::PushStyleVar(ImGuiStyleVar_ChildRounding, 10.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_ChildBorderSize, 1.0f);
    ImGui::BeginChild("##usercard", {-1, 44}, true);

    // Avatar circle
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 ucPos = ImGui::GetWindowPos();
    dl->AddCircleFilled({ucPos.x + 26, ucPos.y + 22}, 14.0f, IM_COL32(60, 50, 45, 255));
    dl->AddCircleFilled({ucPos.x + 26, ucPos.y + 22}, 12.0f, IM_COL32(80, 65, 55, 255));

    ImGui::SetCursorPos({46, 6});
    if (s_userInfo.verified) {
        // Показываем имя + UID
        if (s_userInfo.uid > 0) {
            ImGui::TextColored({0.9f, 0.9f, 0.93f, 1.0f}, "%s (UID: %d)", s_userInfo.username, s_userInfo.uid);
        } else {
            ImGui::TextColored({0.9f, 0.9f, 0.93f, 1.0f}, "%s", s_userInfo.username);
        }
        ImGui::SetCursorPos({46, 24});
        // Показываем роль + подписку
        ImGui::TextColored({0.45f, 0.45f, 0.5f, 1.0f}, "%s | %s", s_userInfo.role, s_userInfo.subscription);
    } else {
        ImGui::TextColored({0.5f, 0.5f, 0.5f, 1.0f}, u8"Проверка...");
    }

    // Settings & logout on right
    float cardW = ImGui::GetWindowWidth();
    ImGui::SetCursorPos({cardW - 70, 10});
    ImGui::PushStyleColor(ImGuiCol_Button, {0.12f, 0.12f, 0.14f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.2f, 0.2f, 0.25f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.15f, 0.15f, 0.18f, 1.0f});
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 6.0f);
    if (ImGui::Button(u8"\u2699##set", {26, 26})) s_state = State::Settings;
    ImGui::SameLine();
    if (ImGui::Button(u8"\u2192##out", {26, 26})) { Session::logout(); s_state = State::Login; }
    ImGui::PopStyleVar();
    ImGui::PopStyleColor(3);

    ImGui::EndChild();
    ImGui::PopStyleVar(2);
    ImGui::PopStyleColor(2);

    ImGui::Spacing();

    // Progress
    if (s_progress.visible) {
        ImGui::ProgressBar(s_progress.value, {-1, 3});
        ImGui::TextColored({0.5f, 0.5f, 0.5f, 1.0f}, "%s", s_progress.status);
        ImGui::Spacing();
    }

    // Play button
    bool canPlay = s_userInfo.verified && !s_progress.launching;
    if (!canPlay) ImGui::BeginDisabled();

    ImGui::PushStyleColor(ImGuiCol_Button, {0.82f, 0.20f, 0.20f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, {0.88f, 0.25f, 0.25f, 1.0f});
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, {0.72f, 0.16f, 0.16f, 1.0f});
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 14.0f);
    if (ImGui::Button(u8"\u25B6 Запустить клиент", {-1, 50})) {
        s_progress.launching = true;
        s_progress.visible = true;
        snprintf(s_progress.status, sizeof(s_progress.status), u8"Подготовка...");

        std::thread([]() {
            auto ensureFile = [](const std::filesystem::path& path, const std::string& url, const char* label) -> bool {
                if (std::filesystem::exists(path) && std::filesystem::file_size(path) > 1024) {
                    snprintf(s_progress.status, sizeof(s_progress.status), "%s готов", label);
                    return true;
                }
                snprintf(s_progress.status, sizeof(s_progress.status), u8"Скачивание %s...", label);
                s_progress.value = 0;
                return Downloader::download(url, path, [](int64_t read, int64_t total) {
                    if (total > 0) s_progress.value = (float)read / (float)total;
                });
            };

            if (!ensureFile(Config::minecraftJar(), Config::MINECRAFT_JAR_URL, "Minecraft")) {
                snprintf(s_progress.status, sizeof(s_progress.status), u8"Ошибка скачивания Minecraft");
                s_progress.launching = false;
                return;
            }
            if (!ensureFile(Config::clientJar(), Config::CLIENT_JAR_URL, "Luminar")) {
                snprintf(s_progress.status, sizeof(s_progress.status), u8"Ошибка скачивания Luminar");
                s_progress.launching = false;
                return;
            }

            snprintf(s_progress.status, sizeof(s_progress.status), u8"Запуск...");
            if (Launcher::launch()) {
                Sleep(1500);
                PostQuitMessage(0);
            } else {
                snprintf(s_progress.status, sizeof(s_progress.status), u8"Ошибка запуска");
                s_progress.launching = false;
            }
        }).detach();
    }
    ImGui::PopStyleVar();
    ImGui::PopStyleColor(3);

    if (!canPlay) ImGui::EndDisabled();

    ImGui::End();
    ImGui::PopStyleVar(3);
    ImGui::PopStyleColor(2);
}

static void renderSettings() {
    ImVec2 windowSize = ImGui::GetIO().DisplaySize;

    ImGui::SetNextWindowPos({0, 0});
    ImGui::SetNextWindowSize(windowSize);
    ImGui::Begin("##settings", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBackground);

    ImGui::TextColored({0.94f, 0.94f, 0.96f, 1.0f}, u8"НАСТРОЙКИ");
    ImGui::SameLine(windowSize.x - 80);
    if (ImGui::SmallButton(u8"Назад")) s_state = State::Launch;

    ImGui::Separator();
    ImGui::Spacing(); ImGui::Spacing();

    // RAM
    ImGui::TextColored({0.9f, 0.9f, 0.93f, 1.0f}, u8"Оперативная память");
    ImGui::TextColored({0.5f, 0.5f, 0.5f, 1.0f}, u8"Выделите RAM для Minecraft");
    ImGui::Spacing();

    ImGui::SliderInt("##ram", &s_ramSlider, 512, 8192, "%d MB");
    s_ramSlider = (s_ramSlider / 256) * 256;
    if (s_ramSlider != Config::get().ramMb) {
        Config::get().ramMb = s_ramSlider;
        Config::save();
    }

    ImGui::Spacing(); ImGui::Separator(); ImGui::Spacing();

    // Resolution
    ImGui::TextColored({0.9f, 0.9f, 0.93f, 1.0f}, u8"Разрешение окна");
    static const char* resolutions[] = {"854x480", "1280x720", "1366x768", "1600x900", "1920x1080"};
    static int currentRes = 0;
    if (ImGui::Combo("##res", &currentRes, resolutions, 5)) {
        int w, h;
        sscanf(resolutions[currentRes], "%dx%d", &w, &h);
        Config::get().windowWidth = w;
        Config::get().windowHeight = h;
        Config::save();
    }

    ImGui::Spacing();

    bool fs = Config::get().fullscreen;
    if (ImGui::Checkbox(u8"Полноэкранный режим", &fs)) {
        Config::get().fullscreen = fs;
        Config::save();
    }

    ImGui::End();
}

void render() {
    // Fullscreen invisible window for titlebar buttons
    ImVec2 displaySize = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos({0, 0});
    ImGui::SetNextWindowSize(displaySize);
    ImGui::Begin("##titlebar", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoBringToFrontOnFocus);
    renderTitlebar();
    ImGui::End();

    switch (s_state) {
        case State::Login:    renderLogin(); break;
        case State::Launch:   renderLaunch(); break;
        case State::Settings: renderSettings(); break;
    }
}

} // namespace App
