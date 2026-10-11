/* C/C++ syntax highlighter — tokenizes source into per-line token arrays. */
(function (root) {
  'use strict';

  const KEYWORDS = new Set((
    'auto bool break case catch char class co_await co_return co_yield const consteval constinit const_cast continue ' +
    'decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if ' +
    'inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast ' +
    'return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true ' +
    'try typedef typeid typename union unsigned using virtual void volatile wchar_t while and or not bitand bitor compl ' +
    'xor_eq and_eq or_eq not_eq xor override final if constexpr concept requires import module typename'
  ).split(' '));

  const TYPES = new Set((
    'size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t uintptr_t intptr_t ' +
    'string wstring vector map unordered_map set unordered_map multimap pair tuple array queue stack deque list ' +
    'shared_ptr unique_ptr weak_ptr make_shared make_unique function optional variant string_view chrono ' +
    'Color Vector2 Vector3 Vector4 Rectangle Image Texture2D RenderTexture2D Shader Camera Camera2D Camera3D Ray ' +
    'Mesh Model ModelAnimation BoundingBox Material Animation Bone Info Font Glyph Wave Sound Music AudioStream ' +
    'AudioDevice VrStereoConfig VrDeviceInfo rlVertexBuffer Path RayCollision Quaternion Matrix ' +
    'SDL_Window SDL_Renderer SDL_Texture SDL_Event SDL_Rect SDL_Point SDL_Surface sfRenderWindow sfSprite sfTexture2D ' +
    'DWORD HANDLE HWND POINT RECT WNDPROC LRESULT UINT WPARAM LPARAM FILE fpos_t div_t ldiv_t time_t clock_t ' +
    'jmp_buf sigjmp_buf va_list GLbyte GLshort GLint GLsizei GLubyte GLushort GLuint GLenum GLbitfield GLfloat GLdouble ' +
    'GLchar GLboolean GLclampf GLclampd GLvoid GLeglClientBuffer '
  ).split(' '));

  const CONSTS = new Set(['true', 'false', 'nullptr', 'NULL', 'EOF', 'EXIT_SUCCESS', 'EXIT_FAILURE', 'RAND_MAX']);

  const MASTER = new RegExp([
    '(\\/\\/[^\\n]*)',                                             // 1 line comment
    '(\\/\\*[\\s\\S]*?(?:\\*\\/|$))',                              // 2 block comment
    '("(?:\\\\.|[^"\\\\\\n])*"?)',                                 // 3 string
    "('(?:\\\\.|[^'\\\\\\n])*'?)",                                 // 4 char
    '(#[^\\n]*)',                                                  // 5 preprocessor
    '\\b(0[xX][0-9a-fA-F]+[uUlL]*|\\d[\\d\']*\\.?\\d*(?:[eE][+-]?\\d+)?[fFuUlL]*)\\b', // 6 number
    '([A-Za-z_]\\w*)',                                             // 7 identifier
    '(\\s+|.)'                                                    // 8 whitespace / other
  ].join('|'), 'g');

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function classifyIdent(word, after) {
    if (KEYWORDS.has(word)) return 'kw';
    if (CONSTS.has(word)) return 'const';
    if (TYPES.has(word)) return 'type';
    if (after === '(') return 'fn';
    if (/^[A-Z][A-Z0-9_]{1,}$/.test(word)) return 'macro';
    if (/^[A-Z]/.test(word) && word.length > 1 && !/^\d/.test(word) && word === word[0].toUpperCase() + word.slice(1)) {
      if (/[a-z]/.test(word) === false) return 'macro';
      return 'type';
    }
    return null;
  }

  // Returns array of lines; each line = array of {c: class, t: text}
  function tokenize(text) {
    const lines = [];
    let current = [];
    const pushLine = () => { lines.push(current); current = []; };

    MASTER.lastIndex = 0;
    let m;
    let remaining = text;
    while ((m = MASTER.exec(text)) !== null) {
      if (m.index > MASTER.lastIndex - m[0].length && m.index < MASTER.lastIndex && MASTER.lastIndex === m.index + m[0].length) {
        // normal
      }
      const tok = m[0];
      let cls = null;
      if (m[1] !== undefined) cls = 'com';
      else if (m[2] !== undefined) cls = 'com';
      else if (m[3] !== undefined) cls = 'str';
      else if (m[4] !== undefined) cls = 'str';
      else if (m[5] !== undefined) cls = 'pp';
      else if (m[6] !== undefined) cls = 'num';
      else if (m[7] !== undefined) {
        const rest = text.slice(MASTER.lastIndex);
        const after = /^\s*\(/.test(rest) ? '(' : rest[0] || '';
        cls = classifyIdent(tok, after);
      }
      if (cls) {
        // split token by newlines
        const parts = tok.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) pushLine();
          if (parts[i]) current.push({ c: cls, t: parts[i] });
        }
      } else {
        const parts = tok.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) pushLine();
          if (parts[i]) current.push({ c: 'op', t: parts[i] });
        }
      }
      if (MASTER.lastIndex === m.index) MASTER.lastIndex++; // safety
    }
    // trailing text after last match (shouldn't happen, but be safe)
    pushLine();
    return lines;
  }

  // Build HTML for one line's tokens
  function lineHTML(tokens) {
    let out = '';
    for (const t of tokens) {
      out += '<span class="tok-' + t.c + '">' + escapeHtml(t.t) + '</span>';
    }
    return out;
  }

  root.Syntax = { tokenize, lineHTML, KEYWORDS, TYPES };
})(typeof self !== 'undefined' ? self : this);
