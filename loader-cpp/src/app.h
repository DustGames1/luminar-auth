#pragma once

namespace App {
    // Application states
    enum class State {
        Login,
        Launch,
        Settings
    };

    void init();
    void render();
    State getState();
    void setState(State state);
    void setHwnd(void* hwnd);

    // Shared state
    struct UserInfo {
        char username[128] = {};
        char subscription[128] = "...";
        int uid = 0;
        char role[64] = {};
        bool verified = false;
    };

    UserInfo& userInfo();

    // Download progress
    struct Progress {
        float value = 0.0f;
        char status[256] = "";
        bool visible = false;
        bool launching = false;
    };

    Progress& progress();
}
