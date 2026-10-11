/* Project & file templates for FullIDE. UMD: used by server.js (require) and the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TEMPLATES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAYLIB_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_executable({NAME} src/main.cpp)

# Auto-detect raylib (MSYS2 / Linux / macOS)
find_path(RAYLIB_INCLUDE_DIR raylib.h
  PATHS $ENV{RAYLIB_PATH}/include /usr/local/include /usr/include
  C:/msys64/ucrt64/include
  NO_DEFAULT_PATH)
find_path(RAYLIB_INCLUDE_DIR raylib.h)
find_library(RAYLIB_LIBRARY NAMES raylib
  PATHS $ENV{RAYLIB_PATH}/lib /usr/local/lib /usr/lib
  C:/msys64/ucrt64/lib
  NO_DEFAULT_PATH)

if(RAYLIB_INCLUDE_DIR AND RAYLIB_LIBRARY)
  target_include_directories({NAME} PRIVATE \${RAYLIB_INCLUDE_DIR})
  target_link_libraries({NAME} \${RAYLIB_LIBRARY} opengl32 gdi32 winmm user32)
  message(STATUS "raylib found: \${RAYLIB_LIBRARY}")
else()
  message(WARNING "raylib not found - install it or set RAYLIB_PATH")
endif()
`;

  const PLAIN_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_executable({NAME} src/main.cpp)
target_compile_options({NAME} PRIVATE -Wall -Wextra -g)
`;

  const PLAIN_C_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} C)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_executable({NAME} src/main.c)
target_compile_options({NAME} PRIVATE -Wall -Wextra -g)
`;

  const PONG = `// Pong — built with raylib. Press W/S (left paddle), Up/Down (right paddle).
#include <raylib.h>
#include <algorithm>

int main(void)
{
    const int W = 1024, H = 600;
    InitWindow(W, H, "Pong — FullIDE");
    SetTargetFPS(60);

    Rectangle ball   = { W / 2.0f - 8, H / 2.0f - 8, 16, 16 };
    Rectangle left   = { 40.0f, H / 2.0f - 60, 14, 120 };
    Rectangle right  = { W - 54.0f, H / 2.0f - 60, 14, 120 };
    float vx = 420.0f, vy = 260.0f;
    int scoreL = 0, scoreR = 0;

    while (!WindowShouldClose()) {
        float dt = GetFrameTime();

        if (IsKeyDown(KEY_W)) left.y  -= 560.0f * dt;
        if (IsKeyDown(KEY_S)) left.y  += 560.0f * dt;
        if (IsKeyDown(KEY_UP))    right.y -= 560.0f * dt;
        if (IsKeyDown(KEY_DOWN))  right.y += 560.0f * dt;
        left.y  = std::clamp(left.y,  0.0f, H - left.height);
        right.y = std::clamp(right.y, 0.0f, H - right.height);

        ball.x += vx * dt;
        ball.y += vy * dt;
        if (ball.y <= 0)             { ball.y = 0; vy = -vy; }
        if (ball.y >= H - ball.height) { ball.y = H - ball.height; vy = -vy; }

        if (CheckCollisionRecs(ball, left)  && vx < 0) { vx = -vx * 1.05f; ball.x = left.x + left.width; }
        if (CheckCollisionRecs(ball, right) && vx > 0) { vx = -vx * 1.05f; ball.x = right.x - ball.width; }

        if (ball.x < -20) { scoreR++; ball = (Rectangle){ W/2.0f, H/2.0f, 16, 16 }; vx = 420.0f; vy = (float)GetRandomValue(-260, 260); }
        if (ball.x > W + 20) { scoreL++; ball = (Rectangle){ W/2.0f, H/2.0f, 16, 16 }; vx = -420.0f; vy = (float)GetRandomValue(-260, 260); }

        BeginDrawing();
        ClearBackground(RAYWHITE);
        DrawRectangle(0, 0, W, H, (Color){ 24, 26, 33, 255 });
        DrawLineEx((Vector2){ W/2.0f, 0 }, (Vector2){ W/2.0f, H }, 4, (Color){ 90, 94, 110, 255 });
        DrawRectangleRec(left,  (Color){ 97, 175, 239, 255 });
        DrawRectangleRec(right, (Color){ 224, 108, 117, 255 });
        DrawRectangleRec(ball,  (Color){ 152, 195, 121, 255 });
        DrawText(TextFormat("%d", scoreL), W/2 - 60, 24, 40, LIGHTGRAY);
        DrawText(TextFormat("%d", scoreR), W/2 + 40, 24, 40, LIGHTGRAY);
        DrawText("W/S : Up/Down", 12, H - 30, 16, (Color){ 120, 124, 140, 255 });
        EndDrawing();
    }

    CloseWindow();
    return 0;
}
`;

  const SNAKE_CONSOLE = `// Console Snake — no dependencies. Arrow keys to move, Q to quit.
#include <stdio.h>
#include <stdlib.h>
#include <conio.h>
#include <windows.h>
#include <time.h>

#define W 40
#define H 22

static int board[H][W];
static int snake[H * W][2];
static int len, dirX, dirY, fruitX, fruitY, score;

static void placeFruit(void) {
    int x, y, ok;
    do {
        x = rand() % (W - 2) + 1;
        y = rand() % (H - 2) + 1;
        ok = 1;
        for (int i = 0; i < len; i++)
            if (snake[i][0] == x && snake[i][1] == y) ok = 0;
    } while (!ok);
    fruitX = x; fruitY = y;
}

int main(void) {
    srand((unsigned)time(NULL));
    len = 4; dirX = 1; dirY = 0; score = 0;
    for (int i = 0; i < len; i++) { snake[i][0] = 5 - i; snake[i][1] = 5; }
    placeFruit();

    while (1) {
        if (_kbhit()) {
            int k = _getch();
            if (k == 0 || k == 224) k = _getch();
            if (k == 72 && dirY != 1)  { dirX = 0; dirY = -1; }
            if (k == 80 && dirY != -1) { dirX = 0; dirY = 1; }
            if (k == 75 && dirX != 1)  { dirX = -1; dirY = 0; }
            if (k == 77 && dirX != -1) { dirX = 1; dirY = 0; }
            if (k == 113 || k == 81) break;
        }
        for (int i = len - 1; i > 0; i--) { snake[i][0] = snake[i-1][0]; snake[i][1] = snake[i-1][1]; }
        snake[0][0] += dirX; snake[0][1] += dirY;
        int hx = snake[0][0], hy = snake[0][1];
        if (hx <= 0 || hx >= W - 1 || hy <= 0 || hy >= H - 1) break;
        for (int i = 1; i < len; i++)
            if (snake[i][0] == hx && snake[i][1] == hy) { /* self hit */ break; }
        if (hx == fruitX && hy == fruitY) { len++; score += 10; placeFruit(); }

        system("cls");
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                if (x == 0 || y == 0 || x == W - 1 || y == H - 1) putchar('#');
                else if (x == fruitX && y == fruitY) putchar('*');
                else {
                    int body = 0;
                    for (int i = 0; i < len; i++)
                        if (snake[i][0] == x && snake[i][1] == y) { body = 1; break; }
                    putchar(body ? 'o' : ' ');
                }
            }
            putchar('\\n');
        }
        printf("Score: %d   (arrows = move, Q = quit)\\n", score);
        Sleep(90);
    }
    printf("\\nGame over! Final score: %d\\n", score);
    return 0;
}
`;

  const EMPTY_CPP_MAIN = `#include <iostream>

int main()
{
    std::cout << "Hello from FullIDE!\\n";
    return 0;
}
`;

  const EMPTY_C_MAIN = `#include <stdio.h>

int main(void)
{
    printf("Hello from FullIDE!\\n");
    return 0;
}
`;

  const SDL2_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(SDL2 REQUIRED)
add_executable({NAME} src/main.cpp)
target_include_directories({NAME} PRIVATE \${SDL2_INCLUDE_DIRS})
target_link_libraries({NAME} \${SDL2_LIBRARIES})
`;

  const SDL2_MAIN = `// SDL2 game template — requires SDL2 development packages.
// Install (MSYS2): pacman -S mingw-w64-ucrt-x86_64-SDL2
#include <SDL.h>
#include <iostream>

int main(int argc, char* argv[])
{
    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        std::cerr << "SDL_Init: " << SDL_GetError() << '\\n';
        return 1;
    }
    SDL_Window* win = SDL_CreateWindow("SDL2 Game", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, 960, 600, 0);
    SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
    bool running = true;
    SDL_Event ev;
    while (running) {
        while (SDL_PollEvent(&ev)) if (ev.type == SDL_QUIT) running = false;
        SDL_SetRenderDrawColor(ren, 24, 26, 33, 255);
        SDL_RenderClear(ren);
        SDL_SetRenderDrawColor(ren, 152, 195, 121, 255);
        SDL_Rect r = { 400, 260, 160, 80 };
        SDL_RenderFillRect(ren, &r);
        SDL_RenderPresent(ren);
    }
    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
`;

  const SFML_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(SFML 2.5 COMPONENTS graphics window system REQUIRED)
add_executable({NAME} src/main.cpp)
target_link_libraries({NAME} sfml-graphics sfml-window sfml-system)
`;

  const SFML_MAIN = `// SFML game template — requires SFML development packages.
#include <SFML/Graphics.hpp>

int main()
{
    sf::RenderWindow window(sf::VideoMode(960, 600), "SFML Game");
    sf::CircleShape shape(60.f);
    shape.setFillColor(sf::Color(152, 195, 121));
    shape.setPosition(420.f, 240.f);
    while (window.isOpen()) {
        sf::Event ev;
        while (window.pollEvent(ev))
            if (ev.type == sf::Event::Closed) window.close();
        window.clear(sf::Color(24, 26, 33));
        window.draw(shape);
        window.display();
    }
    return 0;
}
`;

  const OPENGL_CMAKE = `cmake_minimum_required(VERSION 3.20)
project({NAME} CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# GLAD: install it or drop glad.c into src/ and add it to the sources below.
find_package(OpenGL REQUIRED)
add_executable({NAME} src/main.cpp)
target_include_directories({NAME} PRIVATE \${OPENGL_INCLUDE_DIR} src)
target_link_libraries({NAME} \${OPENGL_LIBRARIES} opengl32 gdi32)
`;

  const OPENGL_MAIN = `// OpenGL game template — pair with GLAD (https://glad.dav1d.de) for loader code.
#include <GL/gl.h>
#include <GL/glu.h>
#include <cmath>

int main()
{
    // Window creation is platform-specific (Win32 / GLFW / SDL2).
    // This file documents the render loop you would run each frame.
    return 0;
}
`;

  const GITIGNORE = `build/
bin/
*.obj
*.o
*.exe
.vs/
.idea/
`;

  const README = `# {NAME}

Built with FullIDE — the C/C++ game development IDE.

## Run
1. Open this folder in FullIDE
2. Press **Ctrl+F9** to build (CMake + Ninja)
3. Press **Shift+F10** to run

## Notes
- Compiler: GCC 16 (C++23) via MSYS2
- Debugger: GDB (F5, breakpoints in the gutter)
`;

  function files(template, name) {
    const fill = (s) => s.split('{NAME}').join(name);
    switch (template) {
      case 'raylib-pong':
        return [
          { name: 'CMakeLists.txt', content: fill(RAYLIB_CMAKE) },
          { name: 'src/main.cpp', content: PONG },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'cpp-empty':
        return [
          { name: 'CMakeLists.txt', content: fill(PLAIN_CMAKE) },
          { name: 'src/main.cpp', content: EMPTY_CPP_MAIN },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'c-empty':
        return [
          { name: 'CMakeLists.txt', content: fill(PLAIN_C_CMAKE) },
          { name: 'src/main.c', content: EMPTY_C_MAIN },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'console-snake':
        return [
          { name: 'CMakeLists.txt', content: `cmake_minimum_required(VERSION 3.20)\nproject(${name} C)\nset(CMAKE_C_STANDARD 17)\nadd_executable(${name} src/main.c)\ntarget_link_libraries(${name} winmm)\n` },
          { name: 'src/main.c', content: SNAKE_CONSOLE },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'sdl2-game':
        return [
          { name: 'CMakeLists.txt', content: fill(SDL2_CMAKE) },
          { name: 'src/main.cpp', content: SDL2_MAIN },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'sfml-game':
        return [
          { name: 'CMakeLists.txt', content: fill(SFML_CMAKE) },
          { name: 'src/main.cpp', content: SFML_MAIN },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'opengl-game':
        return [
          { name: 'CMakeLists.txt', content: fill(OPENGL_CMAKE) },
          { name: 'src/main.cpp', content: OPENGL_MAIN },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      case 'raylib-empty':
        return [
          { name: 'CMakeLists.txt', content: fill(RAYLIB_CMAKE) },
          { name: 'src/main.cpp', content: `#include <raylib.h>\n\nint main(void)\n{\n    InitWindow(960, 600, "${name}");\n    SetTargetFPS(60);\n    while (!WindowShouldClose()) {\n        BeginDrawing();\n        ClearBackground(RAYWHITE);\n        DrawText("Hello raylib!", 380, 280, 24, DARKGRAY);\n        EndDrawing();\n    }\n    CloseWindow();\n    return 0;\n}\n` },
          { name: 'README.md', content: fill(README) },
          { name: '.gitignore', content: GITIGNORE },
        ];
      default:
        return [];
    }
  }

  const PROJECT_TEMPLATES = [
    { id: 'raylib-pong', name: 'Raylib Game (Pong)', lang: 'C++', desc: 'Complete Pong game with real-time rendering and input. raylib required (installed on this machine).' },
    { id: 'raylib-empty', name: 'Raylib Game (Empty)', lang: 'C++', desc: 'Minimal raylib window + game loop. raylib required.' },
    { id: 'cpp-empty', name: 'C++ Console App', lang: 'C++', desc: 'Empty C++23 project with CMake build.' },
    { id: 'c-empty', name: 'C Console App', lang: 'C', desc: 'Empty C17 project with CMake build.' },
    { id: 'console-snake', name: 'Console Game (Snake)', lang: 'C', desc: 'Classic Snake in the terminal. Zero dependencies.' },
    { id: 'sdl2-game', name: 'SDL2 Game', lang: 'C++', desc: 'SDL2 renderer template. Needs SDL2 dev packages.' },
    { id: 'sfml-game', name: 'SFML Game', lang: 'C++', desc: 'SFML graphics template. Needs SFML dev packages.' },
    { id: 'opengl-game', name: 'OpenGL Game', lang: 'C++', desc: 'Raw OpenGL skeleton. Pair with GLAD for loading.' },
  ];

  const FILE_TEMPLATES = [
    { id: 'cpp-main', name: 'C++ main.cpp', ext: 'cpp', content: EMPTY_CPP_MAIN },
    { id: 'c-main', name: 'C main.c', ext: 'c', content: EMPTY_C_MAIN },
    { id: 'cpp-class', name: 'C++ class (header + source)', files: [
      { name: '{NAME}.hpp', content: `#pragma once\n\nclass {CLASS} {\npublic:\n    {CLASS}();\n    ~{CLASS}();\n\n    void update(float dt);\n    void render();\n\nprivate:\n    float m_x = 0.0f;\n    float m_y = 0.0f;\n};\n` },
      { name: '{NAME}.cpp', content: `#include "{NAME}.hpp"\n\n{CLASS}::{CLASS}() = default;\n{CLASS}::~{CLASS}() = default;\n\nvoid {CLASS}::update(float dt)\n{\n    m_x += dt;\n}\n\nvoid {CLASS}::render()\n{\n}\n` },
    ] },
    { id: 'raylib-sprite', name: 'raylib sprite component', ext: 'hpp', content: `#pragma once\n#include <raylib.h>\n\nstruct Sprite {\n    Texture2D texture{};\n    Vector2 position{};\n    Vector2 velocity{};\n    float rotation = 0.0f;\n    float scale = 1.0f;\n\n    void load(const char* path) { texture = LoadTexture(path); }\n    void unload() { UnloadTexture(texture); }\n\n    void update(float dt)\n    {\n        position.x += velocity.x * dt;\n        position.y += velocity.y * dt;\n    }\n\n    void draw() const\n    {\n        DrawTextureEx(texture, position, rotation, scale, WHITE);\n    }\n};\n` },
    { id: 'cmake', name: 'CMakeLists.txt', ext: 'txt', content: PLAIN_CMAKE },
    { id: 'makefile', name: 'Makefile (mingw)', ext: '', content: `CXX := g++\nCXXFLAGS := -std=c++23 -Wall -Wextra -g -O2\nTARGET := game\nSRC := $(wildcard src/*.cpp)\n\nall: $(TARGET).exe\n\n$(TARGET).exe: $(SRC)\n\t$(CXX) $(CXXFLAGS) -o $@ $^\n\nclean:\n\trm -f $(TARGET).exe\n` },
  ];

  return {
    list() { return { projects: PROJECT_TEMPLATES, files: FILE_TEMPLATES.map((f) => ({ id: f.id, name: f.name, ext: f.ext })) }; },
    files(template, name) { return files(template, name); },
    fileContent(id, name) {
      const t = FILE_TEMPLATES.find((f) => f.id === id);
      if (!t) return null;
      if (t.files) return t.files.map((f) => ({ name: f.name.replace('{NAME}', name), content: f.content.replace(/\{NAME\}/g, name).replace(/\{CLASS\}/g, name) }));
      return [{ name: name + (t.ext ? '.' + t.ext : ''), content: t.content }];
    },
  };
});
