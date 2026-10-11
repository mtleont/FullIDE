/* Code editor widget: highlight overlay, gutter, minimap, find/replace, breakpoints. */
(function (root) {
  'use strict';

  const LINE_H = 19;
  let editorId = 0;

  class Editor {
    constructor(host, handlers) {
      this.handlers = handlers || {};
      this.id = ++editorId;
      this.text = '';
      this.lines = [];
      this.path = null;
      this.dirty = false;
      this.diagnostics = [];       // [{line, col, severity}]
      this.breakpoints = new Set();
      this.debugLine = null;
      this.findMatches = [];
      this.findIdx = -1;
      this.tabSize = 4;

      // DOM
      this.el = document.createElement('div');
      this.el.className = 'editor';

      this.gutter = document.createElement('div');
      this.gutter.className = 'gutter';

      this.code = document.createElement('div');
      this.code.className = 'code';
      this.pre = document.createElement('pre');
      this.ta = document.createElement('textarea');
      this.ta.spellcheck = false;
      this.ta.autocapitalize = 'off';
      this.ta.autocomplete = 'off';
      this.ta.wrap = 'off';
      this.code.appendChild(this.pre);
      this.code.appendChild(this.ta);

      this.mini = document.createElement('canvas');
      this.mini.className = 'minimap';
      if (typeof self !== 'undefined' && self.FullIDESettings && self.FullIDESettings.minimap === false) {
        this.mini.style.display = 'none';
      }

      this.el.appendChild(this.gutter);
      this.el.appendChild(this.code);
      this.el.appendChild(this.mini);
      host.appendChild(this.el);

    this._measureCtx = document.createElement('canvas').getContext('2d');
    this.charW = this._measureCharWidth();

    this._bind();
    this._gutterCurrent = null;
  }

  _lh() {
    const lh = parseInt(getComputedStyle(this.ta).lineHeight, 10);
    return isNaN(lh) ? 19 : lh;
  }

  _measureCharWidth() {
    const fs = getComputedStyle(this.el).fontSize || '13px';
    this._measureCtx.font = fs + ' "JetBrains Mono", Consolas, monospace';
    return this._measureCtx.measureText('xxxxxxxxxx').width / 10 || 7.8;
  }

    _bind() {
      const ta = this.ta;
      ta.addEventListener('input', () => {
        this.text = ta.value;
        this.dirty = true;
        this._scheduleRender();
        if (this.handlers.onChange) this.handlers.onChange(this);
      });
      ta.addEventListener('scroll', () => this._syncScroll());
      ta.addEventListener('keyup', (e) => { if (this.handlers.onCursor) this.handlers.onCursor(this, e); });
      ta.addEventListener('click', (e) => { if (this.handlers.onCursor) this.handlers.onCursor(this, e); });
      ta.addEventListener('select', () => { if (this.handlers.onCursor) this.handlers.onCursor(this); });

      ta.addEventListener('keydown', (e) => this._onKeydown(e));

      this.gutter.addEventListener('mousedown', (e) => {
        const gl = e.target.closest('.gl');
        if (!gl) return;
        const line = parseInt(gl.dataset.l, 10);
        if (e.target.classList.contains('bp-dot') || e.offsetX < 18) {
          if (this.handlers.onBreakpointToggle) this.handlers.onBreakpointToggle(this, line);
        } else {
          this._setCursorToLine(line);
        }
      });

      this.mini.addEventListener('click', (e) => {
        const rect = this.mini.getBoundingClientRect();
        const ratio = this.lines.length / rect.height;
        const line = Math.floor((e.clientY - rect.top) * ratio);
        this.gotoLine(Math.max(1, Math.min(line + 1, this.lines.length)));
      });
    }

  _onKeydown(e) {
    const ta = this.ta;
    const { selectionStart: s, selectionEnd: en } = ta;
    const settings = (typeof self !== 'undefined' && self.FullIDESettings) || {};

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        const lineStart = this.text.lastIndexOf('\n', s - 1) + 1;
        const lineText = this.text.slice(lineStart, en);
        const ded = lineText.replace(new RegExp('^ {1,' + this.tabSize + '}'), '');
        this._replaceRange(lineStart, en, ded);
      } else {
        this._replaceRange(s, en, ' '.repeat(this.tabSize));
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const lineStart = this.text.lastIndexOf('\n', s - 1) + 1;
      const curLine = this.text.slice(lineStart, s);
      const indent = (curLine.match(/^\s*/) || [''])[0];
      const before = this.text.slice(Math.max(0, s - 1), s);
      let extra = '';
      if (before === '{' || before === '(' || before === '[') extra = ' '.repeat(this.tabSize);
      const insert = '\n' + indent + extra;
      this._replaceRange(s, en, insert);
      return;
    }
    // auto-close pairs
    if (settings.autoBrackets !== false && !e.ctrlKey && !e.metaKey && !e.altKey && s === en) {
      const pairs = { '(': ')', '{': '}', '[': ']', '"': '"', "'": "'" };
      if (pairs[e.key]) {
        const next = this.text[s];
        if (!next || !/[\w'"`}\])]/.test(next)) {
          e.preventDefault();
          this._replaceRange(s, en, e.key + pairs[e.key]);
          ta.setSelectionRange(s + 1, s + 1);
          return;
        }
      }
      if ((e.key === '}' || e.key === ')' || e.key === ']') && this.text[s] === e.key) {
        e.preventDefault();
        ta.setSelectionRange(s + 1, s + 1);
        return;
      }
    }
  }

    _replaceRange(start, end, text) {
      this.text = this.text.slice(0, start) + text + this.text.slice(end);
      this.ta.value = this.text;
      this.ta.setSelectionRange(start + text.length, start + text.length);
      this.dirty = true;
      this._scheduleRender();
      if (this.handlers.onChange) this.handlers.onChange(this);
    }

    _scheduleRender() {
      if (this._renderPending) return;
      this._renderPending = true;
      requestAnimationFrame(() => {
        this._renderPending = false;
        this.render();
      });
    }

    setValue(text, path) {
      this.text = text;
      this.path = path || this.path;
      this.ta.value = text;
      this.dirty = false;
      this.render();
    }

    getValue() { return this.ta.value; }

    render() {
      const lines = Syntax.tokenize(this.text);
      this.lines = lines;
      const diagMap = new Map();
      for (const d of this.diagnostics) {
        if (d.line > 0) {
          if (!diagMap.has(d.line)) diagMap.set(d.line, d.severity);
          else if (d.severity === 'error') diagMap.set(d.line, 'error');
        }
      }
      const cur = this._currentLine();
      let html = '';
      for (let i = 0; i < lines.length; i++) {
        const ln = i + 1;
        let cls = 'line';
        if (ln === cur) cls += ' current';
        if (diagMap.has(ln)) cls += diagMap.get(ln) === 'error' ? ' err-line' : ' warn-line';
        if (this.breakpoints.has(ln)) cls += ' bp-line';
        if (this.debugLine === ln) cls += ' dbg-line';
        html += '<span class="' + cls + '" data-l="' + ln + '">' + Syntax.lineHTML(lines[i]) + '</span>';
      }
      this.pre.innerHTML = html;
      this._renderGutter(diagMap);
      this._renderMinimap();
      this._syncScroll();
    }

    _renderGutter(diagMap) {
      const n = this.lines.length;
      let html = '';
      for (let i = 1; i <= n; i++) {
        let cls = 'gl';
        if (i === this._currentLine()) cls += ' current';
        html += '<div class="' + cls + '" data-l="' + i + '">' + i;
        if (this.breakpoints.has(i)) html += '<span class="bp-dot"></span>';
        if (diagMap && diagMap.has(i)) {
          html += '<span class="diag-dot ' + (diagMap.get(i) === 'error' ? 'error' : 'warning') + '">' +
            (diagMap.get(i) === 'error' ? '✕' : '⚠') + '</span>';
        }
        html += '</div>';
      }
      this.gutter.innerHTML = html;
    }

    _renderMinimap() {
      const c = this.mini;
      const w = 64, h = Math.max(this.el.clientHeight, 200);
      c.width = w * devicePixelRatio;
      c.height = h * devicePixelRatio;
      c.style.height = h + 'px';
      const ctx = c.getContext('2d');
      ctx.scale(devicePixelRatio, devicePixelRatio);
      ctx.fillStyle = '#232323';
      ctx.fillRect(0, 0, w, h);
    // scaleX uses avg char width; redraw at current font metrics
    this.charW = this._measureCharWidth();
    const colors = { kw: '#cc7832', str: '#6a8759', num: '#6897bb', com: '#4d4d4d', fn: '#ffc66d', type: '#4ec9b0', macro: '#cc7832', pp: '#b06030', op: '#3f3f3f', const: '#6897bb' };
    let maxLen = 40;
    for (const l of this.lines) {
      let len = 0;
      for (const t of l) len += t.t.length;
      if (len > maxLen) maxLen = len;
    }
    const scaleX = (w - 6) / maxLen;
      const scaleY = Math.min(2, h / Math.max(this.lines.length, 1));
      for (let i = 0; i < this.lines.length && i * scaleY < h; i++) {
        let x = 3;
        for (const t of this.lines[i]) {
          const tw = Math.max(1, t.t.length * scaleX);
          ctx.fillStyle = colors[t.c] || '#3f3f3f';
          ctx.fillRect(x, i * scaleY, tw, Math.max(0.8, scaleY - 0.15));
          x += tw;
        }
      }
      // viewport indicator
      const ta = this.ta;
      const total = Math.max(ta.scrollHeight, 1);
      const vh = (ta.clientHeight / total) * h;
      const vy = (ta.scrollTop / total) * h;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, vy, w, vh);
    }

    _syncScroll() {
      const ta = this.ta;
      this.pre.scrollTop = ta.scrollTop;
      this.pre.scrollLeft = ta.scrollLeft;
      this.gutter.scrollTop = ta.scrollTop;
      this._renderMinimapViewportOnly();
    }

    _renderMinimapViewportOnly() {
      // cheap viewport redraw: full redraw throttled
      if (this._miniPending) return;
      this._miniPending = true;
      requestAnimationFrame(() => {
        this._miniPending = false;
        if (this.lines.length < 4000) this._renderMinimap();
        else {
          const c = this.mini, ctx = c.getContext('2d');
          const h = this.el.clientHeight, w = 64;
          const total = Math.max(this.ta.scrollHeight, 1);
          ctx.clearRect(0, 0, w, h);
          const vh = (this.ta.clientHeight / total) * h;
          const vy = (this.ta.scrollTop / total) * h;
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(0, vy, w, vh);
        }
      });
    }

    _currentLine() {
      const idx = this.ta.selectionStart;
      return this.text.slice(0, idx).split('\n').length;
    }

    cursorPos() {
      const idx = this.ta.selectionStart;
      const before = this.text.slice(0, idx);
      const line = before.split('\n').length;
      const col = idx - before.lastIndexOf('\n');
      return { index: idx, line, col: col };
    }

    setCursor(index) {
      this.ta.focus();
      this.ta.setSelectionRange(index, index);
      this._afterCursor();
    }

    _setCursorToLine(line) {
      const lines = this.text.split('\n');
      let idx = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) idx += lines[i].length + 1;
      this.setCursor(idx);
    }

    _afterCursor() {
      if (this.handlers.onCursor) this.handlers.onCursor(this);
      // update current line classes without full re-render
      const cur = this._currentLine();
      if (this._gutterCurrent !== cur) {
        this._gutterCurrent = cur;
        const prev = this.pre.querySelector('.line.current');
        if (prev) prev.classList.remove('current');
        const next = this.pre.querySelector('.line[data-l="' + cur + '"]');
        if (next) next.classList.add('current');
        const gPrev = this.gutter.querySelector('.gl.current');
        if (gPrev) gPrev.classList.remove('current');
        const gNext = this.gutter.querySelector('.gl[data-l="' + cur + '"]');
        if (gNext) gNext.classList.add('current');
      }
    }

  caretPixel() {
    const { line, col } = this.cursorPos();
    const x = col * this.charW + 8 - this.ta.scrollLeft;
    const y = (line - 1) * this._lh() + this._lh() - this.ta.scrollTop;
    return { x, y, lineH: this._lh() };
  }

    lineText(line) {
      const lines = this.text.split('\n');
      return lines[line - 1] || '';
    }

    wordAt(index) {
      const i = index === undefined ? this.ta.selectionStart : index;
      const re = /[A-Za-z_]\w*/g;
      let m, best = null;
      while ((m = re.exec(this.text)) !== null) {
        if (i >= m.index && i <= m.index + m[0].length) { best = m; break; }
        if (m.index > i) break;
      }
      return best ? { word: m[0], start: best.index, end: best.index + best[0].length } : null;
    }

    insertText(t) {
      const { selectionStart: s, selectionEnd: e } = this.ta;
      this._replaceRange(s, e, t);
    }

    getWordPrefix() {
      const i = this.ta.selectionStart;
      const re = /[A-Za-z_]\w*$/;
      const m = re.exec(this.text.slice(0, i));
      return m ? { prefix: m[0], start: i - m[0].length, end: i } : { prefix: '', start: i, end: i };
    }

    // ---- diagnostics ----
    setDiagnostics(list) {
      this.diagnostics = list || [];
      this.render();
    }

    // ---- breakpoints ----
    toggleBreakpoint(line) {
      if (this.breakpoints.has(line)) this.breakpoints.delete(line);
      else this.breakpoints.add(line);
      this.render();
    }
    setBreakpoints(set) { this.breakpoints = new Set(set); this.render(); }
    setDebugLine(line) { this.debugLine = line; this.render(); }

    // ---- find / replace ----
    find(query, { caseSensitive = false, regex = false } = {}) {
      this.findMatches = [];
      this.findIdx = -1;
      if (!query) return 0;
      let flags = 'g';
      if (!caseSensitive) flags += 'i';
      let re;
      try {
        re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch (e) { return 0; }
      let m;
      while ((m = re.exec(this.text)) !== null) {
        this.findMatches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
        if (this.findMatches.length > 5000) break;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (this.findMatches.length) {
        const pos = this.cursorPos().index;
        this.findIdx = this.findMatches.findIndex((x) => x.end > pos);
        if (this.findIdx < 0) this.findIdx = 0;
        this._selectFind();
      }
      return this.findMatches.length;
    }

    findNext() {
      if (!this.findMatches.length) return false;
      this.findIdx = (this.findIdx + 1) % this.findMatches.length;
      this._selectFind();
      return true;
    }
    findPrev() {
      if (!this.findMatches.length) return false;
      this.findIdx = (this.findIdx - 1 + this.findMatches.length) % this.findMatches.length;
      this._selectFind();
      return true;
    }

    _selectFind() {
      const m = this.findMatches[this.findIdx];
      if (!m) return;
      this.ta.focus();
      this.ta.setSelectionRange(m.start, m.end);
      this._scrollToIndex(m.start);
      if (this.handlers.onCursor) this.handlers.onCursor(this);
    }

  _scrollToIndex(idx) {
    const before = this.text.slice(0, idx);
    const line = before.split('\n').length;
    const target = (line - 1) * this._lh() - this.ta.clientHeight / 2;
    this.ta.scrollTop = Math.max(0, target);
    this._syncScroll();
  }

    replaceOne(replacement) {
      const m = this.findMatches[this.findIdx];
      if (!m) return false;
      this._replaceRange(m.start, m.end, replacement);
      this.findMatches.splice(this.findIdx, 1);
      return true;
    }

    replaceAll(replacement, query, { caseSensitive = false, regex = false } = {}) {
      if (!query) return 0;
      let flags = 'g';
      if (!caseSensitive) flags += 'i';
      let re;
      try {
        re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      } catch (e) { return 0; }
      const count = (this.text.match(re) || []).length;
      if (count) {
        const newText = this.text.replace(re, replacement);
        this._replaceRange(0, this.text.length, newText);
      }
      return count;
    }

    gotoLine(line) {
      const lines = this.text.split('\n');
      const n = Math.max(1, Math.min(line, lines.length));
      let idx = 0;
      for (let i = 0; i < n - 1; i++) idx += lines[i].length + 1;
      const end = idx + (lines[n - 1] || '').length;
      this.ta.focus();
      this.ta.setSelectionRange(idx, end);
      this._scrollToIndex(idx);
      if (this.handlers.onCursor) this.handlers.onCursor(this);
    }

    // bracket matching
    findMatchingBracket() {
      const i = this.ta.selectionStart;
      const ch = this.text[i - 1];
      const pairs = { '(': ')', ')': '(', '{': '}', '}': '{', '[': ']', ']': '[' };
      if (!(ch in pairs)) return null;
      const dir = ch === '(' || ch === '{' || ch === '[' ? 1 : -1;
      let depth = 0;
      for (let j = i - 1; j >= 0 && j < this.text.length; j += dir) {
        if (this.text[j] === ch) depth++;
        else if (this.text[j] === pairs[ch]) depth--;
        if (depth === 0) return { a: i - 1, b: j };
      }
      return null;
    }

    focus() { this.ta.focus(); }

    isModified() { return this.dirty; }
    markSaved() { this.dirty = false; }

    dispose() { this.el.remove(); }
  }

  root.Editor = Editor;
  root.EDITOR_LINE_H = LINE_H;
})(typeof self !== 'undefined' ? self : this);
