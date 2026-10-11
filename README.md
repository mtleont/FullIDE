# FullIDE — C/C++ IDE for Game Development

A complete IDE for C and C++ game development with a **custom FullIDE theme** and
**VSCode/CLion workflows**, powered by a real toolchain (GCC, CMake, Ninja, GDB, raylib).

## Quick start

```bash
npm start
# then open http://localhost:6248 in Chrome/Edge/Firefox
```

Or double-click **start.bat**.

## Features

### Editor (FullIDE look & feel)
- Live C/C++ syntax highlighting (keywords, types, preprocessor, strings, macros)
- Line numbers, current-line highlight, bracket matching, auto-indent
- Auto-closing brackets, Tab indentation, comment toggle (Ctrl+/)
- Find / Replace with regex + match navigation (Ctrl+F, Ctrl+H)
- Find in Files with match highlighting (Ctrl+Shift+F)
- Minimap with viewport indicator and click-to-jump
- File Structure view (Ctrl+F12) — functions, classes, macros, namespaces
- Code completion (Ctrl+Space) — keywords, STL, raylib API, snippets, file symbols
- Live templates / snippets (type `gameloop` + Tab, `entity`, `rayloop`, `aabb`, ...)
- Go to File (Ctrl+P), Go to Symbol (Ctrl+Alt+Shift+N), Go to Line (Ctrl+G)
- Search Everywhere (double Shift), Go to Definition (F12), Recent Files (Ctrl+E)
- Breakpoints in the gutter (Ctrl+F8), configurable font size / tab size / minimap
- FullIDE (custom dark) and Classic (light) themes; editor text uses JetBrains Mono

### Build & Run
- **Build (Ctrl+F9)** — CMake + Ninja when a `CMakeLists.txt` exists, otherwise
  direct `g++ -std=c++23 -O2 -g` compilation of the whole project
- **Run (Shift+F10)** — auto-builds, streams stdout/stderr to the Run pane,
  Stop with Ctrl+F2
- **Rebuild / Clean**, run configurations with program arguments (Alt+Shift+F10)
- Compiler diagnostics parsed into a **Problems** panel (Ctrl+Shift+M) with
  click-to-jump, error/warning markers in the gutter and on editor lines,
  counts in the status bar

### Debugging (real GDB engine)
- **F5** to debug, **F8** step over, **F7** step into, **F9** resume
- Breakpoints set by clicking the gutter, synced live with GDB
- Variables pane with live values, Call Stack pane with click-to-navigate,
  Breakpoints pane
- Debug line highlighting in the editor

### Game development
- Project templates: **Raylib Pong** (complete game), Raylib empty, SDL2, SFML,
  OpenGL, C/C++ console apps, **Console Snake** (zero deps)
- raylib is auto-detected and auto-linked (headers, libs, DLL path)
- File templates: C++ class (header+source), raylib sprite component, CMakeLists, Makefile
- Game-dev snippet library: fixed-timestep loop, entity/component, AABB collision,
  state machine, RAII guards, vector math, singletons

### Integrated tools
- **Terminal** (Alt+F12) — native system shell at the open project root, with streamed I/O.
  Configure its executable with `FULLIDE_SHELL`; commands use standard input/output (no pseudo-terminal)
- **Git** (Alt+9) — status, commit, log, init
- Sidebar / panel resizers, tool window toggles (Alt+1..9)
- Settings persisted to `~/.fullide/settings.json`

## Detected toolchain (this machine)

| Tool | Version |
|---|---|
| GCC (MSYS2 ucrt64) | 16.1 |
| Clang | 22.1 |
| CMake | 4.4.3 |
| Ninja | 1.13.2 |
| GDB | 17.2 |
| raylib | 5.5 (installed) |

## Architecture

```
FullIDE/
├── server.js               zero-dependency Node backend (file API, build, run, terminal, git, gdb MI)
├── templates-data.js → public/js/
│   templates-data.js       project & file templates (shared server/client)
└── public/
    ├── index.html          IDE shell (menus, toolbar, sidebar, tabs, panels, dialogs)
    ├── css/theme.css       FullIDE and Classic themes
    └── js/
        ├── syntax.js       C/C++ tokenizer
        ├── editor.js       editor widget (highlight overlay, gutter, minimap, find)
        ├── snippets.js     live templates
        └── app.js          application logic (project tree, build/run/debug, search, completion)
```

The backend exposes a small REST + SSE API (`/api/build`, `/api/run`, `/api/debug/...`,
`/api/term/...`, `/api/git/...`, `/api/file`, `/api/tree`, `/api/search`, ...) that the
browser frontend consumes. No npm dependencies — Node's built-in `http`/`child_process` only.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+F9 / Shift+F10 / F5 | Build / Run / Debug |
| Ctrl+S / Ctrl+Alt+S | Save / Save all + Settings |
| Ctrl+F, Ctrl+H, Ctrl+Shift+F | Find, Replace, Find in files |
| Ctrl+P, Ctrl+G, Ctrl+F12 | Go to file / line / structure |
| Double Shift | Search everywhere |
| Ctrl+Space | Completion |
| Alt+Insert | New file from template |
| Ctrl+F8 / Ctrl+Shift+F8 | Toggle breakpoint / breakpoint list |
| F8 / F7 / F9 | Step over / into / resume |
| Alt+F12 / Ctrl+Shift+F12 | Terminal / hide tool windows |
| F1 | Shortcut reference |

## Notes

- Graphical games (raylib/SDL2/SFML) open their own native windows; console games
  read input from the Run pane.
- The workspace root is `./workspace`. Open any folder via File → Open Folder.
- CMake templates auto-detect raylib via `find_path`/`find_library` (MSYS2 paths
  included), so they also work on Linux/macOS.
