/* Code snippets for completion / live templates. */
(function (root) {
  'use strict';

  const SNIPPETS = [
    { trigger: 'main', kind: 's', desc: 'int main() skeleton', body: 'int main(int argc, char* argv[])\n{\n    $0\n    return 0;\n}' },
    { trigger: 'maincpp', kind: 's', desc: 'C++ main with std::cout', body: '#include <iostream>\n\nint main()\n{\n    std::cout << "$0" << std::endl;\n    return 0;\n}' },
    { trigger: 'for', kind: 's', desc: 'for loop', body: 'for (int i = 0; i < $1; i++)\n{\n    $0\n}' },
    { trigger: 'fori', kind: 's', desc: 'reverse for loop', body: 'for (int i = $1 - 1; i >= 0; i--)\n{\n    $0\n}' },
    { trigger: 'foreach', kind: 's', desc: 'range-based for', body: 'for (auto& $1 : $2)\n{\n    $0\n}' },
    { trigger: 'while', kind: 's', desc: 'while loop', body: 'while ($1)\n{\n    $0\n}' },
    { trigger: 'if', kind: 's', desc: 'if statement', body: 'if ($1)\n{\n    $0\n}' },
    { trigger: 'else', kind: 's', desc: 'if / else', body: 'if ($1)\n{\n    $2\n}\nelse\n{\n    $0\n}' },
    { trigger: 'class', kind: 's', desc: 'class declaration', body: 'class $1\n{\npublic:\n    $1();\n    ~$1();\n\nprivate:\n    $0\n};' },
    { trigger: 'struct', kind: 's', desc: 'struct declaration', body: 'struct $1\n{\n    $0\n};' },
    { trigger: 'enum', kind: 's', desc: 'enum declaration', body: 'enum class $1\n{\n    $0\n};' },
    { trigger: 'ns', kind: 's', desc: 'namespace', body: 'namespace $1\n{\n    $0\n}' },
    { trigger: 'printf', kind: 's', desc: 'printf line', body: 'printf("$1\\n", $0);' },
    { trigger: 'cout', kind: 's', desc: 'std::cout line', body: 'std::cout << $1 << std::endl;' },
    { trigger: 'cerr', kind: 's', desc: 'std::cerr line', body: 'std::cerr << $1 << std::endl;' },
    { trigger: 'vector', kind: 's', desc: 'std::vector', body: 'std::vector<$1> $2;$0' },
    { trigger: 'smartptr', kind: 's', desc: 'std::unique_ptr', body: 'auto $1 = std::make_unique<$2>($0);' },
    { trigger: 'lambda', kind: 's', desc: 'lambda', body: '[$1]($2) {\n    $0\n}' },
    { trigger: 'gameloop', kind: 's', desc: 'Fixed-timestep game loop', body: 'double accumulator = 0.0;\nconst double FIXED_DT = 1.0 / 60.0;\nauto last = std::chrono::steady_clock::now();\n\nwhile (running)\n{\n    auto now = std::chrono::steady_clock::now();\n    double frameTime = std::chrono::duration<double>(now - last).count();\n    last = now;\n    accumulator += frameTime;\n\n    while (accumulator >= FIXED_DT)\n    {\n        update(FIXED_DT);\n        accumulator -= FIXED_DT;\n    }\n    render(accumulator / FIXED_DT);\n}' },
    { trigger: 'entity', kind: 's', desc: 'Entity Component struct', body: 'struct Entity\n{\n    uint32_t id = 0;\n    float x = 0.0f, y = 0.0f;\n    float vx = 0.0f, vy = 0.0f;\n    float rotation = 0.0f;\n    bool active = true;\n\n    void update(float dt)\n    {\n        x += vx * dt;\n        y += vy * dt;\n    }\n\n    bool collides(const Entity& other) const\n    {\n        return std::abs(x - other.x) < 32.0f && std::abs(y - other.y) < 32.0f;\n    }\n};' },
    { trigger: 'rayloop', kind: 's', desc: 'raylib window + game loop', body: 'while (!WindowShouldClose())\n{\n    float dt = GetFrameTime();\n\n    // update\n    update(dt);\n\n    // render\n    BeginDrawing();\n    ClearBackground(RAYWHITE);\n    DrawFPS(10, 10);\n    EndDrawing();\n}' },
    { trigger: 'raysprite', kind: 's', desc: 'raylib sprite draw', body: 'Texture2D tex = LoadTexture("$1");\nVector2 pos = { $2, $3 };\nDrawTextureEx(tex, pos, 0.0f, 1.0f, WHITE);\nUnloadTexture(tex);' },
    { trigger: 'rayinput', kind: 's', desc: 'raylib keyboard input', body: 'if (IsKeyDown(KEY_$1))\n{\n    $0\n}\n\nif (IsKeyPressed(KEY_$1))\n{\n    // pressed once\n}' },
    { trigger: 'rayaudio', kind: 's', desc: 'raylib audio init + play', body: 'InitAudioDevice();\nSound sound = LoadSound("$1");\nPlaySound(sound);\n// ...\nUnloadSound(sound);\nCloseAudioDevice();' },
    { trigger: 'aabb', kind: 's', desc: 'AABB collision check', body: 'inline bool intersects(float ax, float ay, float aw, float ah,\n                     float bx, float by, float bw, float bh)\n{\n    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;\n}' },
    { trigger: 'clamp', kind: 's', desc: 'clamp helper', body: 'template <typename T>\nT clamp(T v, T lo, T hi)\n{\n    return v < lo ? lo : (v > hi ? hi : v);\n}' },
    { trigger: 'lerp', kind: 's', desc: 'linear interpolation', body: 'template <typename T>\nT lerp(T a, T b, float t)\n{\n    return a + (b - a) * t;\n}' },
    { trigger: 'singleton', kind: 's', desc: 'Meyers singleton', body: 'class $1\n{\npublic:\n    static $1& instance()\n    {\n        static $1 inst;\n        return inst;\n    }\n\nprivate:\n    $1() = default;\n    $0\n};' },
    { trigger: 'guard', kind: 's', desc: 'RAII scope guard', body: 'struct ScopeGuard\n{\n    std::function<void()> onExit;\n    ~ScopeGuard() { onExit(); }\n};\n\nScopeGuard guard{ []() {\n    $0\n} };' },
    { trigger: 'timer', kind: 's', desc: 'scope timer', body: 'auto t0 = std::chrono::steady_clock::now();\n$0\nauto t1 = std::chrono::steady_clock::now();\nstd::cout << "took " << std::chrono::duration<double, std::milli>(t1 - t0).count() << " ms\\n";' },
    { trigger: 'cmake', kind: 's', desc: 'CMakeLists.txt skeleton', body: 'cmake_minimum_required(VERSION 3.20)\nproject($1 CXX)\n\nset(CMAKE_CXX_STANDARD 23)\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\n\nadd_executable($1 src/main.cpp)\ntarget_compile_options($1 PRIVATE -Wall -Wextra -g)' },
    { trigger: 'sdlloop', kind: 's', desc: 'SDL2 event loop', body: 'SDL_Event ev;\nwhile (SDL_PollEvent(&ev))\n{\n    if (ev.type == SDL_QUIT) running = false;\n    switch (ev.type)\n    {\n        case SDL_KEYDOWN:\n            $0\n            break;\n    }\n}' },
    { trigger: 'statemachine', kind: 's', desc: 'game state machine', body: 'enum class State { Menu, Playing, Paused, GameOver };\nState state = State::Menu;\n\nvoid handleInput()\n{\n    switch (state)\n    {\n        case State::Menu:      $0; break;\n        case State::Playing:   break;\n        case State::Paused:    break;\n        case State::GameOver:  break;\n    }\n}' },
  ];

  root.Snippets = SNIPPETS;
})(typeof self !== 'undefined' ? self : this);
