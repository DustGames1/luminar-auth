#include "hwid.h"
#include <windows.h>
#include <iphlpapi.h>
#include <sstream>
#include <iomanip>
#include <vector>
#include <wincrypt.h>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "advapi32.lib")

namespace Hwid {

static std::string sha256(const std::string& input) {
    HCRYPTPROV hProv = 0;
    HCRYPTHASH hHash = 0;
    std::string result;

    if (!CryptAcquireContext(&hProv, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT))
        return "fallback-hwid";

    if (!CryptCreateHash(hProv, CALG_SHA_256, 0, 0, &hHash)) {
        CryptReleaseContext(hProv, 0);
        return "fallback-hwid";
    }

    CryptHashData(hHash, (BYTE*)input.c_str(), (DWORD)input.size(), 0);

    DWORD hashLen = 32;
    std::vector<BYTE> hash(hashLen);
    CryptGetHashParam(hHash, HP_HASHVAL, hash.data(), &hashLen, 0);

    std::ostringstream ss;
    for (DWORD i = 0; i < hashLen; i++)
        ss << std::hex << std::setfill('0') << std::setw(2) << (int)hash[i];

    CryptDestroyHash(hHash);
    CryptReleaseContext(hProv, 0);
    return ss.str();
}

static std::string getMac() {
    ULONG bufLen = 0;
    GetAdaptersInfo(nullptr, &bufLen);
    if (bufLen == 0) return "no-mac";

    std::vector<BYTE> buf(bufLen);
    auto info = reinterpret_cast<PIP_ADAPTER_INFO>(buf.data());
    if (GetAdaptersInfo(info, &bufLen) != NO_ERROR) return "no-mac";

    // Find first non-loopback adapter with MAC
    for (auto adapter = info; adapter; adapter = adapter->Next) {
        if (adapter->AddressLength == 0) continue;
        std::ostringstream ss;
        for (UINT i = 0; i < adapter->AddressLength; i++)
            ss << std::hex << std::setfill('0') << std::setw(2) << (int)adapter->Address[i];
        return ss.str();
    }
    return "no-mac";
}

std::string get() {
    static std::string cached;
    if (!cached.empty()) return cached;

    // Match Java HWID: os.name|os.arch|user.name|processors|mac
    SYSTEM_INFO si;
    GetSystemInfo(&si);

    char username[256] = {};
    DWORD usernameLen = sizeof(username);
    GetUserNameA(username, &usernameLen);

    std::ostringstream sb;
    sb << "Windows|amd64|" << username << "|" << si.dwNumberOfProcessors << "|" << getMac();

    cached = sha256(sb.str());
    return cached;
}

} // namespace Hwid
