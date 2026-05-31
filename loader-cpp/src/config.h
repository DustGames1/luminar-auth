#pragma once
#include <string>
#include <filesystem>

namespace Config {
    // URLs
    inline const std::string AUTH_BASE_URL = "https://luminar-five-drab.vercel.app";
    inline const std::string CLIENT_JAR_URL = "https://github.com/DustGames1/luminar-auth/releases/download/luminar/luminar-client.jar";
    inline const std::string MINECRAFT_JAR_URL = "https://piston-data.mojang.com/v1/objects/37fd3c903861eeff3bc24b71eed48f828b5269c8/client.jar";

    // Paths
    std::filesystem::path workDir();
    std::filesystem::path clientJar();
    std::filesystem::path minecraftJar();
    std::filesystem::path settingsFile();
    std::filesystem::path sessionFile();

    // Settings
    struct Settings {
        int ramMb = 2048;
        bool fullscreen = false;
        int windowWidth = 854;
        int windowHeight = 480;
    };

    Settings& get();
    void load();
    void save();
}
