/* FullIDE application logic */
'use strict';

/* ---------------------------------------------------------------- helpers */

/* browser path shim (Windows-style, matching the Node backend) */
const path = {
  sep: '\\',
  basename: (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop(),
  dirname: (p) => {
    const s = String(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i < 0) return '.';
    return s.slice(0, i) || s.slice(0, 1);
  },
  join: (...parts) => parts.filter(Boolean).join('\\').replace(/[\\/]{2,}/g, '\\'),
  resolve: (p) => {
    let s = String(p).replace(/\//g, '\\');
    const parts = s.split('\\');
    const out = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('\\');
  },
  extname: (p) => {
    const n = path.basename(p);
    const i = n.lastIndexOf('.');
    return i < 0 ? '' : n.slice(i);
  },
};

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data && data.error ? data.error : ('HTTP ' + res.status));
  return data;
}

/* ---------------------------------------------------------------- state */

const state = {
  root: null,
  files: new Map(),       // path -> {editor, tab, name}
  active: null,
  tools: {},
  build: { exePath: null, running: false, diagnostics: [] },
  run: { session: null, es: null, running: false },
  debug: null,
  term: { id: null, es: null, cwd: null, shell: null, starting: null, history: [], historyIndex: 0 },
  clangd: {
    id: null, root: null, status: 'stopped', es: null, starting: null,
    versions: new Map(), opened: new Set(), diagnostics: new Map(), changeTimers: new Map(), missingReported: false,
  },
  settings: { fontSize: 13, tabSize: 4, minimap: true, autoBrackets: true, theme: 'fullide' },
  expanded: new Set(),
  runConfig: { exe: '', args: '', cwd: '' },
  findState: null,
  treeData: null,
};

/* ---------------------------------------------------------------- output */

function logOut(text, cls) {
  const pane = $('app-output');
  pane.insertAdjacentHTML('beforeend', '<div class="' + (cls || '') + '">' + esc(text) + '</div>');
  pane.parentElement.scrollTop = pane.parentElement.scrollHeight;
}

function setBuildOutput(text) {
  const el = $('build-output');
  el.innerHTML = '';
  for (const line of text.split('\n')) {
    let cls = '';
    if (/(error|fatal error)/i.test(line)) cls = 'err-text';
    else if (/warning/i.test(line)) cls = 'warn-text';
    else if (/^===/.test(line)) cls = 'cmd-text';
    else if (/Built target|Build finished|Linking/i.test(line)) cls = 'ok-text';
    el.insertAdjacentHTML('beforeend', '<span class="' + cls + '">' + esc(line) + '</span>\n');
  }
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

function appendRunOutput(text) {
  const el = $('run-output');
  el.insertAdjacentText('beforeend', text);
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

function clearRunOutput() { $('run-output').innerHTML = ''; }

/* ---------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const s = await api('GET', '/api/settings');
    Object.assign(state.settings, s);
  } catch (e) {}
  if (state.settings.theme === 'darcula') state.settings.theme = 'fullide';
  window.FullIDESettings = state.settings;
  applySettings();
}

function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty('--ed-fs', s.fontSize + 'px');
  document.documentElement.style.setProperty('--ed-lh', Math.round(s.fontSize * 1.46) + 'px');
  document.body.dataset.theme = s.theme;
  for (const f of state.files.values()) {
    f.editor.tabSize = s.tabSize;
    f.editor.charW = f.editor._measureCharWidth();
    f.editor.render();
  }
  $$('.minimap').forEach((m) => { m.style.display = s.minimap ? '' : 'none'; });
}

async function saveSettings() {
  try { await api('POST', '/api/settings', state.settings); } catch (e) {}
}

/* ---------------------------------------------------------------- menus */

const ACTIONS = {};

function action(id, label, accel, fn, enabled) {
  ACTIONS[id] = { id, label, accel, fn, enabled: enabled || (() => true) };
  return ACTIONS[id];
}

const MENUS = {
  file: [
    { id: 'newproject', label: 'New Project', accel: 'Ctrl+Alt+Shift+N' },
    { id: 'open', label: 'Open Folder...', accel: 'Ctrl+K Ctrl+O' },
    { id: 'openWorkspace', label: 'Open Workspace Root' },
    { sep: true },
    { id: 'save', label: 'Save', accel: 'Ctrl+S' },
    { id: 'saveall', label: 'Save All', accel: 'Ctrl+Alt+S' },
    { sep: true },
    { id: 'settings', label: 'Settings...', accel: 'Ctrl+Alt+S' },
    { sep: true },
    { id: 'exit', label: 'Exit' },
  ],
  edit: [
    { id: 'undo', label: 'Undo', accel: 'Ctrl+Z' },
    { id: 'redo', label: 'Redo', accel: 'Ctrl+Y' },
    { sep: true },
    { id: 'cut', label: 'Cut', accel: 'Ctrl+X' },
    { id: 'copy', label: 'Copy', accel: 'Ctrl+C' },
    { id: 'paste', label: 'Paste', accel: 'Ctrl+V' },
    { sep: true },
    { id: 'find', label: 'Find...', accel: 'Ctrl+F' },
    { id: 'replace', label: 'Replace...', accel: 'Ctrl+H' },
    { id: 'findFiles', label: 'Find in Files...', accel: 'Ctrl+Shift+F' },
    { sep: true },
    { id: 'comment', label: 'Comment with Line Comment', accel: 'Ctrl+/' },
    { id: 'duplicate', label: 'Duplicate Line', accel: 'Ctrl+D' },
    { id: 'deleteline', label: 'Delete Line', accel: 'Ctrl+Shift+Y' },
  ],
  view: [
    { id: 'v-project', label: 'Project Tool Window', accel: 'Alt+1', check: 'view-project' },
    { id: 'v-search', label: 'Find Tool Window', accel: 'Alt+2', check: 'view-search' },
    { id: 'v-problems', label: 'Problems Tool Window', accel: 'Alt+6', check: 'view-problems' },
    { id: 'v-structure', label: 'Structure Tool Window', accel: 'Alt+7', check: 'view-structure' },
    { id: 'v-git', label: 'Version Control', accel: 'Alt+9', check: 'view-git' },
    { sep: true },
    { id: 'v-bottom', label: 'Hide Tool Windows', accel: 'Ctrl+Shift+F12' },
  ],
  navigate: [
    { id: 'goto-file', label: 'Go to File...', accel: 'Ctrl+P' },
    { id: 'goto-symbol', label: 'Go to Symbol...', accel: 'Ctrl+Alt+Shift+N' },
    { id: 'goto-line', label: 'Go to Line...', accel: 'Ctrl+G' },
    { id: 'recent', label: 'Recent Files', accel: 'Ctrl+E' },
    { id: 'lastedit', label: 'Last Edit Location', accel: 'Ctrl+Shift+Backspace' },
  ],
  code: [
    { id: 'complete', label: 'C++ IntelliSense Completion', accel: 'Ctrl+Space' },
    { id: 'definition', label: 'Go to Definition', accel: 'F12' },
    { id: 'rename-symbol', label: 'Rename Symbol', accel: 'F2' },
    { id: 'quick-fix', label: 'Quick Fix', accel: 'Ctrl+.' },
    { id: 'format-document', label: 'Format Document', accel: 'Ctrl+Alt+L' },
    { id: 'show-hover', label: 'Show C++ Information', accel: 'Ctrl+Alt+I' },
    { id: 'signature-help', label: 'Signature Help', accel: 'Ctrl+Shift+Space' },
    { id: 'comment', label: 'Comment with Line Comment', accel: 'Ctrl+/' },
    { id: 'duplicate', label: 'Duplicate Line', accel: 'Ctrl+D' },
    { id: 'newfile', label: 'New File from Template...', accel: 'Alt+Insert' },
  ],
  build: [
    { id: 'build', label: 'Build Project', accel: 'Ctrl+F9' },
    { id: 'rebuild', label: 'Rebuild Project' },
    { id: 'clean', label: 'Clean Project' },
  ],
  run: [
    { id: 'run', label: 'Run', accel: 'Shift+F10' },
    { id: 'runconfig', label: 'Edit Configurations...', accel: 'Alt+Shift+F10' },
    { id: 'debug', label: 'Debug', accel: 'F5' },
    { id: 'stop', label: 'Stop', accel: 'Ctrl+F2' },
    { sep: true },
    { id: 'togglebp', label: 'Toggle Breakpoint', accel: 'Ctrl+F8' },
    { id: 'viewbps', label: 'View Breakpoints', accel: 'Ctrl+Shift+F8' },
  ],
  tools: [
    { id: 'terminal', label: 'Terminal', accel: 'Alt+F12' },
    { sep: true },
    { id: 'gitcommit', label: 'Git: Commit...' },
    { id: 'gitinit', label: 'Git: Init Repository' },
    { id: 'gitrefresh', label: 'Git: Refresh Status' },
  ],
  window: [
    { id: 'w-editor', label: 'Editor' },
    { id: 'w-bottom', label: 'Bottom Tool Window' },
  ],
  help: [
    { id: 'about', label: 'About FullIDE' },
    { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  ],
};

function buildMenus() {
  for (const item of $$('.menu-item')) {
    const name = item.dataset.menu;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.classList.contains('open')) { closeMenus(); return; }
      showMenuPopup(name, item);
    });
    item.addEventListener('mouseenter', () => {
      if ($('.menu-item.open') && !item.classList.contains('open')) {
        closeMenus();
        showMenuPopup(name, item);
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-popup') && !e.target.closest('.menu-item')) closeMenus();
  });
}

function showMenuPopup(name, anchor) {
  closeMenus();
  anchor.classList.add('open');
  const popup = $('menu-popup');
  popup.innerHTML = '';
  for (const entry of MENUS[name]) {
    if (entry.sep) {
      popup.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const a = ACTIONS[entry.id];
    const div = document.createElement('div');
    div.className = 'menu-entry';
    const en = a && a.enabled();
    if (!en) div.classList.add('disabled');
    if (entry.check) {
      const view = $('' + entry.check);
      if (view && view.classList.contains('active')) {
        div.innerHTML = '<span class="check">✓</span>';
      }
    }
    div.insertAdjacentHTML('beforeend', '<span>' + esc(entry.label) + '</span>');
    if (entry.accel) div.insertAdjacentHTML('beforeend', '<span class="accel">' + esc(entry.accel) + '</span>');
    if (en && a) {
      div.addEventListener('click', () => { closeMenus(); a.fn(); });
    }
    popup.appendChild(div);
  }
  const r = anchor.getBoundingClientRect();
  popup.style.left = r.left + 'px';
  popup.style.top = (r.bottom + 2) + 'px';
  popup.classList.remove('hidden');
}

function closeMenus() {
  $('menu-popup').classList.add('hidden');
  $$('.menu-item.open').forEach((m) => m.classList.remove('open'));
}

/* ---------------------------------------------------------------- modals */

function showModal(title, bodyHTML, actions) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHTML;
    const actionsEl = $('modal-actions');
    actionsEl.innerHTML = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn' + (a.primary ? ' primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        if (a.validate && !a.validate()) return;
        $('modal-backdrop').classList.add('hidden');
        resolve(a.value !== undefined ? a.value : (a.id ? a.id : true));
      });
      actionsEl.appendChild(btn);
    }
    $('modal-backdrop').classList.remove('hidden');
    const first = $('modal-body').querySelector('input,select,textarea');
    if (first) first.focus();
  });
}

function closeModal() { $('modal-backdrop').classList.add('hidden'); }

/* ---------------------------------------------------------------- folder browser */

async function openFolderBrowser(startPath, title, onPick) {
  let current = startPath || state.root || (await api('GET', '/api/env')).workspace;
  let resolved = false;

  const renderList = async (toPath) => {
    if (toPath) current = toPath;
    let data;
    try { data = await api('GET', '/api/dirs?path=' + encodeURIComponent(current)); }
    catch (e) {
      $('modal-body').innerHTML = '<div style="color:var(--err)">Cannot open path: ' + esc(e.message) + '</div>';
      return;
    }
    current = data.path;
    let html = '<div class="field"><label>Folder path</label><input id="fb-path" value="' + esc(data.path) + '"></div>';
    html += '<div id="fb-list" style="height:260px;overflow:auto;border:1px solid var(--border);border-radius:4px;background:var(--bg)">';
    if (data.parent) html += '<div class="tree-node" data-path="' + esc(data.parent) + '"><span class="ticon">⬆</span><span class="tname">..</span></div>';
    html += '<div class="tree-node" data-self="1"><span class="ticon" style="color:var(--accent)">✓</span><span class="tname"><b>Select "' + esc(data.path.split(/[\\/]/).pop()) + '"' + (data.hasCMake ? ' (CMake project)' : '') + '</b></span></div>';
    for (const d of data.dirs) {
      html += '<div class="tree-node" data-path="' + esc(d.path) + '"><span class="ticon">📁</span><span class="tname">' + esc(d.name) + '</span></div>';
    }
    html += '</div>';
    $('modal-body').innerHTML = html;
    $('fb-path').addEventListener('change', (e) => {
      const p = e.target.value.trim();
      if (p) renderList(p);
    });
    $('fb-list').addEventListener('click', (e) => {
      const node = e.target.closest('.tree-node');
      if (!node) return;
      if (node.dataset.self) { doPick(data.path); return; }
      renderList(node.dataset.path);
    });
  };

  const doPick = (p) => {
    if (resolved) return;
    resolved = true;
    closeModal();
    onPick(p);
  };

  const modalPromise = showModal(title || 'Open Folder', '<div class="field"><label>Loading...</label></div>', [
    { label: 'Cancel', value: null },
    {
      label: 'Open', primary: true,
      validate: () => {
        const v = $('fb-path') && $('fb-path').value.trim();
        if (!v) return false;
        doPick(v);
        return true;
      },
      value: null,
    },
  ]);
  await renderList();
  await modalPromise;
}

/* ---------------------------------------------------------------- new project */

async function newProjectDialog() {
  const tpls = TEMPLATES.list().projects;
  let selected = tpls[0].id;
  const env = await api('GET', '/api/env');
  const html = `
    <div class="field">
      <label>Project name &amp; location</label>
      <input id="np-name" placeholder="MyGame" value="">
    </div>
    <div class="field">
      <label>Location</label>
      <input id="np-path" value="${esc(env.workspace)}">
    </div>
    <div class="field"><label>Template</label></div>
    <div class="tpl-grid">
      ${tpls.map((t, i) => `
        <div class="tpl-card${i === 0 ? ' selected' : ''}" data-tpl="${t.id}">
          <div class="tpl-lang">${esc(t.lang)}</div>
          <div class="tpl-name">${esc(t.name)}</div>
          <div class="tpl-desc">${esc(t.desc)}</div>
        </div>`).join('')}
    </div>
    ${env.tools.raylib ? '<div style="margin-top:10px;color:var(--ok)">✔ raylib detected — Raylib templates will build out of the box</div>'
                       : '<div style="margin-top:10px;color:var(--warn)">⚠ raylib not detected — Raylib templates need RAYLIB_PATH</div>'}
  `;
  const modalPromise = showModal('New Project', html, [
    { label: 'Cancel', value: null },
    {
      label: 'Create', primary: true,
      validate: () => {
        const name = $('np-name').value.trim();
        if (!/^[A-Za-z0-9 _.-]+$/.test(name)) { $('np-name').style.borderColor = 'var(--err)'; return false; }
        closeModal();
        createProject(name, $('np-path').value.trim(), selected);
        return true;
      },
      value: null,
    },
  ]);
  $$('.tpl-card').forEach((c) => c.addEventListener('click', () => {
    $$('.tpl-card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    selected = c.dataset.tpl;
  }));
  $('np-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const name = $('np-name').value.trim();
      if (name) { closeModal(); createProject(name, $('np-path').value.trim(), selected); }
    }
  });
  await modalPromise;
}

async function createProject(name, rootPath, template) {
  if (!name) return;
  closeModal();
  logOut('Creating project ' + name + ' from template ' + template + '...', 'cmd-text');
  try {
    const r = await api('POST', '/api/newproject', { root: rootPath, name, template });
    logOut('Created ' + r.files + ' files at ' + r.path, 'ok-text');
    await setRoot(r.path);
    const main = findMainFile(r.path);
    if (main) openFile(main);
    buildProject();
  } catch (e) {
    logOut('Failed to create project: ' + e.message, 'err-text');
  }
}

function findMainFile(root) {
  const candidates = ['src/main.cpp', 'src/main.c', 'main.cpp', 'main.c', 'src/Main.cpp'];
  for (const c of candidates) {
    // existence check via tree data
    if (state.treeData) {
      const found = findInTree(state.treeData, c);
      if (found) return found;
    }
  }
  return null;
}

function findInTree(nodes, rel) {
  const parts = rel.split('/');
  let cur = nodes;
  let fullPath = null;
  for (let i = 0; i < parts.length; i++) {
    const n = cur.find((x) => x.name === parts[i]);
    if (!n) return null;
    if (i === parts.length - 1) return n.path;
    cur = n.children || [];
  }
  return null;
}

/* ---------------------------------------------------------------- project tree */

async function refreshTree() {
  if (!state.root) return;
  try {
    const data = await api('GET', '/api/tree?path=' + encodeURIComponent(state.root));
    state.treeData = data.children;
    renderTree();
    updateGitStatus();
  } catch (e) {
    $('tree').innerHTML = '<div style="padding:10px;color:var(--err)">' + esc(e.message) + '</div>';
  }
}

function renderTree() {
  const tree = $('tree');
  tree.innerHTML = '';
  if (!state.treeData) return;
  const renderNodes = (nodes, container, depth) => {
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'tree-node' + (node.type === 'dir' ? ' dir' : '');
      row.dataset.path = node.path;
      row.style.paddingLeft = (6 + depth * 14) + 'px';
      if (node.type === 'dir') {
        const open = state.expanded.has(node.path);
        row.innerHTML = '<span class="twisty">' + (open ? '▼' : '▶') + '</span>' +
          '<span class="ticon" style="color:var(--warn)">' + (open ? '📂' : '📁') + '</span>' +
          '<span class="tname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => {
          if (state.expanded.has(node.path)) state.expanded.delete(node.path);
          else state.expanded.add(node.path);
          renderTree();
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, [
            { label: 'New File Here...', fn: () => newFileTemplate(node.path) },
            { label: 'New Folder Here...', fn: () => newFolderDialog(node.path) },
            { sep: true },
            { label: 'Copy Path', fn: () => { navigator.clipboard.writeText(node.path).catch(() => {}); logOut('Copied: ' + node.path); } },
            { label: 'Open in Folder Browser', fn: () => openFolderBrowser(node.path, 'Open Folder', setRoot) },
          ]);
        });
        container.appendChild(row);
        if (open && node.children) {
          const kids = document.createElement('div');
          kids.className = 'tree-children open';
          renderNodes(node.children, kids, depth + 1);
          container.appendChild(kids);
        }
      } else {
        const ic = iconFor(node.name);
        row.innerHTML = '<span class="twisty"></span>' +
          '<span class="ticon" style="color:' + ic.color + '">' + ic.glyph + '</span>' +
          '<span class="tname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => {
          $$('.tree-node.selected').forEach((n) => n.classList.remove('selected'));
          row.classList.add('selected');
        });
        row.addEventListener('dblclick', () => openFile(node.path));
        row.addEventListener('contextmenu', (e) => showTreeContextMenu(e, node));
        container.appendChild(row);
      }
    }
  };
  renderNodes(state.treeData, tree, 0);
}

function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    cpp: ['C+', '#f34b7d'], cc: ['C+', '#f34b7d'], cxx: ['C+', '#f34b7d'],
    c: ['C', '#599eff'], h: ['H', '#599eff'], hpp: ['H+', '#f34b7d'], hxx: ['H+', '#f34b7d'],
    txt: ['T', '#808080'], cmake: ['CM', '#2ec4b6'], md: ['M', '#808080'],
    js: ['JS', '#e8d44d'], json: ['{}', '#e8d44d'], glsl: ['GL', '#b86bff'],
    vert: ['VS', '#b86bff'], frag: ['FS', '#b86bff'], exe: ['▶', '#629755'],
    dll: ['◆', '#629755'], lib: ['◆', '#629755'], a: ['◆', '#629755'],
    lua: ['L', '#599eff'], py: ['Py', '#599eff'], in: ['IN', '#808080'],
  };
  if (name === 'CMakeLists.txt') return { glyph: 'CM', color: '#2ec4b6' };
  if (name === 'Makefile') return { glyph: 'MK', color: '#2ec4b6' };
  if (name === '.gitignore') return { glyph: 'GI', color: '#808080' };
  return map[ext] || { glyph: '·', color: '#606360' };
}

function showTreeContextMenu(e, node) {
  e.preventDefault();
  const items = [
    { label: 'Open', fn: () => openFile(node.path) },
    { label: 'New File...', fn: () => newFileTemplate(path.dirname(node.path)) },
    { label: 'New Folder...', fn: () => newFolderDialog(path.dirname(node.path)) },
    { sep: true },
    { label: 'Rename...', fn: () => renameDialog(node) },
    { label: 'Delete', fn: () => deleteDialog(node) },
    { sep: true },
    { label: 'Copy Path', fn: () => { navigator.clipboard.writeText(node.path).catch(() => {}); logOut('Copied: ' + node.path); } },
    { label: 'Reveal in Folder Browser', fn: () => openFolderBrowser(path.dirname(node.path), 'Open Folder', setRoot) },
  ];
  showContextMenu(e.clientX, e.clientY, items);
}

function showContextMenu(x, y, items) {
  const menu = $('ctx-menu');
  menu.innerHTML = '';
  for (const item of items) {
    if (item.sep) { menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' })); continue; }
    const div = document.createElement('div');
    div.className = 'menu-entry';
    div.textContent = item.label;
    div.addEventListener('click', () => { closeContextMenu(); item.fn(); });
    menu.appendChild(div);
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  setTimeout(() => {
    const r = menu.getBoundingClientRect();
    if (r.bottom > innerHeight) menu.style.top = (innerHeight - r.height - 4) + 'px';
    if (r.right > innerWidth) menu.style.left = (innerWidth - r.width - 4) + 'px';
  }, 0);
}

function closeContextMenu() { $('ctx-menu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu')) closeContextMenu(); });

async function newFolderDialog(dir) {
  const res = await showModal('New Folder', `
    <div class="field"><label>Name</label><input id="nf-name" placeholder="folder name"></div>
    <div class="field"><label>Location</label><input value="${esc(dir)}" disabled></div>
  `, [
    { label: 'Cancel', value: null },
    {
      label: 'Create', primary: true,
      validate: () => {
        const name = $('nf-name').value.trim();
        if (!name) return false;
        api('POST', '/api/create', { path: pathJoin(dir, name), kind: 'dir' })
          .then(() => { refreshTree(); logOut('Created folder ' + name); })
          .catch((e) => logOut(e.message, 'err-text'));
        return true;
      },
      value: null,
    },
  ]);
}

async function newFileTemplate(dir) {
  const fileTemplates = TEMPLATES.list().files;
  const html = `
    <div class="field"><label>File name</label><input id="nft-name" placeholder="main.cpp"></div>
    <div class="field"><label>Template</label>
      <select id="nft-tpl">
        <option value="">— Empty file —</option>
        ${fileTemplates.map((f) => '<option value="' + f.id + '">' + esc(f.name) + '</option>').join('')}
      </select>
    </div>
    <div class="field"><label>Location</label><input value="${esc(dir)}" disabled></div>
  `;
  await showModal('New File', html, [
    { label: 'Cancel', value: null },
    {
      label: 'Create', primary: true,
      validate: () => {
        const name = $('nft-name').value.trim();
        const tplId = $('nft-tpl').value;
        if (!name) return false;
        (async () => {
          try {
            if (tplId) {
              const files = TEMPLATES.fileContent(tplId, name.replace(/\.[^.]+$/, ''));
              for (const f of files) {
                const fp = pathJoin(dir, f.name);
                await api('POST', '/api/save', { path: fp, content: f.content });
                if (f.name === name || files.length === 1) openFile(fp);
              }
              logOut('Created ' + files.length + ' file(s) from template', 'ok-text');
            } else {
              const fp = pathJoin(dir, name);
              await api('POST', '/api/create', { path: fp, kind: 'file' });
              openFile(fp);
            }
            refreshTree();
          } catch (e) { logOut(e.message, 'err-text'); }
        })();
        return true;
      },
      value: null,
    },
  ]);
}

async function renameDialog(node) {
  const res = await showModal('Rename', `
    <div class="field"><label>New name</label><input id="rn-name" value="${esc(node.name)}"></div>
  `, [
    { label: 'Cancel', value: null },
    {
      label: 'Rename', primary: true,
      validate: () => {
        const name = $('rn-name').value.trim();
        if (!name) return false;
        const to = pathJoin(path.dirname(node.path), name);
        api('POST', '/api/rename', { from: node.path, to })
          .then(() => {
            if (state.files.has(node.path)) {
              const f = state.files.get(node.path);
              state.files.delete(node.path);
              state.files.set(to, f);
              f.editor.path = to;
              f.editor.dirty = true;
              renderTabs();
            }
            refreshTree();
          })
          .catch((e) => logOut(e.message, 'err-text'));
        return true;
      },
      value: null,
    },
  ]);
}

async function deleteDialog(node) {
  const res = await showModal('Delete', `
    <div style="font-size:13px">Delete <b>${esc(node.name)}</b>${node.type === 'dir' ? ' and all its contents' : ''}?</div>
    <div style="color:var(--fg-dim);margin-top:6px">${esc(node.path)}</div>
  `, [
    { label: 'Cancel', value: null },
    {
      label: 'Delete', primary: true,
      validate: () => {
        api('POST', '/api/delete', { path: node.path })
          .then(() => {
            if (state.files.has(node.path)) closeFile(node.path);
            refreshTree();
            logOut('Deleted ' + node.path);
          })
          .catch((e) => logOut(e.message, 'err-text'));
        return true;
      },
      value: null,
    },
  ]);
}

/* ---------------------------------------------------------------- tabs & editors */

function pathJoin(a, b) {
  if (!a) return b;
  return a.replace(/[\\/]+$/, '') + '\\' + b;
}

async function openFile(p) {
  p = path.resolve(p);
  if (state.files.has(p)) {
    switchTo(p);
    return;
  }
  let data;
  try { data = await api('GET', '/api/file?path=' + encodeURIComponent(p)); }
  catch (e) { logOut('Cannot open ' + p + ': ' + e.message, 'err-text'); return; }
  if (data.binary) { logOut(p + ' is binary (' + data.size + ' bytes) — cannot edit', 'warn-text'); return; }

  const editor = new Editor($('editor-host'), {
    onChange: (ed) => {
      updateTabDirty(ed);
      queueClangdChange(ed);
    },
    onCursor: (ed) => updateStatusBar(),
    onBreakpointToggle: (ed, line) => {
      ed.toggleBreakpoint(line);
      if (state.debug) {
        if (ed.breakpoints.has(line)) debugInsertBreakpoint(ed, line);
        else debugRemoveBreakpoint(ed, line);
      }
    },
  });
  editor.tabSize = state.settings.tabSize;
  editor.setValue(data.content, p);
  editor.ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Go to Definition (F12)', fn: gotoDefinition },
      { label: 'Rename Symbol (F2)', fn: renameSymbol },
      { label: 'Quick Fix (Ctrl+.)', fn: codeActions },
      { label: 'Format Document (Ctrl+Alt+L)', fn: formatDocument },
      { label: 'Show C++ Info (Ctrl+Alt+I)', fn: showHover },
    ]);
  });

  const name = path.basename(p);
  const tab = document.createElement('div');
  tab.className = 'etab';
  tab.innerHTML = '<span class="ticon" style="margin-right:2px;color:' + iconFor(name).color + '">' + iconFor(name).glyph + '</span>' +
    '<span class="etab-name">' + esc(name) + '</span><span class="dirty hidden">●</span><span class="close">✕</span>';
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) { closeFile(p); return; }
    switchTo(p);
  });
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Close', fn: () => closeFile(p) },
      { label: 'Close Others', fn: () => { for (const k of [...state.files.keys()]) if (k !== p) closeFile(k); } },
      { label: 'Close All', fn: () => { for (const k of [...state.files.keys()]) closeFile(k); } },
      { sep: true },
      { label: 'Copy Path', fn: () => navigator.clipboard.writeText(p).catch(() => {}) },
    ]);
  });

  state.files.set(p, { editor, tab, name });
  $('editor-tabs').appendChild(tab);
  switchTo(p);
  refreshStructure();
  $('welcome-screen').classList.add('hidden');
  if (clangdLanguageId(p)) {
    ensureClangd()
      .then((ready) => ready && notifyClangdDocument('textDocument/didOpen', editor))
      .catch((e) => logOut('clangd could not open ' + p + ': ' + e.message, 'err-text'));
  }
}

function switchTo(p) {
  state.active = p;
  for (const [fp, f] of state.files) {
    f.editor.el.classList.toggle('active', fp === p);
    f.tab.classList.toggle('active', fp === p);
  }
  if (state.files.has(p)) {
    const f = state.files.get(p);
    f.editor.focus();
    updateStatusBar();
    refreshStructure();
    updateFindbarVisibility();
  }
}

function closeFile(p) {
  const f = state.files.get(p);
  if (!f) return;
  if (f.editor.isModified() && !confirmSave(p)) return;
  cancelClangdChange(p);
  if (f.editor.path && state.clangd.id) {
    notifyClangdDocument('textDocument/didClose', f.editor).then(() => {
      state.clangd.diagnostics.delete(f.editor.path);
      applyDiagnostics();
      updateProblemCounts();
    }).catch((e) => logOut('clangd document close failed: ' + e.message, 'err-text'));
  }
  f.editor.dispose();
  f.tab.remove();
  state.files.delete(p);
  if (state.active === p) {
    state.active = null;
    const next = [...state.files.keys()].pop();
    if (next) switchTo(next);
    else $('welcome-screen').classList.remove('hidden');
  }
}

function confirmSave(p) {
  // simple: auto-save on close like CLion's default
  saveFile(p);
  return true;
}

function updateTabDirty(ed) {
  for (const [fp, f] of state.files) {
    if (f.editor === ed) {
      f.tab.querySelector('.dirty').classList.toggle('hidden', !ed.isModified());
      break;
    }
  }
}

function renderTabs() {
  for (const [p, f] of state.files) {
    f.tab.querySelector('.etab-name').textContent = path.basename(p);
    f.tab.querySelector('.dirty').classList.toggle('hidden', !f.editor.isModified());
  }
}

async function saveFile(p) {
  const f = state.files.get(p || state.active);
  if (!f) return;
  try {
    await api('POST', '/api/save', { path: f.editor.path, content: f.editor.getValue() });
    f.editor.markSaved();
    notifyClangdDocument('textDocument/didSave', f.editor)
      .catch((e) => logOut('clangd save notification failed: ' + e.message, 'err-text'));
    updateTabDirty(f.editor);
    updateStatusBar();
    logOut('Saved ' + f.editor.path);
  } catch (e) {
    logOut('Save failed: ' + e.message, 'err-text');
  }
}

function saveAll() {
  for (const [p, f] of state.files) if (f.editor.isModified()) saveFile(p);
}

/* ---------------------------------------------------------------- status bar */

function updateStatusBar() {
  updateClangdStatus();
  const ed = activeEditor();
  if (!ed) {
    $('st-pos').textContent = '';
    $('st-lang').textContent = '';
    return;
  }
  const pos = ed.cursorPos();
  $('st-pos').textContent = 'Ln ' + pos.line + ', Col ' + pos.col;
  const ext = (ed.path || '').split('.').pop().toLowerCase();
  const langMap = { cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C/C++ Header', hpp: 'C++ Header', hxx: 'C++ Header', txt: 'Plain Text', cmake: 'CMake', md: 'Markdown' };
  $('st-lang').textContent = langMap[ext] || ext.toUpperCase();
}

function activeEditor() {
  const f = state.files.get(state.active);
  return f ? f.editor : null;
}

function updateProblemCounts() {
  const diags = allDiagnostics();
  const errs = diags.filter((d) => d.severity === 'error').length;
  const warns = diags.filter((d) => d.severity === 'warning').length;
  $('st-errors').textContent = errs ? '✕ ' + errs : '';
  $('st-warnings').textContent = warns ? '⚠ ' + warns : '';
}

function clangdLanguageId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.c') return 'c';
  if (['.cc', '.cpp', '.cxx', '.c++', '.h', '.hh', '.hpp', '.hxx', '.h++'].includes(ext)) return 'cpp';
  return null;
}

function clangdUri(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return 'file:///' + normalized.split('/').map((part, index) =>
    index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
}

function clangdPath(uri) {
  const parsed = new URL(uri);
  let value = decodeURIComponent(parsed.pathname);
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  return value.replace(/\//g, '\\');
}

function updateClangdStatus() {
  const el = $('st-clangd');
  if (!el) return;
  const status = state.clangd.status;
  el.className = status === 'ready' ? 'ready' : (status === 'missing' || status === 'failed' ? status : '');
  el.textContent = status === 'ready' ? 'clangd' :
    (status === 'starting' ? 'clangd starting…' :
      (status === 'missing' ? 'clangd unavailable' : (status === 'failed' ? 'clangd error' : 'clangd stopped')));
  el.title = status === 'missing'
    ? 'Install clangd and add clangd.exe to PATH, or configure FULLIDE_CLANGD before restarting FullIDE.'
    : (state.clangd.root ? 'clangd: ' + status + ' — ' + state.clangd.root : 'clangd language server: ' + status);
}

async function stopClangd() {
  const { id, es, changeTimers } = state.clangd;
  for (const timer of changeTimers.values()) clearTimeout(timer);
  changeTimers.clear();
  if (es) es.close();
  if (id) {
    try { await api('POST', '/api/clangd/' + id + '/stop', {}); }
    catch (e) { logOut('Could not stop clangd cleanly: ' + e.message, 'warn-text'); }
  }
  state.clangd.id = null;
  state.clangd.es = null;
  state.clangd.root = null;
  state.clangd.status = state.tools.clangd ? 'stopped' : 'missing';
  state.clangd.versions.clear();
  state.clangd.opened.clear();
  state.clangd.diagnostics.clear();
  updateClangdStatus();
}

async function ensureClangd() {
  if (!state.root) return false;
  if (!state.tools.clangd) {
    state.clangd.status = 'missing';
    updateClangdStatus();
    if (!state.clangd.missingReported) {
      state.clangd.missingReported = true;
      logOut('clangd was not detected. Install clangd.exe, add it to PATH (or set FULLIDE_CLANGD), then restart FullIDE to enable C/C++ IntelliSense.', 'warn-text');
    }
    return false;
  }
  if (state.clangd.id && state.clangd.root === state.root &&
      (state.clangd.status === 'ready' || state.clangd.status === 'starting')) return true;
  if (state.clangd.starting) {
    await state.clangd.starting;
    if (state.clangd.id && state.clangd.root === state.root) return true;
  }
  if (state.clangd.id || state.clangd.es) await stopClangd();

  const root = state.root;
  state.clangd.root = root;
  state.clangd.status = 'starting';
  updateClangdStatus();
  state.clangd.starting = (async () => {
    try {
      const result = await api('POST', '/api/clangd/start', { root });
      if (state.root !== root) {
        await api('POST', '/api/clangd/' + result.id + '/stop', {}).catch(() => {});
        return false;
      }
      state.clangd.id = result.id;
      const es = new EventSource('/api/clangd/' + result.id + '/stream');
      state.clangd.es = es;
      es.addEventListener('message', (event) => {
        if (state.clangd.id !== result.id) return;
        let message;
        try { message = JSON.parse(event.data); }
        catch (e) { logOut('Invalid clangd event: ' + e.message, 'err-text'); return; }
        if (message.type === 'status') {
          state.clangd.status = message.status;
          updateClangdStatus();
          if (message.status === 'ready') {
            for (const [, file] of state.files) notifyClangdDocument('textDocument/didOpen', file.editor).catch(() => {});
          } else if (message.status === 'failed') {
            logOut('clangd failed: ' + (message.message || 'unknown error'), 'err-text');
          }
        } else if (message.type === 'diagnostics') {
          updateClangdDiagnostics(message.params);
        } else if (message.type === 'log' && message.message && message.severity <= 1) {
          logOut('clangd: ' + message.message, 'warn-text');
        } else if (message.type === 'error') {
          state.clangd.status = 'failed';
          updateClangdStatus();
          logOut('clangd protocol error: ' + message.message, 'err-text');
        }
      });
      state.clangd.status = result.status;
      updateClangdStatus();
      return true;
    } catch (e) {
      if (state.root === root) {
        state.clangd.status = 'failed';
        updateClangdStatus();
      }
      logOut('Failed to start clangd: ' + e.message, 'err-text');
      return false;
    }
  })();
  try { return await state.clangd.starting; }
  finally { state.clangd.starting = null; }
}

function updateClangdDiagnostics(params) {
  let fp;
  try { fp = clangdPath(params.uri); }
  catch (e) { logOut('clangd sent an invalid diagnostic URI: ' + e.message, 'err-text'); return; }
  if (params.diagnostics && params.diagnostics.length) {
    state.clangd.diagnostics.set(fp, params.diagnostics.map((d) => ({
      file: fp,
      line: d.range.start.line + 1,
      col: d.range.start.character + 1,
      severity: ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' })[d.severity] || 'info',
      message: d.message,
      source: d.source || 'clangd',
      code: d.code,
      lspDiagnostic: d,
    })));
  } else {
    state.clangd.diagnostics.delete(fp);
  }
  applyDiagnostics();
  updateProblemCounts();
}

function allDiagnostics() {
  return state.build.diagnostics.concat(...state.clangd.diagnostics.values());
}

function queueClangdChange(editor) {
  if (!editor.path || !clangdLanguageId(editor.path) || !state.clangd.id) return;
  cancelClangdChange(editor.path);
  const timer = setTimeout(() => {
    state.clangd.changeTimers.delete(editor.path);
    notifyClangdDocument('textDocument/didChange', editor).catch((e) => {
      logOut('clangd document sync failed: ' + e.message, 'err-text');
    });
  }, 120);
  state.clangd.changeTimers.set(editor.path, timer);
}

function cancelClangdChange(filePath) {
  const timer = state.clangd.changeTimers.get(filePath);
  if (timer) clearTimeout(timer);
  state.clangd.changeTimers.delete(filePath);
}

async function notifyClangdDocument(method, editor) {
  const languageId = clangdLanguageId(editor.path);
  if (!languageId || !state.root) return;
  if (!state.clangd.id && !(await ensureClangd())) return;
  const uri = clangdUri(editor.path);
  if (method === 'textDocument/didOpen' && state.clangd.opened.has(uri)) return;
  if (method === 'textDocument/didClose' && !state.clangd.opened.has(uri)) return;
  const version = (state.clangd.versions.get(uri) || 0) + 1;
  state.clangd.versions.set(uri, version);
  const textDocument = { uri, version };
  let params;
  if (method === 'textDocument/didOpen') {
    params = { textDocument: Object.assign(textDocument, { languageId, text: editor.getValue() }) };
  } else if (method === 'textDocument/didChange') {
    params = { textDocument, contentChanges: [{ text: editor.getValue() }] };
  } else if (method === 'textDocument/didSave') {
    params = { textDocument, text: editor.getValue() };
  } else {
    params = { textDocument: { uri } };
  }
  const sessionId = state.clangd.id;
  if (method === 'textDocument/didOpen') state.clangd.opened.add(uri);
  try {
    await api('POST', '/api/clangd/' + sessionId + '/notify', { method, params });
    if (method === 'textDocument/didClose') state.clangd.opened.delete(uri);
  } catch (e) {
    if (method === 'textDocument/didOpen') state.clangd.opened.delete(uri);
    throw e;
  }
}

function lspPosition(editor, index) {
  const cursor = index === undefined ? editor.ta.selectionStart : index;
  const before = editor.text.slice(0, cursor);
  return { line: before.split('\n').length - 1, character: cursor - before.lastIndexOf('\n') - 1 };
}

function offsetAtPosition(text, position) {
  const lines = text.split('\n');
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + Math.min(position.character, lines[line].length);
}

async function clangdRequest(method, params) {
  if (!(await ensureClangd()) || !state.clangd.id) return null;
  try {
    const response = await api('POST', '/api/clangd/' + state.clangd.id + '/request', { method, params });
    return response.result;
  } catch (e) {
    logOut('clangd ' + method + ' failed: ' + e.message, 'err-text');
    return null;
  }
}

function applyTextEdits(editor, edits) {
  if (!edits || !edits.length) return false;
  const text = applyTextEditsToText(editor.getValue(), edits);
  if (text === editor.getValue()) return false;
  editor._replaceRange(0, editor.text.length, text);
  return true;
}

function applyTextEditsToText(content, edits) {
  const ordered = edits.map((edit) => ({
    start: offsetAtPosition(content, edit.range.start),
    end: offsetAtPosition(content, edit.range.end),
    text: edit.newText,
  })).sort((a, b) => b.start - a.start || b.end - a.end);
  let text = content;
  for (const edit of ordered) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function workspaceEditEntries(edit) {
  const entries = [];
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) entries.push({ uri, edits });
  }
  for (const change of edit.documentChanges || []) {
    if (change.textDocument && change.edits) entries.push({ uri: change.textDocument.uri, edits: change.edits });
  }
  return entries;
}

function isWorkspaceFile(filePath) {
  if (!state.root) return false;
  const candidate = path.resolve(filePath).toLowerCase();
  const root = path.resolve(state.root).toLowerCase().replace(/[\\/]+$/, '');
  return candidate === root || candidate.startsWith(root + '\\');
}

async function applyWorkspaceEdit(edit) {
  const changes = workspaceEditEntries(edit);
  const originalPath = state.active;
  let applied = 0;
  for (const change of changes) {
    if (!change.uri || !change.uri.startsWith('file:') || !change.edits) continue;
    const fp = path.resolve(clangdPath(change.uri));
    if (!isWorkspaceFile(fp)) continue;
    const normalizedPath = fp.toLowerCase();
    let openPath = null;
    for (const open of state.files.keys()) {
      if (open.toLowerCase() === normalizedPath) { openPath = open; break; }
    }
    if (openPath) {
      const file = state.files.get(openPath);
      if (applyTextEdits(file.editor, change.edits)) applied++;
      continue;
    }
    const data = await api('GET', '/api/file?path=' + encodeURIComponent(fp));
    if (data.binary) throw new Error('clangd edit targets a binary file: ' + fp);
    const content = data.content.replace(/\r\n?/g, '\n');
    const updated = applyTextEditsToText(content, change.edits);
    if (updated !== content) {
      await api('POST', '/api/save', { path: fp, content: updated });
      applied++;
    }
  }
  if (originalPath && state.files.has(originalPath)) switchTo(originalPath);
  return applied;
}

async function formatDocument() {
  const editor = activeEditor();
  if (!editor || !clangdLanguageId(editor.path)) return;
  try {
    const edits = await clangdRequest('textDocument/formatting', {
      textDocument: { uri: clangdUri(editor.path) },
      options: { tabSize: state.settings.tabSize, insertSpaces: true },
    });
    if (edits === null) return;
    if (!applyTextEdits(editor, edits)) logOut('clangd found no formatting changes', 'ok-text');
  } catch (e) { logOut('Could not format document: ' + e.message, 'err-text'); }
}

async function renameSymbol() {
  const editor = activeEditor();
  if (!editor || !clangdLanguageId(editor.path)) return;
  const word = editor.wordAt();
  if (!word) return;
  let newName = '';
  const accepted = await showModal('Rename Symbol', '<div class="field"><label>New name</label><input id="clangd-rename" value="' + esc(word.word) + '"></div>', [
    { label: 'Cancel', value: false },
    {
      label: 'Preview Rename', primary: true,
      validate: () => {
        newName = $('clangd-rename').value.trim();
        return /^[A-Za-z_]\w*$/.test(newName) && newName !== word.word;
      },
      value: true,
    },
  ]);
  if (!accepted || activeEditor() !== editor) return;
  const edit = await clangdRequest('textDocument/rename', {
    textDocument: { uri: clangdUri(editor.path) },
    position: lspPosition(editor),
    newName,
  });
  if (!edit) return;
  const targets = workspaceEditEntries(edit).filter((entry) =>
    entry.uri.startsWith('file:') && isWorkspaceFile(clangdPath(entry.uri)));
  if (!targets.length) {
    logOut('clangd found no references to rename.', 'warn-text');
    return;
  }
  const names = [...new Set(targets.map((entry) => clangdPath(entry.uri)))];
  const confirmed = await showModal('Confirm Rename', '<div>Rename <b>' + esc(word.word) + '</b> to <b>' + esc(newName) + '</b> in ' + targets.length + ' file(s)?</div><div style="margin-top:8px;color:var(--fg-dim)">' + names.map(esc).join('<br>') + '</div>', [
    { label: 'Cancel', value: false },
    { label: 'Apply Rename', primary: true, value: true },
  ]);
  if (!confirmed) return;
  try {
    const count = await applyWorkspaceEdit(edit);
    logOut('Renamed ' + word.word + ' to ' + newName + ' in ' + count + ' file(s). Review and save changed editor tabs.', 'ok-text');
  } catch (e) {
    logOut('Rename was only partially applied: ' + e.message, 'err-text');
  }
}

async function codeActions() {
  const editor = activeEditor();
  if (!editor || !clangdLanguageId(editor.path)) return;
  const start = lspPosition(editor, editor.ta.selectionStart);
  const end = lspPosition(editor, editor.ta.selectionEnd);
  const lineText = editor.lineText(start.line + 1);
  const range = start.line === end.line && start.character === end.character
    ? { start: { line: start.line, character: 0 }, end: { line: start.line, character: lineText.length } }
    : { start, end };
  const diagnostics = (editor.diagnostics || []).map((d) => d.lspDiagnostic).filter((d) =>
    d && d.range.start.line <= range.end.line && d.range.end.line >= range.start.line);
  const actions = await clangdRequest('textDocument/codeAction', {
    textDocument: { uri: clangdUri(editor.path) },
    range,
    context: { diagnostics, only: ['quickfix', 'refactor'] },
  });
  if (!actions || !actions.length) {
    logOut('clangd did not offer a quick fix here', 'warn-text');
    return;
  }
  showContextMenu(innerWidth / 2, innerHeight / 2, actions.slice(0, 12).map((item) => ({
    label: item.title || 'Apply code action',
    fn: async () => {
      if (!item.edit) {
        logOut('This clangd code action requires a command that FullIDE does not support yet.', 'warn-text');
        return;
      }
      try {
        const count = await applyWorkspaceEdit(item.edit);
        logOut('Applied code action in ' + count + ' file(s). Review and save the changes.', 'ok-text');
      } catch (e) {
        logOut('Could not fully apply the code action: ' + e.message, 'err-text');
      }
    },
  })));
}

async function showHover() {
  const editor = activeEditor();
  if (!editor || !clangdLanguageId(editor.path)) return;
  const hover = await clangdRequest('textDocument/hover', {
    textDocument: { uri: clangdUri(editor.path) },
    position: lspPosition(editor),
  });
  if (!hover || !hover.contents) return;
  const contents = Array.isArray(hover.contents) ? hover.contents.map((part) =>
    typeof part === 'string' ? part : part.value || '').join('\n\n') :
    (typeof hover.contents === 'string' ? hover.contents : hover.contents.value || '');
  if (!contents) return;
  showModal('C++ Information', '<pre style="white-space:pre-wrap;max-height:55vh;overflow:auto">' + esc(contents) + '</pre>', [
    { label: 'Close', primary: true, value: null },
  ]);
}

async function showSignatureHelp() {
  const editor = activeEditor();
  if (!editor || !clangdLanguageId(editor.path)) return;
  const help = await clangdRequest('textDocument/signatureHelp', {
    textDocument: { uri: clangdUri(editor.path) },
    position: lspPosition(editor),
    context: { triggerKind: 1, isRetrigger: false },
  });
  const signatures = help && help.signatures || [];
  if (!signatures.length) {
    logOut('clangd has no signature information at the cursor.', 'warn-text');
    return;
  }
  const selected = Math.max(0, Math.min(help.activeSignature || 0, signatures.length - 1));
  const signature = signatures[selected];
  const docs = typeof signature.documentation === 'string'
    ? signature.documentation
    : signature.documentation && signature.documentation.value || '';
  const label = typeof signature.label === 'string' ? signature.label : '';
  const parameter = signature.activeParameter === undefined ? help.activeParameter : signature.activeParameter;
  const parameterInfo = parameter !== undefined && signature.parameters && signature.parameters[parameter];
  const detail = parameterInfo && (typeof parameterInfo.documentation === 'string'
    ? parameterInfo.documentation
    : parameterInfo.documentation && parameterInfo.documentation.value);
  const content = [label, detail, docs].filter(Boolean).join('\n\n');
  showModal('C++ Signature', '<pre style="white-space:pre-wrap;max-height:55vh;overflow:auto">' + esc(content) + '</pre>', [
    { label: 'Close', primary: true, value: null },
  ]);
}

/* ---------------------------------------------------------------- build */

async function buildProject(rebuild) {
  if (!state.root) { logOut('No project open', 'warn-text'); return null; }
  if (state.build.running) return null;
  state.build.running = true;
  $('st-build').textContent = 'Building...';
  showBottom('build');
  setBuildOutput('=== Build started (' + new Date().toLocaleTimeString() + ') ===\n');
  try {
    if (rebuild) await api('POST', '/api/delete', { path: pathJoin(state.root, 'build') }).catch(() => {});
    const r = await api('POST', '/api/build', { root: state.root });
    setBuildOutput(r.output.trim());
    state.build.diagnostics = r.diagnostics || [];
    state.build.exePath = r.exePath;
    state.build.lastResult = r;
    if (r.ok) {
      $('st-build').textContent = 'Build finished (' + (r.duration || 0) + ' ms) — ' + (r.exePath ? path.basename(r.exePath) : '');
      setBuildOutput($('build-output').innerHTML + '\n<span class="ok-text">=== Build finished successfully (' + (r.duration || 0) + ' ms) ===</span>');
      logOut('Build OK: ' + (r.exePath || '(no executable)'), 'ok-text');
      if (r.exePath && !state.runConfig.exe) {
        state.runConfig.exe = r.exePath;
        state.runConfig.cwd = state.root;
      }
    } else {
      $('st-build').textContent = 'Build failed';
      setBuildOutput($('build-output').innerHTML + '\n<span class="err-text">=== Build failed ===</span>');
      logOut('Build FAILED', 'err-text');
    }
    applyDiagnostics();
  } catch (e) {
    setBuildOutput('Build error: ' + e.message);
    logOut('Build error: ' + e.message, 'err-text');
  } finally {
    state.build.running = false;
    updateProblemCounts();
  }
  return state.build.lastResult;
}

function applyDiagnostics() {
  const byFile = new Map();
  for (const d of allDiagnostics()) {
    if (!d.file) continue;
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }
  for (const [p, f] of state.files) {
    f.editor.setDiagnostics(byFile.get(p) || []);
  }
  renderProblems();
}

function renderProblems() {
  const list = $('problems-list');
  list.innerHTML = '';
  const diags = allDiagnostics();
  if (!diags.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--fg-dim)">No problems detected. Build the project (Ctrl+F9).</div>';
    return;
  }
  for (const d of diags) {
    const div = document.createElement('div');
    div.className = 'problem-item ' + d.severity;
    const loc = d.file ? path.basename(d.file) + ':' + d.line : 'linker';
    div.innerHTML = '<span class="picon">' + (d.severity === 'error' ? '✕' : '⚠') + '</span>' +
      '<span class="pmsg">' + esc(d.message) + '</span>' +
      '<span class="ploc">' + esc(loc) + '</span>';
    div.title = d.file || '';
    div.addEventListener('click', () => {
      if (d.file) openFile(d.file).then(() => {
        const f = state.files.get(d.file);
        if (f) f.editor.gotoLine(d.line);
      });
    });
    list.appendChild(div);
  }
}

/* ---------------------------------------------------------------- run */

async function runProject() {
  if (!state.root) { logOut('No project open', 'warn-text'); return; }
  if (!state.build.exePath) {
    const r = await buildProject();
    if (!r || !r.ok) return;
  }
  const exe = state.runConfig.exe || state.build.exePath;
  const cwd = state.runConfig.cwd || path.dirname(exe);
  const args = state.runConfig.args ? state.runConfig.args.split(/\s+/) : [];
  clearRunOutput();
  showBottom('run');
  appendRunOutput('▶ Running: ' + exe + (args.length ? ' ' + args.join(' ') : '') + '\n');
  try {
    const s = await api('POST', '/api/run', { exe, cwd, args });
    if (s.error) { appendRunOutput('Error: ' + s.error + '\n'); return; }
    state.run.session = s.id;
    state.run.running = true;
    if (state.run.es) state.run.es.close();
    const es = new EventSource('/api/run/' + s.id);
    state.run.es = es;
    es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'out') appendRunOutput(msg.text);
      else if (msg.type === 'exit') {
        appendRunOutput('\nProcess finished with exit code ' + msg.code + '\n');
        state.run.running = false;
        state.run.session = null;
        es.close();
      }
    });
  } catch (e) {
    appendRunOutput('Failed to start: ' + e.message + '\n');
  }
}

function stopRun() {
  if (state.run.session) {
    api('POST', '/api/run/' + state.run.session + '/stop').catch(() => {});
    appendRunOutput('\n■ Terminated by user\n');
    state.run.running = false;
    state.run.session = null;
    if (state.run.es) { state.run.es.close(); state.run.es = null; }
  }
  if (state.debug) stopDebug();
}

function editRunConfig() {
  const exe = state.runConfig.exe || state.build.exePath || '';
  showModal('Run / Debug Configuration', `
    <div class="field"><label>Executable</label><input id="rc-exe" value="${esc(exe)}"></div>
    <div class="field"><label>Program arguments</label><input id="rc-args" value="${esc(state.runConfig.args)}" placeholder="--map level1.dat"></div>
    <div class="field"><label>Working directory</label><input id="rc-cwd" value="${esc(state.runConfig.cwd || state.root || '')}"></div>
    <div style="color:var(--fg-dim);font-size:11.5px">FullIDE auto-builds before Run/Debug. Console games read input from the Run pane; graphical games open their own window.</div>
  `, [
    { label: 'Cancel', value: null },
    {
      label: 'OK', primary: true,
      validate: () => {
        state.runConfig.exe = $('rc-exe').value.trim();
        state.runConfig.args = $('rc-args').value.trim();
        state.runConfig.cwd = $('rc-cwd').value.trim();
        return true;
      },
      value: null,
    },
  ]);
}

/* ---------------------------------------------------------------- debug (gdb MI) */

function miUnescape(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseMIObject(s) {
  const p = new MIParser(s);
  return p.parseValue();
}

class MIParser {
  constructor(s) { this.s = s; this.i = 0; }
  skipWs() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  parseValue() {
    this.skipWs();
    const ch = this.s[this.i];
    if (ch === '"') return this.parseString();
    if (ch === '{') return this.parseTuple();
    if (ch === '[') return this.parseList();
    let v = '';
    while (this.i < this.s.length && /[^,\s{}\[\]"]/.test(this.s[this.i])) { v += this.s[this.i]; this.i++; }
    return v;
  }
  parseString() {
    this.i++; // opening quote
    let v = '';
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
        v += this.s[this.i] + this.s[this.i + 1];
        this.i += 2;
      } else { v += this.s[this.i]; this.i++; }
    }
    this.i++; // closing quote
    return miUnescape(v);
  }
  parseTuple() {
    this.i++; // {
    const out = {};
    while (true) {
      this.skipWs();
      if (this.i >= this.s.length || this.s[this.i] === '}') { this.i++; break; }
      let key = '';
      while (this.i < this.s.length && this.s[this.i] !== '=' && this.s[this.i] !== ',' && this.s[this.i] !== '}') {
        key += this.s[this.i]; this.i++;
      }
      this.skipWs();
      if (this.s[this.i] === '=') {
        this.i++;
        out[key] = this.parseValue();
      }
      this.skipWs();
      if (this.s[this.i] === ',') this.i++;
    }
    return out;
  }
  parseList() {
    this.i++; // [
    const out = [];
    while (true) {
      this.skipWs();
      if (this.i >= this.s.length || this.s[this.i] === ']') { this.i++; break; }
      out.push(this.parseValue());
      this.skipWs();
      if (this.s[this.i] === ',') this.i++;
    }
    return out;
  }
}

async function debugProject() {
  if (!state.root) { logOut('No project open', 'warn-text'); return; }
  if (!state.tools.gdb) { logOut('gdb not found — install GDB to debug', 'err-text'); return; }
  if (!state.build.exePath) {
    const r = await buildProject();
    if (!r || !r.ok) return;
  }
  const exe = state.runConfig.exe || state.build.exePath;
  const cwd = state.runConfig.cwd || state.root;
  const args = state.runConfig.args ? state.runConfig.args.split(/\s+/) : [];

  try {
    const s = await api('POST', '/api/debug/start', { exe, cwd, args });
    if (s.error) { logOut('Debug start failed: ' + s.error, 'err-text'); return; }
    state.debug = {
      id: s.id,
      bpNums: new Map(), // "file:line" -> gdb breakpoint number
      frames: [],
      vars: [],
      running: false,
      es: null,
    };
    showBottom('debug');
    $('dbg-status').textContent = 'Starting ' + path.basename(exe) + '...';
    appendRunOutput('▶ Debug session started (gdb)\n');
    state.debug.es = new EventSource('/api/debug/' + s.id);
    state.debug.es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'mi') handleMILine(msg.line);
      else if (msg.type === 'exit') {
        state.debug = null;
        $('dbg-status').textContent = 'Not debugging';
        for (const [, f] of state.files) f.editor.setDebugLine(null);
      }
    });
    // init sequence
    dbgSend('-file-exec-and-symbols "' + exe.replace(/\\/g, '/') + '"');
    dbgSend('-gdb-set mi-async off');
    // restore breakpoints from all editors
    for (const [fp, f] of state.files) {
      for (const line of f.editor.breakpoints) {
        dbgSend('-break-insert -f "' + fp.replace(/\\/g, '/') + ':' + line + '"');
      }
    }
    dbgSend('-exec-run');
  } catch (e) {
    logOut('Debug failed: ' + e.message, 'err-text');
  }
}

function dbgSend(mi) {
  if (!state.debug) return;
  api('POST', '/api/debug/' + state.debug.id + '/send', { mi }).catch(() => {});
}

function handleMILine(line) {
  if (!state.debug) return;
  const d = state.debug;

  if (line.startsWith('*stopped')) {
    const obj = parseMIObject(line.slice('*stopped'.length).replace(/^,/, ''));
    const reason = obj.reason || '';
    if (reason === 'exited' || reason === 'exited-normally' || reason === 'exited-signalled') {
      appendRunOutput('\n■ Program exited (code ' + (obj['exit-code'] || 0) + ')\n');
      $('dbg-status').textContent = 'Program exited';
      d.running = false;
      for (const [, f] of state.files) f.editor.setDebugLine(null);
      return;
    }
    if (reason === 'signal-received') {
      appendRunOutput('\n■ Signal received: ' + (obj.signal-name || 'unknown') + '\n');
      $('dbg-status').textContent = 'Signal: ' + (obj.signal-name || '');
    }
    d.running = false;
    $('dbg-status').textContent = 'Paused (' + reason + ')';
    if (obj.frame) {
      const fr = obj.frame;
      const file = fr.file || (fr['fullname'] || '').split('/').pop();
      const full = fr['fullname'] || file;
      const lineNo = parseInt(fr.line, 10);
      if (full && lineNo) {
        openFile(full).then(() => {
          const f = state.files.get(path.resolve(full));
          if (f) {
            for (const [, ff] of state.files) ff.editor.setDebugLine(null);
            f.editor.setDebugLine(lineNo);
            f.editor.gotoLine(lineNo);
          }
        });
      }
      $('dbg-status').textContent = 'Paused in ' + (fr.func || '?') + '() — ' + (fr.file || '?') + ':' + fr.line;
    }
    dbgSend('-stack-list-frames');
    dbgSend('-stack-list-variables --simple-values');
    return;
  }
  if (line.startsWith('^running')) {
    d.running = true;
    $('dbg-status').textContent = 'Running...';
    return;
  }
  if (line.startsWith('^done')) {
    const obj = parseMIObject(line.slice(5));
    if (obj.stack) {
      d.frames = obj.stack;
      renderFrames();
    }
    if (obj.variables) {
      d.vars = obj.variables;
      renderVariables();
    }
    if (obj.bkpt && obj.bkpt.number) {
      const key = (obj.bkpt['fullname'] || obj.bkpt.file || '') + ':' + obj.bkpt.line;
      d.bpNums.set(key, obj.bkpt.number);
      renderBreakpointsList();
    }
    return;
  }
  if (line.startsWith('^error')) {
    const m = /msg="(.*?)"/.exec(line);
    appendRunOutput('gdb error: ' + (m ? miUnescape(m[1]) : line) + '\n');
    return;
  }
  if (line.startsWith('~')) {
    const m = /^~"(.*)"$/.exec(line);
    if (m) appendRunOutput(miUnescape(m[1]));
    return;
  }
  if (line.startsWith('&')) {
    const m = /^&"(.*)"$/.exec(line);
    if (m) appendRunOutput(miUnescape(m[1]));
  }
}

function renderFrames() {
  const list = $('frames-list');
  list.innerHTML = '';
  for (let i = 0; i < state.debug.frames.length; i++) {
    const fr = state.debug.frames[i];
    const div = document.createElement('div');
    div.className = 'frame-item';
    div.innerHTML = '<span>#' + i + ' ' + esc(fr.func || '?') + '</span><span class="floc">' + esc(fr.file || '') + ':' + esc(fr.line || '') + '</span>';
    div.addEventListener('click', () => {
      const full = fr['fullname'] || fr.file;
      if (full) {
        openFile(full).then(() => {
          const f = state.files.get(path.resolve(full));
          if (f) f.editor.gotoLine(parseInt(fr.line, 10));
        });
      }
    });
    list.appendChild(div);
  }
}

function renderVariables() {
  const list = $('vars-list');
  list.innerHTML = '';
  const vars = state.debug.vars.filter((v) => v.name !== '...');
  if (!vars.length) {
    list.innerHTML = '<div style="padding:6px;color:var(--fg-dim);font-size:12px">No variables in scope</div>';
    return;
  }
  for (const v of vars) {
    const div = document.createElement('div');
    div.className = 'var-item';
    div.innerHTML = '<span class="vname">' + esc(v.name) + '</span><span class="vval">= ' + esc(String(v.value).slice(0, 120)) + '</span>';
    list.appendChild(div);
  }
}

function renderBreakpointsList() {
  const list = $('bps-list');
  list.innerHTML = '';
  let any = false;
  for (const [fp, f] of state.files) {
    for (const line of [...f.editor.breakpoints].sort((a, b) => a - b)) {
      any = true;
      const div = document.createElement('div');
      div.className = 'bp-item';
      div.innerHTML = '<span>🔴</span><span>' + esc(path.basename(fp)) + '</span><span class="bloc">line ' + line + '</span>';
      div.addEventListener('click', () => {
        openFile(fp).then(() => { const ff = state.files.get(fp); if (ff) ff.editor.gotoLine(line); });
      });
      list.appendChild(div);
    }
  }
  if (!any) list.innerHTML = '<div style="padding:6px;color:var(--fg-dim);font-size:12px">No breakpoints. Click the gutter to set one.</div>';
}

async function debugInsertBreakpoint(ed, line) {
  if (!state.debug) return;
  dbgSend('-break-insert -f "' + ed.path.replace(/\\/g, '/') + ':' + line + '"');
  renderBreakpointsList();
}

async function debugRemoveBreakpoint(ed, line) {
  if (!state.debug) return;
  const key = ed.path.replace(/\\/g, '/') + ':' + line;
  const num = state.debug.bpNums.get(key);
  if (num !== undefined) dbgSend('-break-delete ' + num);
  state.debug.bpNums.delete(key);
  renderBreakpointsList();
}

function debugStep(kind) {
  if (!state.debug) return;
  if (kind === 'over') dbgSend('-exec-next');
  else if (kind === 'into') dbgSend('-exec-step');
  else if (kind === 'resume') dbgSend('-exec-continue');
}

function stopDebug() {
  if (!state.debug) return;
  api('POST', '/api/debug/' + state.debug.id + '/stop').catch(() => {});
  if (state.debug.es) state.debug.es.close();
  state.debug = null;
  $('dbg-status').textContent = 'Not debugging';
  for (const [, f] of state.files) f.editor.setDebugLine(null);
  appendRunOutput('\n■ Debug session ended\n');
}

/* ---------------------------------------------------------------- terminal */

async function ensureTerminal() {
  const cwd = state.root || null;
  if (state.term.id && state.term.cwd === cwd) return;
  if (state.term.starting) {
    await state.term.starting;
    if (state.term.id && state.term.cwd === cwd) return;
  }
  if (state.term.id) {
    if (state.term.es) state.term.es.close();
    api('POST', '/api/term/' + state.term.id + '/kill', {}).catch(() => {});
    state.term.id = null;
    state.term.es = null;
    state.term.cwd = null;
  }
  state.term.starting = (async () => {
    try {
      const s = await api('POST', '/api/term', { cwd });
      state.term.id = s.id;
      state.term.cwd = cwd;
      state.term.shell = s.shell;
      $('term-input').placeholder = 'Send input to ' + s.shell;
      $('term-input').title = 'Shell: ' + s.shell + '\nDirectory: ' + s.cwd;
      const es = new EventSource('/api/term/' + s.id);
      state.term.es = es;
      es.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); }
        catch (err) {
          appendTermOutput('\r\nInvalid terminal event: ' + err.message + '\r\n');
          return;
        }
        if (msg.type === 'out' || msg.type === 'error') appendTermOutput(msg.text);
        else if (msg.type === 'exit') {
          es.close();
          if (state.term.id === s.id) {
            state.term.id = null;
            state.term.es = null;
            state.term.cwd = null;
          }
          appendTermOutput('\r\n[terminal process exited with code ' + msg.code + ']\r\n');
        }
      });
    } catch (e) {
      appendTermOutput('Terminal failed: ' + e.message + '\r\n');
    }
  })();
  try {
    await state.term.starting;
  } finally {
    state.term.starting = null;
  }
}

function appendTermOutput(text) {
  const el = $('terminal-output');
  el.insertAdjacentText('beforeend', text);
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

async function termSendLine() {
  const input = $('term-input');
  const line = input.value;
  input.value = '';
  await ensureTerminal();
  if (!state.term.id) return;
  if (line.trim()) {
    state.term.history.push(line);
    state.term.historyIndex = state.term.history.length;
    appendTermOutput('› ' + line + '\r\n');
  }
  const newline = /^(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i.test(state.term.shell) ? '\r\n' : '\n';
  try {
    await api('POST', '/api/term/' + state.term.id + '/write', { data: line + newline });
  } catch (e) {
    appendTermOutput('Terminal input failed: ' + e.message + '\r\n');
    input.value = line;
    input.focus();
  }
}

/* ---------------------------------------------------------------- search in files */

async function searchInFiles() {
  if (!state.root) return;
  const q = $('search-input').value;
  if (!q) return;
  const params = new URLSearchParams({ path: state.root, q });
  if ($('search-case').checked) params.set('case', '1');
  if ($('search-word').checked) params.set('word', '1');
  if ($('search-regex').checked) params.set('regex', '1');
  const r = await api('GET', '/api/search?' + params.toString());
  const list = $('search-results');
  list.innerHTML = '';
  if (r.error) { list.innerHTML = '<div style="padding:10px;color:var(--err)">' + esc(r.error) + '</div>'; return; }
  if (!r.results.length) { list.innerHTML = '<div style="padding:10px;color:var(--fg-dim)">No matches</div>'; return; }
  // group by file
  const groups = new Map();
  for (const res of r.results) {
    if (!groups.has(res.path)) groups.set(res.path, []);
    groups.get(res.path).push(res);
  }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('search-case').checked ? '' : 'i');
  for (const [fp, items] of groups) {
    const h = document.createElement('div');
    h.className = 'result-group-h';
    h.textContent = path.basename(fp) + ' — ' + fp;
    h.addEventListener('click', () => openFile(fp));
    list.appendChild(h);
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'result-item';
      const marked = esc(item.text).replace(re, (m) => '<mark>' + esc(m) + '</mark>');
      div.innerHTML = '<span class="rline">' + item.line + '</span><span>' + marked + '</span>';
      div.addEventListener('click', () => {
        openFile(fp).then(() => {
          const f = state.files.get(fp);
          if (f) {
            f.editor.gotoLine(item.line);
            f.editor.find(q, { caseSensitive: $('search-case').checked });
          }
        });
      });
      list.appendChild(div);
    }
  }
  logOut('Search: ' + r.results.length + ' matches for "' + q + '"');
}

async function replaceInFiles() {
  const q = $('search-input').value;
  const rep = $('search-replace').value;
  if (!q) return;
  const params = new URLSearchParams({ path: state.root, q });
  if ($('search-case').checked) params.set('case', '1');
  const r = await api('GET', '/api/search?' + params.toString());
  const files = new Set(r.results.map((x) => x.path));
  let count = 0;
  for (const fp of files) {
    const data = await api('GET', '/api/file?path=' + encodeURIComponent(fp));
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('search-case').checked ? 'g' : 'gi');
    const newContent = data.content.replace(re, rep);
    if (newContent !== data.content) {
      await api('POST', '/api/save', { path: fp, content: newContent });
      count++;
      if (state.files.has(fp)) {
        const editor = state.files.get(fp).editor;
        editor._replaceRange(0, editor.text.length, newContent);
        editor.markSaved();
      }
    }
  }
  logOut('Replaced in ' + count + ' file(s)', 'ok-text');
}

/* ---------------------------------------------------------------- structure view */

let structureTimer = null;
function refreshStructure() {
  clearTimeout(structureTimer);
  structureTimer = setTimeout(async () => {
    const ed = activeEditor();
    const list = $('structure-list');
    if (!ed || !ed.path) { list.innerHTML = ''; return; }
    const r = await api('GET', '/api/outline?path=' + encodeURIComponent(ed.path));
    list.innerHTML = '';
    const icons = { function: 'ƒ', class: '◆', macro: '#', namespace: 'ns' };
    for (const s of r.symbols) {
      const div = document.createElement('div');
      div.className = 'struct-item ' + s.kind;
      div.innerHTML = '<span class="sicon">' + (icons[s.kind] || '·') + '</span><span>' + esc(s.name) + '</span>' +
        (s.detail ? '<span class="sdetail">' + esc(s.detail) + '</span>' : '');
      div.title = s.kind;
      div.addEventListener('click', () => ed.gotoLine(s.line));
      list.appendChild(div);
    }
  }, 250);
}

/* ---------------------------------------------------------------- git */

async function updateGitStatus() {
  if (!state.root) return;
  try {
    const r = await api('GET', '/api/git/status?path=' + encodeURIComponent(state.root));
    renderGitStatus(r.output || '', r.isRepo);
    const branchMatch = /## ([^\.\.]+)/.exec(r.output || '');
    $('st-branch').textContent = r.isRepo ? '⎇ ' + (branchMatch ? branchMatch[1] : 'HEAD') : '';
  } catch (e) {}
  try {
    const log = await api('GET', '/api/git/log?path=' + encodeURIComponent(state.root));
    renderGitLog(log.output || '');
  } catch (e) {}
}

function renderGitStatus(output, isRepo) {
  const list = $('git-status-list');
  list.innerHTML = '';
  if (!isRepo) {
    list.innerHTML = '<div style="padding:10px;color:var(--fg-dim)">Not a git repository. Use Tools → Git: Init Repository.</div>';
    return;
  }
  const lines = output.split('\n').filter((l) => l.trim());
  if (!lines.length) {
    list.innerHTML = '<div style="padding:10px;color:var(--ok)">✔ Working tree clean</div>';
    return;
  }
  for (const line of lines) {
    const st = line.slice(0, 2).trim();
    const file = line.slice(3);
    const div = document.createElement('div');
    div.className = 'git-file';
    const code = (st[0] === '?' ? '?' : st[0] === 'D' ? 'D' : st.includes('M') ? 'M' : st.includes('A') ? 'A' : 'M');
    div.innerHTML = '<span class="gstatus ' + code + '">' + code + '</span><span>' + esc(file) + '</span>';
    div.addEventListener('click', () => openFile(pathJoin(state.root, file)));
    list.appendChild(div);
  }
}

function renderGitLog(output) {
  const list = $('git-log-list');
  list.innerHTML = '';
  if (!output.trim()) return;
  for (const line of output.trim().split('\n')) {
    const m = /^([0-9a-f]{7,}) \((.*?)\) (.*)$/.exec(line);
    const div = document.createElement('div');
    div.className = 'git-log-item';
    if (m) div.innerHTML = '<span class="hash">' + esc(m[1]) + '</span> ' + esc(m[2]) + ' ' + esc(m[3]);
    else div.textContent = line;
    list.appendChild(div);
  }
}

/* ---------------------------------------------------------------- find bar */

function showFindBar(replace) {
  const ed = activeEditor();
  if (!ed) return;
  $('findbar').classList.remove('hidden');
  $('replace-input').style.display = replace ? '' : 'none';
  $('find-replace-one').style.display = replace ? '' : 'none';
  $('find-replace-all').style.display = replace ? '' : 'none';
  const sel = ed.ta.value.substring(ed.ta.selectionStart, ed.ta.selectionEnd);
  if (sel && !sel.includes('\n')) $('find-input').value = sel;
  $('find-input').focus();
  $('find-input').select();
  doFind();
}

function hideFindBar() {
  $('findbar').classList.add('hidden');
  const ed = activeEditor();
  if (ed) ed.findMatches = [];
}

function updateFindbarVisibility() {
  if (!$('findbar').classList.contains('hidden') && !activeEditor()) hideFindBar();
}

function doFind() {
  const ed = activeEditor();
  if (!ed) return 0;
  const opts = { caseSensitive: $('find-case').checked, regex: $('find-regex').checked };
  return ed.find($('find-input').value, opts);
}

function updateFindCount() {
  const ed = activeEditor();
  if (!ed) return;
  $('find-input').title = ed.findMatches.length ? (ed.findIdx + 1) + ' of ' + ed.findMatches.length : 'No matches';
}

/* ---------------------------------------------------------------- goto / search everywhere */

let gotoMode = 'all'; // all | file | symbol
let gotoIndex = null;

async function buildGotoIndex() {
  gotoIndex = { files: [], symbols: [] };
  if (state.treeData) {
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'file') gotoIndex.files.push({ name: n.name, path: n.path });
        else if (n.children) walk(n.children);
      }
    };
    walk(state.treeData);
  }
  const ed = activeEditor();
  if (ed && ed.path) {
    const r = await api('GET', '/api/outline?path=' + encodeURIComponent(ed.path));
    gotoIndex.symbols = r.symbols.map((s) => ({ ...s, file: ed.path }));
  }
  for (const [fp, f] of state.files) {
    gotoIndex.files = gotoIndex.files.filter((x) => x.path !== fp);
    gotoIndex.files.unshift({ name: f.name, path: fp, open: true });
  }
}

function fuzzyMatch(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (text.includes(query)) return 100 - text.indexOf(query);
  let qi = 0, score = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) { score += 2; qi++; }
  }
  return qi === query.length ? score : -1;
}

async function showGotoPopup(mode) {
  gotoMode = mode;
  const popup = $('goto-popup');
  const input = $('goto-input');
  const placeholder = mode === 'file' ? 'Search file by name...' : mode === 'symbol' ? 'Search symbol...' : 'Search everywhere (files, symbols, actions)...';
  input.placeholder = placeholder;
  input.value = '';
  popup.classList.remove('hidden');
  input.focus();
  await buildGotoIndex();
  renderGotoResults('');
}

function renderGotoResults(q) {
  const results = $('goto-results');
  results.innerHTML = '';
  if (!gotoIndex) return;
  const qLower = q.toLowerCase();
  const addGroup = (title) => {
    const div = document.createElement('div');
    div.className = 'result-group-h';
    div.style.padding = '4px 10px';
    div.style.color = 'var(--fg-dim)';
    div.style.fontSize = '11px';
    div.textContent = title;
    results.appendChild(div);
  };
  const addItem = (icon, iconColor, title, sub, fn, iconKind) => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = '<span style="color:' + iconColor + ';width:18px;text-align:center;flex:0 0 auto">' + icon + '</span>' +
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(title) + '</span>' +
      (sub ? '<span style="color:var(--fg-dim);margin-left:auto;font-size:11px;flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis">' + esc(sub) + '</span>' : '');
    div.addEventListener('click', () => { $('goto-popup').classList.add('hidden'); fn(); });
    results.appendChild(div);
  };

  let count = 0;
  // files
  if (gotoMode !== 'symbol') {
    const files = gotoIndex.files
      .map((f) => ({ f, score: fuzzyMatch(q, f.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (files.length) {
      addGroup('Files');
      for (const { f } of files) {
        const ic = iconFor(f.name);
        addItem(ic.glyph, ic.color, f.name, (f.open ? '● ' : '') + f.path, () => openFile(f.path));
        if (++count > 25) return;
      }
    }
  }
  // symbols
  if (gotoMode !== 'file') {
    const syms = gotoIndex.symbols
      .map((s) => ({ s, score: fuzzyMatch(q, s.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    if (syms.length) {
      addGroup('Symbols');
      for (const { s } of syms) {
        const icons = { function: ['ƒ', 'var(--fn)'], class: ['◆', 'var(--type)'], macro: ['#', 'var(--macro)'], namespace: ['ns', 'var(--kw)'] };
        const [ic, col] = icons[s.kind] || ['·', 'var(--fg)'];
        addItem(ic, col, s.name, s.kind + ' — ' + (s.file ? path.basename(s.file) : '') + ':' + s.line, () => {
          openFile(s.file).then(() => { const f = state.files.get(path.resolve(s.file)); if (f) f.editor.gotoLine(s.line); });
        });
        if (++count > 25) return;
      }
    }
  }
  // actions
  if (gotoMode === 'all' && q) {
    const acts = Object.values(ACTIONS)
      .filter((a) => fuzzyMatch(q, a.label) >= 0)
      .slice(0, 8);
    if (acts.length) {
      addGroup('Actions');
      for (const a of acts) {
        addItem('▶', 'var(--accent)', a.label, a.accel || '', () => a.fn());
        if (++count > 25) return;
      }
    }
  }
  if (count === 0) {
    results.innerHTML = '<div style="padding:10px;color:var(--fg-dim)">No results</div>';
  }
}

/* ---------------------------------------------------------------- autocomplete */

let acState = null;

function gatherCompletions(prefix) {
  const ed = activeEditor();
  const items = new Map();
  const add = (label, kind, detail) => {
    if (!label || items.has(label)) return;
    if (prefix && !label.toLowerCase().startsWith(prefix.toLowerCase())) return;
    items.set(label, { label, kind, detail });
  };
  // keywords
  for (const kw of Syntax.KEYWORDS) add(kw, 'k', 'keyword');
  // types
  for (const t of Syntax.TYPES) add(t, 't', 'type');
  // snippets
  for (const s of Snippets) add(s.trigger, 's', 'snippet: ' + s.desc);
  if (ed) {
    // identifiers in file
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(ed.text)) !== null) {
      const w = m[0];
      if (w.length >= 2) {
        const after = ed.text.slice(m.index + w.length);
        const isFn = /^\s*\(/.test(after);
        add(w, isFn ? 'f' : 'v', isFn ? 'function' : 'variable');
      }
    }
  }
  // raylib API
  if (state.tools.raylib) {
    for (const fn of RAYLIB_API) add(fn, 'f', 'raylib');
  }
  // STL common
  for (const fn of STL_API) add(fn, 'f', 'std');
  return [...items.values()].slice(0, 80);
}

const RAYLIB_API = [
  'InitWindow', 'CloseWindow', 'WindowShouldClose', 'IsWindowReady', 'SetTargetFPS', 'GetFPS',
  'BeginDrawing', 'EndDrawing', 'ClearBackground', 'DrawFPS', 'DrawText', 'DrawTextEx',
  'MeasureText', 'DrawRectangle', 'DrawRectangleRec', 'DrawRectangleLines', 'DrawCircle',
  'DrawCircleV', 'DrawLine', 'DrawLineEx', 'DrawPixel', 'DrawTriangle', 'DrawPoly',
  'CheckCollisionRecs', 'CheckCollisionCircles', 'GetMousePosition', 'GetMouseX', 'GetMouseY',
  'IsMouseButtonDown', 'IsMouseButtonPressed', 'IsMouseButtonReleased', 'IsKeyDown', 'IsKeyPressed',
  'IsKeyReleased', 'GetKeyPressed', 'SetExitKey', 'LoadTexture', 'UnloadTexture', 'DrawTexture',
  'DrawTextureEx', 'DrawTextureRec', 'LoadImage', 'UnloadImage', 'ExportImage', 'ImageText',
  'LoadFont', 'UnloadFont', 'DrawTextCodepoint', 'GetRandomValue', 'SetRandomSeed', 'TakeScreenshot',
  'InitAudioDevice', 'CloseAudioDevice', 'LoadSound', 'UnloadSound', 'PlaySound', 'StopSound',
  'PauseSound', 'ResumeSound', 'SetSoundVolume', 'LoadMusicStream', 'UnloadMusicStream',
  'PlayMusicStream', 'UpdateMusicStream', 'StopMusicStream', 'LoadWave', 'UnloadWave',
  'Vector2Add', 'Vector2Subtract', 'Vector2Scale', 'Vector2Length', 'Vector2Normalize',
  'Vector2Distance', 'Vector2DotProduct', 'Vector2Lerp', 'Vector2Reflect', 'Vector2Rotate',
  'Rectangle', 'Color', 'WHITE', 'BLACK', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'ORANGE',
  'PURPLE', 'DARKGRAY', 'GRAY', 'LIGHTGRAY', 'RAYWHITE', 'MAROON', 'LIME', 'SKYBLUE',
  'KEY_W', 'KEY_A', 'KEY_S', 'KEY_D', 'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT',
  'KEY_SPACE', 'KEY_ENTER', 'KEY_ESCAPE', 'KEY_SHIFT', 'KEY_CONTROL', 'MOUSE_BUTTON_LEFT',
  'MOUSE_BUTTON_RIGHT', 'GAMEPAD_PLAYER1', 'GetFrameTime', 'GetTime', 'SetWindowTitle',
  'ToggleFullscreen', 'MaximizeWindow', 'SetWindowSize', 'GetScreenWidth', 'GetScreenHeight',
  'LoadShader', 'UnloadShader', 'BeginShaderMode', 'EndShaderMode', 'BeginMode2D', 'EndMode2D',
  'BeginMode3D', 'EndMode3D', 'LoadModel', 'UnloadModel', 'DrawModel', 'DrawModelEx',
  'LoadMesh', 'DrawMesh', 'GenMeshCube', 'GenMeshSphere', 'Camera3D', 'Camera2D',
  'LoadRenderTexture', 'UnloadRenderTexture', 'BeginTextureMode', 'EndTextureMode',
  'DrawGrid', 'DrawGizmo', 'LoadGLTF', 'TraceLog', 'SetTraceLogLevel', 'LogType',
];

const STL_API = [
  'std::vector', 'std::map', 'std::unordered_map', 'std::set', 'std::string', 'std::cout',
  'std::cerr', 'std::endl', 'std::make_shared', 'std::make_unique', 'std::move', 'std::forward',
  'std::sort', 'std::find', 'std::accumulate', 'std::transform', 'std::thread', 'std::mutex',
  'std::lock_guard', 'std::chrono::steady_clock', 'std::chrono::duration', 'std::function',
  'std::optional', 'std::variant', 'std::array', 'std::pair', 'std::tuple', 'std::swap',
  'std::min', 'std::max', 'std::abs', 'std::sqrt', 'std::pow', 'std::sin', 'std::cos',
];

async function showAutocomplete(force) {
  const ed = activeEditor();
  if (!ed) return;
  const { prefix, start, end } = ed.getWordPrefix();
  if (!force && prefix.length < 1) { hideAutocomplete(); return; }
  const cursor = ed.ta.selectionStart;
  const selectionEnd = ed.ta.selectionEnd;
  const fallbackItems = gatherCompletions(prefix);
  const languageId = clangdLanguageId(ed.path);
  let languageItems = [];
  if (languageId && state.root) {
    const result = await clangdRequest('textDocument/completion', {
      textDocument: { uri: clangdUri(ed.path) },
      position: lspPosition(ed),
      context: { triggerKind: force ? 1 : 2 },
    });
    const candidates = Array.isArray(result) ? result : (result && result.items) || [];
    languageItems = candidates.filter((item) => item && item.label).map((item) => ({
      ...item,
      kind: item.kind || 1,
      detail: item.detail || '',
      languageServerItem: true,
    }));
  }
  if (activeEditor() !== ed || ed.ta.selectionStart !== cursor || ed.ta.selectionEnd !== selectionEnd) return;
  const merged = new Map(languageItems.map((item) => [item.label, item]));
  for (const item of fallbackItems) if (!merged.has(item.label)) merged.set(item.label, item);
  const items = [...merged.values()].slice(0, 80);
  if (!items.length) { hideAutocomplete(); return; }
  acState = { items, sel: 0, start, end, prefix };
  renderAutocomplete();
}

function renderAutocomplete() {
  const ac = $('autocomplete');
  const ed = activeEditor();
  if (!ed || !acState) return;
  const { x, y, lineH } = ed.caretPixel();
  ac.style.left = Math.min(x, ed.el.clientWidth - 260) + 'px';
  ac.style.top = (y + 4) + 'px';
  ac.innerHTML = '';
  acState.items.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'ac-item' + (i === acState.sel ? ' sel' : '');
    const kindLabels = {
      k: 'kw', f: 'fn', v: 'va', t: 'ty', s: 'sn',
      1: 'txt', 2: 'meth', 3: 'fn', 4: 'ctor', 5: 'fld', 6: 'var',
      7: 'cls', 8: 'intf', 9: 'mod', 10: 'prop', 11: 'unit', 12: 'val',
      13: 'enum', 14: 'kw', 15: 'snip', 16: 'color', 17: 'file', 18: 'ref',
      19: 'fold', 20: 'enum', 21: 'const', 22: 'struct', 23: 'event',
      24: 'op', 25: 'type',
    };
    const kindClasses = {
      k: 'k', f: 'f', v: 'v', t: 't',
      2: 'f', 3: 'f', 4: 't', 5: 'v', 6: 'v', 7: 't',
      13: 't', 14: 'k', 15: 's', 21: 'v', 22: 't', 25: 't',
    };
    div.innerHTML = '<span class="ac-kind ' + (kindClasses[item.kind] || '') + '">' + esc(kindLabels[item.kind] || '·') + '</span>' +
      '<span>' + esc(item.label) + '</span>' +
      (item.detail ? '<span class="ac-detail">' + esc(item.detail) + '</span>' : '');
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertCompletion(item);
    });
    ac.appendChild(div);
  });
  ac.classList.remove('hidden');
}

function insertCompletion(item) {
  const ed = activeEditor();
  if (!ed || !acState) return;
  const stateAtSelection = acState;
  let replacement = item.textEdit && item.textEdit.newText || item.insertText || item.label;
  let replaceStart = stateAtSelection.start, replaceEnd = stateAtSelection.end;
  if (item.textEdit && (item.textEdit.range || item.textEdit.replace)) {
    const range = item.textEdit.range || item.textEdit.replace;
    replaceStart = offsetAtPosition(ed.text, range.start);
    replaceEnd = offsetAtPosition(ed.text, range.end);
  }
  let caretOffset = replacement.length;
  if (item.insertTextFormat === 2) {
    const snippet = materializeCompletionSnippet(replacement);
    replacement = snippet.text;
    caretOffset = snippet.cursor;
  }
  if (!item.languageServerItem && item.kind === 's') {
    const snip = Snippets.find((s) => s.trigger === item.label);
    if (snip) replacement = snip.body.replace(/\$\d+/g, '').replace('$0', '');
  }
  const primaryEdit = { start: replaceStart, end: replaceEnd, text: replacement };
  const edits = [primaryEdit];
  for (const edit of item.additionalTextEdits || []) {
    edits.push({
      start: offsetAtPosition(ed.text, edit.range.start),
      end: offsetAtPosition(ed.text, edit.range.end),
      text: edit.newText,
    });
  }
  let updated = ed.text;
  for (const edit of edits.slice().sort((a, b) => b.start - a.start || b.end - a.end)) {
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  }
  const cursor = replaceStart + caretOffset + edits.slice(1)
    .filter((edit) => edit.end <= replaceStart)
    .reduce((delta, edit) => delta + edit.text.length - (edit.end - edit.start), 0);
  ed._replaceRange(0, ed.text.length, updated);
  ed.setCursor(Math.max(0, Math.min(cursor, updated.length)));
  const historyItem = ed.history[ed.historyIndex];
  if (historyItem) historyItem.selectionStart = historyItem.selectionEnd = ed.ta.selectionStart;
  hideAutocomplete();
}

function materializeCompletionSnippet(snippet) {
  let text = '', cursor = null, match;
  const token = /\$(\d+)|\$\{(\d+)(?::([^}]*))?\}/g;
  let previous = 0;
  while ((match = token.exec(snippet))) {
    text += snippet.slice(previous, match.index);
    const index = Number(match[1] || match[2]);
    const value = match[3] || '';
    if (index === 0) {
      if (cursor === null) cursor = text.length;
    } else if (cursor === null) {
      cursor = text.length;
    }
    text += value;
    previous = token.lastIndex;
  }
  text += snippet.slice(previous);
  return { text, cursor: cursor === null ? text.length : cursor };
}

function hideAutocomplete() {
  acState = null;
  $('autocomplete').classList.add('hidden');
}

function autocompleteMove(dir) {
  if (!acState) return false;
  acState.sel = (acState.sel + dir + acState.items.length) % acState.items.length;
  renderAutocomplete();
  return true;
}

/* ---------------------------------------------------------------- bottom panel */

function showBottom(pane) {
  const panel = $('bottom-panel');
  panel.classList.remove('collapsed');
  $$('.btab').forEach((t) => t.classList.toggle('active', t.dataset.bottom === pane));
  $$('.bpane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + pane));
}

function toggleBottom() {
  $('bottom-panel').classList.toggle('collapsed');
}

/* ---------------------------------------------------------------- sidebar views */

function showSidebarView(name) {
  $$('.stab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.sview').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

/* ---------------------------------------------------------------- keyboard */

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
    const key = e.key.toLowerCase();

    // double shift → search everywhere
    if (key === 'shift' && !ctrl && !alt) {
      const now = Date.now();
      if (now - (bindKeyboard._lastShift || 0) < 350) {
        showGotoPopup('all');
        e.preventDefault();
      }
      bindKeyboard._lastShift = now;
      return;
    }

    // don't intercept when typing in inputs (except a few)
    const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    const typingInEditor = document.activeElement === activeEditor()?.ta;

    if (ctrl && shift && key === 'f') { e.preventDefault(); switchSidebarAndFocus('search'); return; }
    if (ctrl && shift && key === 'm') { e.preventDefault(); showSidebarView('problems'); return; }
    if (ctrl && key === '.' && typingInEditor) { e.preventDefault(); codeActions(); return; }
    if (ctrl && shift && e.code === 'Space' && typingInEditor) { e.preventDefault(); showSignatureHelp(); return; }
    if (ctrl && alt && key === 'i' && typingInEditor) { e.preventDefault(); showHover(); return; }
    if (ctrl && shift && key === 'n') { e.preventDefault(); newProjectDialog(); return; }
    if (ctrl && alt && shift && key === 'n') { e.preventDefault(); newProjectDialog(); return; }
    if (ctrl && key === 'k') { e.preventDefault(); /* wait for second key */ bindSecondKey('o', () => openFolderBrowser(null, 'Open Folder', setRoot)); return; }
    if (ctrl && key === 'f') { e.preventDefault(); showFindBar(false); return; }
    if (ctrl && key === 'h') { e.preventDefault(); showFindBar(true); return; }
    if (ctrl && key === 'g') { e.preventDefault(); gotoLineDialog(); return; }
    if (ctrl && key === 'p') { e.preventDefault(); showGotoPopup('file'); return; }
    if (ctrl && alt && shift && key === 'n') { e.preventDefault(); showGotoPopup('symbol'); return; }
    if (ctrl && key === 'e') { e.preventDefault(); showGotoPopup('file'); return; }
    if (ctrl && shift && key === 'f12') { e.preventDefault(); $('bottom-panel').classList.toggle('collapsed'); return; }
    if (ctrl && key === 'f9') { e.preventDefault(); buildProject(); return; }
    if (ctrl && key === 'f2') { e.preventDefault(); stopRun(); return; }
    if (ctrl && key === 'f8') { e.preventDefault(); toggleBreakpointAtCursor(); return; }
    if (ctrl && shift && key === 'f8') { e.preventDefault(); showBottom('debug'); renderBreakpointsList(); return; }
    if (ctrl && key === 's') { e.preventDefault(); saveFile(); return; }
    if (ctrl && alt && key === 's') { e.preventDefault(); saveAll(); settingsDialog(); return; }
    if (ctrl && key === 'd') { e.preventDefault(); duplicateLine(); return; }
    if (ctrl && shift && key === 'y') { e.preventDefault(); deleteLine(); return; }
    if (ctrl && key === '/') { e.preventDefault(); toggleComment(); return; }
    if (ctrl && alt && key === 'l') { e.preventDefault(); formatDocument(); return; }
    if (e.key === 'F5') { e.preventDefault(); debugProject(); return; }
    if (e.key === 'F7') { e.preventDefault(); debugStep('into'); return; }
    if (e.key === 'F8') { e.preventDefault(); debugStep('over'); return; }
    if (e.key === 'F9') { e.preventDefault(); debugStep('resume'); return; }
    if (e.key === 'F10') { e.preventDefault(); debugStep('over'); return; }
    if (e.key === 'F12') { e.preventDefault(); gotoDefinition(); return; }
    if (e.key === 'F2' && !ctrl) { e.preventDefault(); renameSymbol(); return; }
    if (e.key === 'Escape') {
      if (!$('autocomplete').classList.contains('hidden')) { hideAutocomplete(); return; }
      if (!$('findbar').classList.contains('hidden')) { hideFindBar(); return; }
      if (!$('goto-popup').classList.contains('hidden')) { $('goto-popup').classList.add('hidden'); return; }
      closeMenus(); closeContextMenu(); return;
    }
    if (alt && key === 'insert') { e.preventDefault(); newFileTemplate(state.root || ''); return; }
    if (ctrl && alt && shift && key === 'n') { e.preventDefault(); newProjectDialog(); return; }
    if (e.key === 'F1') { e.preventDefault(); shortcutsDialog(); return; }
    if (ctrl && key === ' ' && !e.key.includes('Shift')) {
      // ctrl+space handled on keyup in editor
      return;
    }
  });

  // editor-level keys
  document.addEventListener('keydown', (e) => {
    const ed = activeEditor();
    if (!ed || document.activeElement !== ed.ta) return;
    if (e.ctrlKey && e.code === 'Space') {
      e.preventDefault();
      showAutocomplete(true);
      return;
    }
    if (acState) {
      if (e.key === 'ArrowDown') { e.preventDefault(); autocompleteMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); autocompleteMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (acState) { e.preventDefault(); insertCompletion(acState.items[acState.sel]); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); hideAutocomplete(); return; }
    }
    // snippet expansion on Tab
    if (e.key === 'Tab' && !e.shiftKey) {
      const wp = ed.getWordPrefix();
      if (wp.prefix) {
        const snip = Snippets.find((s) => s.trigger === wp.prefix);
        if (snip) {
          e.preventDefault();
          ed._replaceRange(wp.start, wp.end, snip.body.replace(/\$\d+/g, '').replace('$0', ''));
          return;
        }
      }
    }
    // live completion trigger
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /[A-Za-z_]/.test(e.key)) {
      setTimeout(() => { if (document.activeElement === ed.ta) showAutocomplete(false); }, 0);
    }
    if (e.key === '.') {
      setTimeout(() => { if (document.activeElement === ed.ta) showAutocomplete(true); }, 0);
    }
  });

  // find bar keys
  $('find-input').addEventListener('input', () => { doFind(); updateFindCount(); });
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) { activeEditor()?.findPrev(); } else { activeEditor()?.findNext(); } updateFindCount(); }
    if (e.key === 'Escape') hideFindBar();
  });
  $('find-replace-one').addEventListener('click', () => {
    const ed = activeEditor();
    if (ed) ed.replaceOne($('replace-input').value);
  });
  $('find-replace-all').addEventListener('click', () => {
    const ed = activeEditor();
    if (ed) {
      const n = ed.replaceAll($('replace-input').value, $('find-input').value, { caseSensitive: $('find-case').checked, regex: $('find-regex').checked });
      logOut('Replaced ' + n + ' occurrence(s)', 'ok-text');
    }
  });
  $('find-next').addEventListener('click', () => { activeEditor()?.findNext(); });
  $('find-prev').addEventListener('click', () => { activeEditor()?.findPrev(); });
  $('find-close').addEventListener('click', hideFindBar);

  // goto popup
  $('goto-input').addEventListener('input', (e) => renderGotoResults(e.target.value));
  $('goto-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('goto-popup').classList.add('hidden');
    if (e.key === 'Enter') {
      const first = $('goto-results').querySelector('.result-item');
      if (first) first.click();
    }
  });

  // terminal input
  $('term-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); termSendLine(); }
    if (e.key === 'ArrowUp' && state.term.historyIndex > 0) {
      e.preventDefault();
      state.term.historyIndex--;
      $('term-input').value = state.term.history[state.term.historyIndex];
    }
    if (e.key === 'ArrowDown' && state.term.historyIndex < state.term.history.length) {
      e.preventDefault();
      state.term.historyIndex++;
      $('term-input').value = state.term.history[state.term.historyIndex] || '';
    }
  });
  $('terminal-output').addEventListener('click', () => $('term-input').focus());

  // search panel
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchInFiles(); });
  $('search-go').addEventListener('click', searchInFiles);
  $('search-replace-go').addEventListener('click', replaceInFiles);

  // bottom tabs
  $$('.btab').forEach((t) => t.addEventListener('click', () => showBottom(t.dataset.bottom)));
  $$('.stab').forEach((t) => t.addEventListener('click', () => showSidebarView(t.dataset.view)));

  // debug buttons
  $('dbg-step-over').addEventListener('click', () => debugStep('over'));
  $('dbg-step-into').addEventListener('click', () => debugStep('into'));
  $('dbg-resume').addEventListener('click', () => debugStep('resume'));
  $('dbg-stop').addEventListener('click', stopDebug);

  // sidebar resizer
  const sr = $('sidebar-resizer');
  sr.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { $('sidebar').style.width = Math.max(140, Math.min(innerWidth * 0.6, ev.clientX)) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // bottom resizer
  const br = $('bottom-resizer');
  br.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const panel = $('bottom-panel');
    panel.classList.remove('collapsed');
    const move = (ev) => {
      const h = innerHeight - ev.clientY;
      panel.style.height = Math.max(26, Math.min(innerHeight * 0.7, h)) + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // modal backdrop click
  $('modal-backdrop').addEventListener('mousedown', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });
}

let _secondKeyCb = null;
function bindSecondKey(key, cb) {
  _secondKeyCb = { key, cb, expire: Date.now() + 1000 };
}
document.addEventListener('keydown', (e) => {
  if (_secondKeyCb && Date.now() < _secondKeyCb.expire) {
    if (e.key.toLowerCase() === _secondKeyCb.key && e.ctrlKey && !e.shiftKey && !e.altKey) {
      _secondKeyCb.cb();
    }
    _secondKeyCb = null;
  }
});

function switchSidebarAndFocus(name) {
  showSidebarView(name);
  if (name === 'search') $('search-input').focus();
}

function gotoLineDialog() {
  const ed = activeEditor();
  if (!ed) return;
  showModal('Go to Line', '<div class="field"><label>Line number</label><input id="gl-num" type="number" min="1"></div>', [
    { label: 'Cancel', value: null },
    {
      label: 'Go', primary: true,
      validate: () => {
        const n = parseInt($('gl-num').value, 10);
        if (n > 0) ed.gotoLine(n);
        return true;
      },
      value: null,
    },
  ]);
}

function toggleBreakpointAtCursor() {
  const ed = activeEditor();
  if (!ed) return;
  const line = ed.cursorPos().line;
  ed.toggleBreakpoint(line);
  if (state.debug) {
    if (ed.breakpoints.has(line)) debugInsertBreakpoint(ed, line);
    else debugRemoveBreakpoint(ed, line);
  }
  renderBreakpointsList();
}

function duplicateLine() {
  const ed = activeEditor();
  if (!ed) return;
  const pos = ed.cursorPos();
  const lines = ed.text.split('\n');
  const line = lines[pos.line - 1];
  lines.splice(pos.line, 0, line);
  ed._replaceRange(0, ed.text.length, lines.join('\n'));
}

function deleteLine() {
  const ed = activeEditor();
  if (!ed) return;
  const pos = ed.cursorPos();
  const lines = ed.text.split('\n');
  const start = pos.index - (pos.col - 1);
  let end = start + lines[pos.line - 1].length;
  if (pos.line < lines.length) end += 1; // newline
  ed._replaceRange(start, end, '');
}

function toggleComment() {
  const ed = activeEditor();
  if (!ed) return;
  const pos = ed.cursorPos();
  const lineStart = ed.text.lastIndexOf('\n', pos.index - 1) + 1;
  const lineEnd = ed.text.indexOf('\n', pos.index);
  const end = lineEnd === -1 ? ed.text.length : lineEnd;
  const lineText = ed.text.slice(lineStart, end);
  const trimmed = lineText.trimStart();
  if (trimmed.startsWith('//')) {
    const newText = lineText.replace(/^(\s*)\/\/\s?/, '$1');
    ed._replaceRange(lineStart, end, newText);
  } else {
    ed._replaceRange(lineStart, lineStart + (lineText.length - trimmed.length), lineText.slice(0, lineText.length - trimmed.length) + '// ');
  }
}

async function gotoDefinition() {
  const ed = activeEditor();
  if (!ed) return;
  const w = ed.wordAt();
  if (!w) return;
  if (clangdLanguageId(ed.path) && state.root) {
    const definitions = await clangdRequest('textDocument/definition', {
      textDocument: { uri: clangdUri(ed.path) },
      position: lspPosition(ed),
    });
    const target = Array.isArray(definitions) ? definitions[0] : definitions;
    if (target) {
      const uri = target.targetUri || target.uri;
      const range = target.targetSelectionRange || target.targetRange || target.range;
      if (uri && range && uri.startsWith('file:')) {
        const fp = clangdPath(uri);
        await openFile(fp);
        const targetEditor = state.files.get(fp)?.editor;
        if (targetEditor) {
          targetEditor.gotoLine(range.start.line + 1);
          const offset = offsetAtPosition(targetEditor.text, range.start);
          targetEditor.setCursor(offset);
        }
        return;
      }
    }
  }
  // search in open files and project tree
  const search = async () => {
    for (const [fp, f] of state.files) {
      const re = new RegExp('(?:^|\\s)(?:class|struct|enum|typedef|using)\\s+(?:\\w+\\s+)*' + w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(f.editor.text)) { openFile(fp); return; }
    }
    if (state.root) {
      const r = await api('GET', '/api/search?path=' + encodeURIComponent(state.root) + '&q=' + encodeURIComponent(w.word) + '&word=1');
      if (r.results && r.results.length) {
        const hit = r.results.find((x) => /^\s*(class|struct|enum|typedef|using|int|void|float|double|bool|auto|static)\s/.test(x.text)) || r.results[0];
        openFile(hit.path).then(() => {
          const f = state.files.get(hit.path);
          if (f) f.editor.gotoLine(hit.line);
        });
      }
    }
  };
  search().catch((e) => logOut('Definition search failed: ' + e.message, 'err-text'));
}

/* ---------------------------------------------------------------- dialogs */

function settingsDialog() {
  const s = state.settings;
  showModal('Settings', `
    <div class="field"><label>Editor font size</label>
      <select id="st-font">${[12, 13, 14, 15, 16].map((n) => '<option ' + (n === s.fontSize ? 'selected' : '') + '>' + n + '</option>').join('')}</select>
    </div>
    <div class="field"><label>Tab size</label>
      <select id="st-tab">${[2, 4, 8].map((n) => '<option ' + (n === s.tabSize ? 'selected' : '') + '>' + n + '</option>').join('')}</select>
    </div>
    <div class="field"><label>Theme</label>
      <select id="st-theme">
        <option value="fullide" ${s.theme === 'fullide' ? 'selected' : ''}>FullIDE (custom dark)</option>
        <option value="classic" ${s.theme === 'classic' ? 'selected' : ''}>Classic (light)</option>
      </select>
    </div>
    <div class="field"><label><input type="checkbox" id="st-minimap" ${s.minimap ? 'checked' : ''}> Show minimap</label></div>
    <div class="field"><label><input type="checkbox" id="st-brackets" ${s.autoBrackets ? 'checked' : ''}> Auto-close brackets</label></div>
  `, [
    { label: 'Cancel', value: null },
    {
      label: 'Apply', primary: true,
      validate: () => {
        state.settings.fontSize = parseInt($('st-font').value, 10);
        state.settings.tabSize = parseInt($('st-tab').value, 10);
        state.settings.theme = $('st-theme').value;
        state.settings.minimap = $('st-minimap').checked;
        state.settings.autoBrackets = $('st-brackets').checked;
        applySettings();
        saveSettings();
        return true;
      },
      value: null,
    },
  ]);
}

function aboutDialog() {
  showModal('About FullIDE', `
    <div style="text-align:center;padding:10px 0">
      <div style="font-size:34px;font-weight:300">Full<span style="color:var(--accent)">IDE</span></div>
      <div style="color:var(--fg-dim);margin:6px 0 14px">C/C++ IDE for game development</div>
      <div style="text-align:left;font-size:12.5px;line-height:1.7;color:var(--fg-dim)">
        <div>• Custom FullIDE theme with JetBrains Mono editor text</div>
        <div>• Real toolchain: GCC ${'16'} / Clang 22 / CMake 4 + Ninja / GDB 17</div>
        <div>• Build (Ctrl+F9), Run (Shift+F10), Debug with breakpoints (F5)</div>
        <div>• raylib ${state.tools.raylib ? 'detected — game templates ready' : 'not detected'}</div>
        <div>• Game project templates: Pong, Snake, SDL2, SFML, OpenGL</div>
        <div>• Find in files, Search everywhere, code completion, snippets</div>
        <div>• Integrated terminal, git status/commit, minimap, live highlight</div>
      </div>
    </div>
  `, [{ label: 'OK', primary: true, value: null }]);
}

function shortcutsDialog() {
  showModal('Keyboard Shortcuts', `
    <table style="width:100%;font-size:12.5px;line-height:1.9;border-collapse:collapse">
      ${[
        ['Ctrl+S', 'Save file'], ['Ctrl+Alt+S', 'Save all'],
        ['Ctrl+F9', 'Build project'], ['Shift+F10', 'Run'], ['F5', 'Debug (GDB)'], ['Ctrl+F2', 'Stop'],
        ['F8 / F7 / F9', 'Step over / into / resume'],
        ['Ctrl+F8', 'Toggle breakpoint'], ['Ctrl+Shift+F8', 'View breakpoints'],
        ['Ctrl+F / Ctrl+H', 'Find / Replace'], ['Ctrl+Shift+F', 'Find in files'],
        ['Ctrl+P', 'Go to file'], ['Ctrl+Alt+Shift+N', 'Go to symbol'], ['Ctrl+G', 'Go to line'],
        ['Double Shift', 'Search everywhere'], ['Ctrl+E', 'Recent files'],
        ['Ctrl+Space', 'clangd completion / snippets'], ['F12 / F2', 'Go to definition / rename symbol'],
        ['Ctrl+.', 'Quick fix / refactor'], ['Ctrl+Alt+L', 'Format document'],
        ['Ctrl+Alt+I', 'C++ hover information'], ['Ctrl+Shift+Space', 'C++ signature help'],
        ['Alt+Insert', 'New file from template'],
        ['Ctrl+/', 'Toggle comment'], ['Ctrl+D', 'Duplicate line'],
        ['Ctrl+F12', 'File structure'], ['Alt+1..9', 'Tool windows'],
        ['Alt+F12', 'Terminal'], ['Ctrl+Shift+F12', 'Hide tool windows'],
        ['F12', 'Go to definition'], ['Ctrl+K Ctrl+O', 'Open folder'],
      ].map(([k, v]) => '<tr><td style="color:var(--fn);white-space:nowrap;padding-right:18px">' + k + '</td><td style="color:var(--fg)">' + v + '</td></tr>').join('')}
    </table>
  `, [{ label: 'OK', primary: true, value: null }]);
}

/* ---------------------------------------------------------------- toolbar & menu wiring */

function bindActions() {
  action('newproject', 'New Project', 'Ctrl+Alt+Shift+N', newProjectDialog);
  action('open', 'Open Folder...', 'Ctrl+K Ctrl+O', () => openFolderBrowser(null, 'Open Folder', setRoot));
  action('openWorkspace', 'Open Workspace Root', null, () => { if (state.root) setRoot(state.root); });
  action('save', 'Save', 'Ctrl+S', () => saveFile());
  action('saveall', 'Save All', 'Ctrl+Alt+S', saveAll);
  action('settings', 'Settings...', 'Ctrl+Alt+S', settingsDialog);
  action('exit', 'Exit', null, () => { logOut('Close the browser tab to exit FullIDE'); });

  action('undo', 'Undo', 'Ctrl+Z', () => activeEditor()?.undo());
  action('redo', 'Redo', 'Ctrl+Y', () => activeEditor()?.redo());
  action('cut', 'Cut', 'Ctrl+X', () => document.execCommand('cut'));
  action('copy', 'Copy', 'Ctrl+C', () => document.execCommand('copy'));
  action('paste', 'Paste', 'Ctrl+V', () => document.execCommand('paste'));
  action('find', 'Find...', 'Ctrl+F', () => showFindBar(false));
  action('replace', 'Replace...', 'Ctrl+H', () => showFindBar(true));
  action('findFiles', 'Find in Files...', 'Ctrl+Shift+F', () => switchSidebarAndFocus('search'));
  action('comment', 'Comment with Line Comment', 'Ctrl+/', toggleComment);
  action('duplicate', 'Duplicate Line', 'Ctrl+D', duplicateLine);
  action('deleteline', 'Delete Line', 'Ctrl+Shift+Y', deleteLine);

  action('v-project', 'Project', 'Alt+1', () => showSidebarView('project'));
  action('v-search', 'Find', 'Alt+2', () => showSidebarView('search'));
  action('v-problems', 'Problems', 'Alt+6', () => showSidebarView('problems'));
  action('v-structure', 'Structure', 'Alt+7', () => showSidebarView('structure'));
  action('v-git', 'Version Control', 'Alt+9', () => showSidebarView('git'));
  action('v-bottom', 'Hide Tool Windows', 'Ctrl+Shift+F12', toggleBottom);

  action('goto-file', 'Go to File...', 'Ctrl+P', () => showGotoPopup('file'));
  action('goto-symbol', 'Go to Symbol...', 'Ctrl+Alt+Shift+N', () => showGotoPopup('symbol'));
  action('goto-line', 'Go to Line...', 'Ctrl+G', gotoLineDialog);
  action('recent', 'Recent Files', 'Ctrl+E', () => showGotoPopup('file'));
  action('lastedit', 'Last Edit Location', 'Ctrl+Shift+Backspace', () => {});

  action('complete', 'C++ IntelliSense Completion', 'Ctrl+Space', () => showAutocomplete(true));
  action('definition', 'Go to Definition', 'F12', gotoDefinition);
  action('rename-symbol', 'Rename Symbol', 'F2', renameSymbol);
  action('quick-fix', 'Quick Fix', 'Ctrl+.', codeActions);
  action('format-document', 'Format Document', 'Ctrl+Alt+L', formatDocument);
  action('show-hover', 'Show C++ Information', 'Ctrl+Alt+I', showHover);
  action('signature-help', 'Signature Help', 'Ctrl+Shift+Space', showSignatureHelp);
  action('newfile', 'New File from Template...', 'Alt+Insert', () => newFileTemplate(state.root || ''));

  action('build', 'Build Project', 'Ctrl+F9', () => buildProject());
  action('rebuild', 'Rebuild Project', null, () => buildProject(true));
  action('clean', 'Clean Project', null, async () => {
    if (!state.root) return;
    await api('POST', '/api/delete', { path: pathJoin(state.root, 'build') }).catch(() => {});
    await api('POST', '/api/delete', { path: pathJoin(state.root, 'bin') }).catch(() => {});
    logOut('Cleaned build/ and bin/', 'ok-text');
  });

  action('run', 'Run', 'Shift+F10', runProject);
  action('runconfig', 'Edit Configurations...', 'Alt+Shift+F10', editRunConfig);
  action('debug', 'Debug', 'F5', debugProject);
  action('stop', 'Stop', 'Ctrl+F2', stopRun);
  action('togglebp', 'Toggle Breakpoint', 'Ctrl+F8', toggleBreakpointAtCursor);
  action('viewbps', 'View Breakpoints', 'Ctrl+Shift+F8', () => { showBottom('debug'); renderBreakpointsList(); });

  action('terminal', 'Terminal', 'Alt+F12', async () => {
    showBottom('terminal');
    await ensureTerminal();
    $('term-input').focus();
  });
  action('gitcommit', 'Git: Commit...', null, async () => {
    showSidebarView('git');
    $('git-commit-msg').focus();
  });
  action('gitinit', 'Git: Init Repository', null, async () => {
    if (!state.root) return;
    const r = await api('POST', '/api/git/init', { path: state.root });
    logOut(r.output, 'ok-text');
    updateGitStatus();
  });
  action('gitrefresh', 'Git: Refresh Status', null, updateGitStatus);

  action('about', 'About FullIDE', null, aboutDialog);
  action('shortcuts', 'Keyboard Shortcuts', 'F1', shortcutsDialog);

  // toolbar
  $('tb-open').addEventListener('click', () => openFolderBrowser(null, 'Open Folder', setRoot));
  $('tb-newproject').addEventListener('click', newProjectDialog);
  $('tb-save').addEventListener('click', () => saveFile());
  $('tb-saveall').addEventListener('click', saveAll);
  $('tb-build').addEventListener('click', () => buildProject());
  $('tb-rebuild').addEventListener('click', () => buildProject(true));
  $('tb-clean').addEventListener('click', () => ACTIONS.clean.fn());
  $('tb-run').addEventListener('click', runProject);
  $('tb-debug').addEventListener('click', debugProject);
  $('tb-stop').addEventListener('click', stopRun);
  $('tb-runargs').addEventListener('click', editRunConfig);
  $('tb-search').addEventListener('click', () => showGotoPopup('all'));
  $('tb-terminal').addEventListener('click', async () => {
    showBottom('terminal');
    await ensureTerminal();
    $('term-input').focus();
  });
  $('tb-settings').addEventListener('click', settingsDialog);

  // welcome
  $('welcome-open').addEventListener('click', () => openFolderBrowser(null, 'Open Folder', setRoot));
  $('welcome-new').addEventListener('click', newProjectDialog);
  $('welcome-recent').addEventListener('click', () => { if (state.root) setRoot(state.root); });

  // git panel
  $('git-commit-btn').addEventListener('click', async () => {
    const msg = $('git-commit-msg').value.trim();
    if (!msg || !state.root) return;
    const r = await api('POST', '/api/git/commit', { path: state.root, message: msg });
    logOut('Git commit: ' + (r.output || '').trim(), 'ok-text');
    $('git-commit-msg').value = '';
    updateGitStatus();
  });
  $('git-init-btn').addEventListener('click', () => ACTIONS.gitinit.fn());
  $('git-refresh-btn').addEventListener('click', updateGitStatus);
  $('btn-refresh-tree').addEventListener('click', refreshTree);

  // problems count click
  $('st-errors').addEventListener('click', () => showSidebarView('problems'));
  $('st-warnings').addEventListener('click', () => showSidebarView('problems'));
  $('st-branch').addEventListener('click', () => showSidebarView('git'));
  $('st-clangd').addEventListener('click', () => {
    const editor = activeEditor();
    if (editor && clangdLanguageId(editor.path)) ensureClangd();
    else logOut('Open a C or C++ source/header file to start clangd.', 'warn-text');
  });
}

/* ---------------------------------------------------------------- set root */

async function setRoot(p) {
  if (!p) return;
  const restartTerminal = !!state.term.id || !!state.term.starting;
  await stopClangd();
  state.root = path.resolve(p);
  $('menu-folder-name').textContent = state.root;
  $('project-title').textContent = path.basename(state.root);
  // close open files (they belong to old project)
  for (const fp of [...state.files.keys()]) {
    const f = state.files.get(fp);
    f.editor.dispose();
    f.tab.remove();
  }
  state.files.clear();
  state.active = null;
  state.build = { exePath: null, running: false, diagnostics: [] };
  state.expanded = new Set([state.root]);
  $('welcome-screen').classList.remove('hidden');
  await refreshTree();
  applyDiagnostics();
  updateProblemCounts();
  logOut('Opened project: ' + state.root, 'cmd-text');
  // auto-expand src
  const walkExpand = (nodes, prefix) => {
    for (const n of nodes) {
      if (n.type === 'dir' && (n.name === 'src' || n.name === 'include')) state.expanded.add(n.path);
      if (n.children) walkExpand(n.children, prefix);
    }
  };
  if (state.treeData) walkExpand(state.treeData, '');
  renderTree();
  if (restartTerminal) await ensureTerminal();
}

/* ---------------------------------------------------------------- init */

async function init() {
  buildMenus();
  bindActions();
  bindKeyboard();
  await loadSettings();
  await api('GET', '/api/env').then((env) => {
    state.tools = env.tools;
  }).catch(() => {});
  state.clangd.status = state.tools.clangd ? 'stopped' : 'missing';
  updateClangdStatus();
  renderProblems();
  renderBreakpointsList();
  showBottom('build');
  showSidebarView('project');
  logOut('FullIDE ready. Open a folder or create a new project to begin.', 'ok-text');
  logOut('Toolchain: g++ ' + (state.tools.gxx ? '✓' : '✗') + ' · cmake ' + (state.tools.cmake ? '✓' : '✗') + ' · ninja ' + (state.tools.ninja ? '✓' : '✗') + ' · gdb ' + (state.tools.gdb ? '✓' : '✗') + ' · clangd ' + (state.tools.clangd ? '✓' : '✗') + ' · raylib ' + (state.tools.raylib ? '✓' : '✗'));

  // auto-open workspace root
  const env = await api('GET', '/api/env').catch(() => null);
  if (env) {
    const rootPath = env.workspace;
    // open workspace if it has any content
    const tree = await api('GET', '/api/tree?path=' + encodeURIComponent(rootPath)).catch(() => null);
    if (tree && tree.children && tree.children.length) {
      setRoot(rootPath);
    } else {
      // open the IDE's own directory as a fallback so the tree isn't empty
      const parent = path.dirname(rootPath);
      const parentTree = await api('GET', '/api/tree?path=' + encodeURIComponent(parent)).catch(() => null);
      if (parentTree && parentTree.children && parentTree.children.length) setRoot(parent);
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
