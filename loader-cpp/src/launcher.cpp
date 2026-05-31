#include "launcher.h"
#include "config.h"
#include <windows.h>
#include <sstream>
#include <filesystem>

namespace Launcher {

std::string findJava() {
    // Try JAVA_HOME
    char javaHome[MAX_PATH] = {};
    if (GetEnvironmentVariableA("JAVA_HOME", javaHome, MAX_PATH) > 0) {
        std::string exe = std::string(javaHome) + "\\bin\\javaw.exe";
        if (std::filesystem::exists(exe)) return exe;
    }

    // Try common JDK paths
    char userHome[MAX_PATH] = {};
    GetEnvironmentVariableA("USERPROFILE", userHome, MAX_PATH);

    // Check .jdks folder (IntelliJ style)
    for (auto& entry : std::filesystem::directory_iterator(std::string(userHome) + "\\.jdks")) {
        if (entry.is_directory()) {
            auto exe = entry.path() / "bin" / "javaw.exe";
            if (std::filesystem::exists(exe)) return exe.string();
        }
    }

    // Fallback
    return "javaw.exe";
}

bool launch() {
    auto& cfg = Config::get();
    std::string java = findJava();
    std::string clientJar = Config::clientJar().string();
    std::string mcJar = Config::minecraftJar().string();
    std::string workDir = Config::workDir().string();

    std::ostringstream cmd;
    cmd << "\"" << java << "\"";
    cmd << " -Xmx" << cfg.ramMb << "M";
    cmd << " -Xms512M";
    cmd << " -XX:+UnlockExperimentalVMOptions";
    cmd << " -XX:+UseG1GC";
    cmd << " -Dfile.encoding=UTF-8";
    cmd << " -cp \"" << clientJar << ";" << mcJar << "\"";
    cmd << " net.minecraft.client.main.Main";
    cmd << " --username " << "Player";
    cmd << " --version 1.16.5";
    cmd << " --gameDir \"" << workDir << "\"";
    cmd << " --accessToken 0";

    if (cfg.fullscreen) cmd << " --fullscreen";
    cmd << " --width " << cfg.windowWidth;
    cmd << " --height " << cfg.windowHeight;

    std::string cmdStr = cmd.str();

    STARTUPINFOA si = {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {};

    BOOL success = CreateProcessA(
        nullptr,
        cmdStr.data(),
        nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        workDir.c_str(),
        &si, &pi
    );

    if (success) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        return true;
    }
    return false;
}

} // namespace Launcher
