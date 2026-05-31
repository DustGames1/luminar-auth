#include "imgui.h"
#include "imgui_impl_win32.h"
#include "imgui_impl_dx11.h"
#include "app.h"
#include <d3d11.h>
#include <dwmapi.h>
#include <windows.h>
#include <curl/curl.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dwmapi.lib")

// DirectX globals
static ID3D11Device*            g_pd3dDevice = nullptr;
static ID3D11DeviceContext*     g_pd3dDeviceContext = nullptr;
static IDXGISwapChain*          g_pSwapChain = nullptr;
static ID3D11RenderTargetView*  g_mainRenderTargetView = nullptr;

// Forward declarations
static bool CreateDeviceD3D(HWND hWnd);
static void CleanupDeviceD3D();
static void CreateRenderTarget();
static void CleanupRenderTarget();
extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

static LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam))
        return true;

    switch (msg) {
    case WM_SIZE:
        if (g_pd3dDevice && wParam != SIZE_MINIMIZED) {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, (UINT)LOWORD(lParam), (UINT)HIWORD(lParam), DXGI_FORMAT_UNKNOWN, 0);
            CreateRenderTarget();
        }
        return 0;
    case WM_NCHITTEST: {
        // Allow dragging the window from anywhere
        LRESULT hit = DefWindowProc(hWnd, msg, wParam, lParam);
        if (hit == HTCLIENT) {
            POINT pt = {LOWORD(lParam), HIWORD(lParam)};
            ScreenToClient(hWnd, &pt);
            if (pt.y < 30) return HTCAPTION; // Top 30px = drag area
        }
        return hit;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProc(hWnd, msg, wParam, lParam);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int) {
    // Init curl globally
    curl_global_init(CURL_GLOBAL_ALL);

    // Create window
    WNDCLASSEXW wc = {sizeof(wc), CS_CLASSDC, WndProc, 0, 0, hInstance, nullptr, nullptr, nullptr, nullptr, L"LuminarLoader", nullptr};
    RegisterClassExW(&wc);

    int winW = 900, winH = 550;
    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);

    HWND hwnd = CreateWindowExW(
        WS_EX_TOPMOST,
        wc.lpszClassName, L"Luminar",
        WS_POPUP,
        (screenW - winW) / 2, (screenH - winH) / 2,
        winW, winH,
        nullptr, nullptr, hInstance, nullptr
    );

    // Rounded corners (Windows 11)
    DWM_WINDOW_CORNER_PREFERENCE pref = DWMWCP_ROUND;
    DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &pref, sizeof(pref));

    if (!CreateDeviceD3D(hwnd)) {
        CleanupDeviceD3D();
        UnregisterClassW(wc.lpszClassName, hInstance);
        return 1;
    }

    ShowWindow(hwnd, SW_SHOWDEFAULT);
    UpdateWindow(hwnd);

    // Setup ImGui
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr; // No imgui.ini

    // Dark theme
    ImGui::StyleColorsDark();
    ImGuiStyle& style = ImGui::GetStyle();
    style.WindowRounding = 20.0f;
    style.FrameRounding = 10.0f;
    style.GrabRounding = 6.0f;
    style.WindowBorderSize = 1.0f;
    style.FrameBorderSize = 0.0f;
    style.WindowPadding = {20, 20};
    style.FramePadding = {12, 8};
    style.ItemSpacing = {8, 6};

    // Colors — dark with red accent
    ImVec4* colors = style.Colors;
    colors[ImGuiCol_WindowBg]       = {0.05f, 0.05f, 0.06f, 1.0f};
    colors[ImGuiCol_Border]         = {0.16f, 0.16f, 0.19f, 1.0f};
    colors[ImGuiCol_FrameBg]        = {0.12f, 0.12f, 0.14f, 1.0f};
    colors[ImGuiCol_FrameBgHovered] = {0.16f, 0.16f, 0.19f, 1.0f};
    colors[ImGuiCol_FrameBgActive]  = {0.20f, 0.20f, 0.23f, 1.0f};
    colors[ImGuiCol_SliderGrab]     = {0.91f, 0.25f, 0.25f, 1.0f};
    colors[ImGuiCol_SliderGrabActive] = {0.95f, 0.30f, 0.30f, 1.0f};
    colors[ImGuiCol_CheckMark]      = {0.91f, 0.25f, 0.25f, 1.0f};
    colors[ImGuiCol_Header]         = {0.15f, 0.15f, 0.17f, 1.0f};
    colors[ImGuiCol_HeaderHovered]  = {0.20f, 0.20f, 0.23f, 1.0f};
    colors[ImGuiCol_Separator]      = {0.16f, 0.16f, 0.19f, 1.0f};
    colors[ImGuiCol_Text]           = {0.88f, 0.88f, 0.90f, 1.0f};

    ImGui_ImplWin32_Init(hwnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    // Load font with Cyrillic glyphs
    ImFontConfig fontCfg;
    fontCfg.OversampleH = 2;
    fontCfg.OversampleV = 1;
    io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16.0f, &fontCfg, io.Fonts->GetGlyphRangesCyrillic());

    // Init app logic
    App::setHwnd(hwnd);
    App::init();

    // Main loop
    MSG msg;
    ZeroMemory(&msg, sizeof(msg));
    float clearColor[4] = {0.04f, 0.04f, 0.05f, 1.0f};

    while (msg.message != WM_QUIT) {
        if (PeekMessage(&msg, nullptr, 0U, 0U, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessage(&msg);
            continue;
        }

        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        App::render();

        ImGui::Render();
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clearColor);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());

        g_pSwapChain->Present(1, 0); // VSync
    }

    // Cleanup
    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    CleanupDeviceD3D();
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, hInstance);
    curl_global_cleanup();

    return 0;
}

static bool CreateDeviceD3D(HWND hWnd) {
    DXGI_SWAP_CHAIN_DESC sd = {};
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 0;
    sd.BufferDesc.Height = 0;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60;
    sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hWnd;
    sd.SampleDesc.Count = 1;
    sd.SampleDesc.Quality = 0;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL featureLevelArray[] = {D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};
    HRESULT res = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        featureLevelArray, 2, D3D11_SDK_VERSION,
        &sd, &g_pSwapChain, &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext
    );
    if (res != S_OK) return false;

    CreateRenderTarget();
    return true;
}

static void CleanupDeviceD3D() {
    CleanupRenderTarget();
    if (g_pSwapChain) { g_pSwapChain->Release(); g_pSwapChain = nullptr; }
    if (g_pd3dDeviceContext) { g_pd3dDeviceContext->Release(); g_pd3dDeviceContext = nullptr; }
    if (g_pd3dDevice) { g_pd3dDevice->Release(); g_pd3dDevice = nullptr; }
}

static void CreateRenderTarget() {
    ID3D11Texture2D* pBackBuffer;
    g_pSwapChain->GetBuffer(0, IID_PPV_ARGS(&pBackBuffer));
    g_pd3dDevice->CreateRenderTargetView(pBackBuffer, nullptr, &g_mainRenderTargetView);
    pBackBuffer->Release();
}

static void CleanupRenderTarget() {
    if (g_mainRenderTargetView) { g_mainRenderTargetView->Release(); g_mainRenderTargetView = nullptr; }
}
