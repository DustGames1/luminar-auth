#pragma once
#include <string>

namespace Auth {
    struct Result {
        bool ok = false;
        int status = -1;
        std::string body;
    };

    Result login(const std::string& username, const std::string& password, const std::string& hwid);
    Result verify(const std::string& token, const std::string& hwid);

    // Extract a field from JSON string (simple parser)
    std::string field(const std::string& json, const std::string& name);
}
