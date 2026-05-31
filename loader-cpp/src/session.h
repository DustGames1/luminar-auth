#pragma once
#include <string>
#include <optional>

namespace Session {
    void saveToken(const std::string& token);
    std::optional<std::string> loadToken();
    void logout();
}
