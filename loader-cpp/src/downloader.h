#pragma once
#include <string>
#include <filesystem>
#include <functional>

namespace Downloader {
    // progress(bytesRead, totalBytes)
    using ProgressCallback = std::function<void(int64_t, int64_t)>;

    bool download(const std::string& url, const std::filesystem::path& dest, ProgressCallback progress = nullptr);
}
