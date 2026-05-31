#pragma once
#include <string>

namespace Launcher {
    // Returns true if game process started successfully
    bool launch();

    // Find Java executable
    std::string findJava();
}
