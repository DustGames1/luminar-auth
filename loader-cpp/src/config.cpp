#include "config.h"
#include <fstream>
#include <sstream>
#include <ShlObj.h>

namespace Config {

static Settings s_settings;

std::filesystem::path workDir() {
    char path[MAX_PATH];
    SHGetFolderPathA(nullptr, CSIDL_PROFILE, nullptr, 0, path);
    return std::filesystem::path(path) / ".luminar";
}

std::filesystem::path clientJar()    { return workDir() / "luminar-client.jar"; }
std::filesystem::path minecraftJar() { return workDir() / "minecraft-1.16.5.jar"; }
std::filesystem::path settingsFile() { return workDir() / "settings.properties"; }
std::filesystem::path sessionFile()  { return workDir() / "session.dat"; }

Settings& get() { return s_settings; }

void load() {
    auto path = settingsFile();
    if (!std::filesystem::exists(path)) return;

    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty() || line[0] == '#') continue;
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        if (key == "ram") s_settings.ramMb = std::stoi(val);
        else if (key == "fullscreen") s_settings.fullscreen = (val == "true");
        else if (key == "width") s_settings.windowWidth = std::stoi(val);
        else if (key == "height") s_settings.windowHeight = std::stoi(val);
    }
}

void save() {
    std::filesystem::create_directories(workDir());
    std::ofstream f(settingsFile());
    f << "# Luminar Loader Settings\n";
    f << "ram=" << s_settings.ramMb << "\n";
    f << "fullscreen=" << (s_settings.fullscreen ? "true" : "false") << "\n";
    f << "width=" << s_settings.windowWidth << "\n";
    f << "height=" << s_settings.windowHeight << "\n";
}

} // namespace Config
