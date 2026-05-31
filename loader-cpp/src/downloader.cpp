#include "downloader.h"
#include <curl/curl.h>
#include <fstream>

namespace Downloader {

struct DownloadCtx {
    std::ofstream file;
    int64_t bytesRead = 0;
    ProgressCallback progress;
};

static size_t writeFile(void* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* ctx = static_cast<DownloadCtx*>(userdata);
    size_t bytes = size * nmemb;
    ctx->file.write(static_cast<char*>(ptr), bytes);
    ctx->bytesRead += bytes;
    return bytes;
}

static int progressFunc(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t, curl_off_t) {
    auto* ctx = static_cast<DownloadCtx*>(clientp);
    if (ctx->progress && dlnow > 0)
        ctx->progress(dlnow, dltotal);
    return 0;
}

bool download(const std::string& url, const std::filesystem::path& dest, ProgressCallback progress) {
    std::filesystem::create_directories(dest.parent_path());
    auto tmp = dest;
    tmp += ".part";

    DownloadCtx ctx;
    ctx.file.open(tmp, std::ios::binary);
    if (!ctx.file.is_open()) return false;
    ctx.progress = progress;

    CURL* curl = curl_easy_init();
    if (!curl) return false;

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeFile);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, progressFunc);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "Luminar-Loader/1.0");

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    ctx.file.close();

    if (res != CURLE_OK) {
        std::filesystem::remove(tmp);
        return false;
    }

    std::filesystem::rename(tmp, dest);
    return true;
}

} // namespace Downloader
