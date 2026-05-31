#include "auth.h"
#include "config.h"
#include <curl/curl.h>
#include <sstream>

namespace Auth {

static size_t writeCallback(void* contents, size_t size, size_t nmemb, std::string* out) {
    out->append(static_cast<char*>(contents), size * nmemb);
    return size * nmemb;
}

static std::string escape(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else out += c;
    }
    return out;
}

static Result post(const std::string& path, const std::string& jsonBody) {
    Result result;
    CURL* curl = curl_easy_init();
    if (!curl) { result.body = "{\"error\":\"curl init failed\"}"; return result; }

    std::string url = Config::AUTH_BASE_URL + path;
    std::string response;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, "User-Agent: Luminar-Loader/1.0");

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

    CURLcode res = curl_easy_perform(curl);
    if (res == CURLE_OK) {
        long httpCode = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
        result.status = (int)httpCode;
        result.ok = (httpCode >= 200 && httpCode < 300);
        result.body = response;
    } else {
        result.body = std::string("{\"error\":\"") + curl_easy_strerror(res) + "\"}";
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return result;
}

Result login(const std::string& username, const std::string& password, const std::string& hwid) {
    std::ostringstream json;
    json << "{\"username\":\"" << escape(username)
         << "\",\"password\":\"" << escape(password)
         << "\",\"hwid\":\"" << escape(hwid) << "\"}";
    return post("/api/login", json.str());
}

Result verify(const std::string& token, const std::string& hwid) {
    std::ostringstream json;
    json << "{\"token\":\"" << escape(token)
         << "\",\"hwid\":\"" << escape(hwid) << "\"}";
    return post("/api/verify", json.str());
}

std::string field(const std::string& json, const std::string& name) {
    std::string key = "\"" + name + "\"";
    auto i = json.find(key);
    if (i == std::string::npos) return "";
    i = json.find(':', i);
    if (i == std::string::npos) return "";
    i++;
    while (i < json.size() && std::isspace(json[i])) i++;
    if (i >= json.size()) return "";

    if (json[i] == '"') {
        std::string result;
        size_t end = i + 1;
        while (end < json.size() && json[end] != '"') {
            if (json[end] == '\\' && end + 1 < json.size()) {
                result += json[end + 1];
                end += 2;
            } else {
                result += json[end];
                end++;
            }
        }
        return result;
    }
    size_t end = i;
    while (end < json.size() && std::string(",}]\n\r\t ").find(json[end]) == std::string::npos) end++;
    return json.substr(i, end - i);
}

} // namespace Auth
