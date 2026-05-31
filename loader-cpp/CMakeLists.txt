cmake_minimum_required(VERSION 3.20)
project(LuminarLoader VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Disable char8_t (u8 literals stay as char[])
add_compile_options(/Zc:char8_t- /utf-8)

# vcpkg integration (for curl)
# Install: vcpkg install curl:x64-windows-static
# Then pass -DCMAKE_TOOLCHAIN_FILE=[vcpkg root]/scripts/buildsystems/vcpkg.cmake

find_package(CURL REQUIRED)

# ImGui sources (download from github.com/ocornut/imgui)
set(IMGUI_DIR ${CMAKE_SOURCE_DIR}/libs/imgui)
set(IMGUI_SOURCES
    ${IMGUI_DIR}/imgui.cpp
    ${IMGUI_DIR}/imgui_draw.cpp
    ${IMGUI_DIR}/imgui_tables.cpp
    ${IMGUI_DIR}/imgui_widgets.cpp
    ${IMGUI_DIR}/imgui_demo.cpp
    ${IMGUI_DIR}/backends/imgui_impl_win32.cpp
    ${IMGUI_DIR}/backends/imgui_impl_dx11.cpp
)

add_executable(LuminarLoader WIN32
    src/main.cpp
    src/app.cpp
    src/auth.cpp
    src/hwid.cpp
    src/session.cpp
    src/downloader.cpp
    src/launcher.cpp
    src/config.cpp
    ${IMGUI_SOURCES}
)

target_include_directories(LuminarLoader PRIVATE
    ${IMGUI_DIR}
    ${IMGUI_DIR}/backends
    src
)

target_link_libraries(LuminarLoader PRIVATE
    CURL::libcurl
    d3d11
    dxgi
    d3dcompiler
    dwmapi
    iphlpapi
)

# Static runtime for portable exe
set_property(TARGET LuminarLoader PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
