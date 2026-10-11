cmake_minimum_required(VERSION 3.20)
project(Pong CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_executable(Pong src/main.cpp)

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
  target_include_directories(Pong PRIVATE ${RAYLIB_INCLUDE_DIR})
  target_link_libraries(Pong ${RAYLIB_LIBRARY} opengl32 gdi32 winmm user32)
  message(STATUS "raylib found: ${RAYLIB_LIBRARY}")
else()
  message(WARNING "raylib not found - install it or set RAYLIB_PATH")
endif()
