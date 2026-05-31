#include "session.h"
#include "config.h"
#include <fstream>
#include <vector>
#include <filesystem>

namespace Session {

static const std::string XOR_KEY = "luminar-session-xor";

static std::vector<uint8_t> xorData(const std::vector<uint8_t>& input) {
    std::vector<uint8_t> output(input.size());
    for (size_t i = 0; i < input.size(); i++)
        output[i] = input[i] ^ XOR_KEY[i % XOR_KEY.size()];
    return output;
}

void saveToken(const std::string& token) {
    std::filesystem::create_directories(Config::workDir());
    std::vector<uint8_t> data(token.begin(), token.end());
    auto encrypted = xorData(data);
    std::ofstream f(Config::sessionFile(), std::ios::binary);
    f.write(reinterpret_cast<const char*>(encrypted.data()), encrypted.size());
}

std::optional<std::string> loadToken() {
    auto path = Config::sessionFile();
    if (!std::filesystem::exists(path)) return std::nullopt;

    std::ifstream f(path, std::ios::binary | std::ios::ate);
    auto size = f.tellg();
    if (size <= 0) return std::nullopt;
    f.seekg(0);

    std::vector<uint8_t> data(size);
    f.read(reinterpret_cast<char*>(data.data()), size);

    auto decrypted = xorData(data);
    std::string token(decrypted.begin(), decrypted.end());
    if (token.empty()) return std::nullopt;
    return token;
}

void logout() {
    std::filesystem::remove(Config::sessionFile());
}

} // namespace Session
