/* FullIDE for C/C++ game development — zero-dependency backend.
 * Serves the web IDE, file system API, build (CMake/Ninja or direct compiler),
 * run sessions (SSE streaming), integrated terminal, git plumbing and a gdb MI debug engine.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const url = require('url');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WORKSPACE = process.argv[2] || path.join(ROOT_DIR, 'workspace');
const SETTINGS_DIR = path.join(require('os').homedir(), '.fullide');

try { fs.mkdirSync(WORKSPACE, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(SETTINGS_DIR, { recursive: true }); } catch (e) {}

const TEMPLATES = require('./public/js/templates-data.js');

/* ------------------------------------------------------------------ utils */

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 100\n\n');
  let alive = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => clearInterval(alive));
  return (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
}

function walk(dir, maxDepth, depth, out, ignore) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  for (const ent of entries) {
    if (ignore.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const node = { name: ent.name, path: full, type: ent.isDirectory() ? 'dir' : 'file', size: 0 };
    try { if (ent.isFile()) node.size = fs.statSync(full).size; } catch (e) {}
    if (ent.isDirectory()) {
      node.children = [];
      out.push(node);
      walk(full, maxDepth, depth + 1, node.children, ignore);
    } else {
      out.push(node);
    }
  }
}

const IGNORE_DIRS = new Set(['.git', 'build', 'Debug', 'Release', 'x64', 'out', 'bin', 'obj', '.idea', 'node_modules', '.vs']);
const IGNORE_DIRS_TREE = new Set(['.git', 'node_modules', '.idea', '.vs']);

/* ------------------------------------------------------- toolchain detect */

function detectTools() {
  const find = (name) => {
    try {
      const r = cp.spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
    } catch (e) {}
    return null;
  };
  const info = {
    gxx: find('g++.exe'), gcc: find('gcc.exe'), clang: find('clang++.exe'),
    clangd: process.env.FULLIDE_CLANGD || find('clangd.exe'),
    cmake: find('cmake.exe'), ninja: find('ninja.exe'), gdb: find('gdb.exe'),
    git: find('git.exe'), make: find('make.exe'),
    raylib: false, raylibLib: null, toolPaths: [],
  };
  const candRoots = ['C:\\msys64\\ucrt64', 'C:\\msys64\\mingw64', 'C:\\msys64\\usr'];
  for (const root of candRoots) {
    if (fs.existsSync(path.join(root, 'include', 'raylib.h'))) {
      info.raylib = true;
      info.raylibRoot = root;
      info.raylibLib = path.join(root, 'lib');
      info.raylibBin = path.join(root, 'bin');
    }
    if (fs.existsSync(path.join(root, 'bin'))) info.toolPaths.push(path.join(root, 'bin'));
  }
  if (info.cmake) info.toolPaths.push(path.dirname(info.cmake));
  if (info.ninja) info.toolPaths.push(path.dirname(info.ninja));
  info.toolPaths = [...new Set(info.toolPaths)];
  return info;
}

const TOOLS = detectTools();

function childEnv(extraPathDirs) {
  const dirs = [...(extraPathDirs || []), ...TOOLS.toolPaths, process.env.PATH].filter(Boolean);
  return Object.assign({}, process.env, { PATH: dirs.join(path.delimiter) });
}

/* ------------------------------------------------------------- diagnostics */

function parseDiagnostics(output, root) {
  const diags = [];
  const lines = output.split(/\r?\n/);
  const re = /^(.+?)\((\d+),(\d+)\)\s*:\s*(error|warning|fatal error|note):\s*(.*)$/;
  const re2 = /^(.+?):(\d+):(\d+):\s*(error|warning|fatal error|note):\s*(.*)$/;
  for (const line of lines) {
    let m = re.exec(line) || re2.exec(line);
    if (m) {
      let file = m[1];
      try { file = path.resolve(root, file); } catch (e) {}
      diags.push({ file, line: parseInt(m[2], 10), col: parseInt(m[3], 10), severity: m[4].replace('fatal error', 'error'), message: m[5], raw: line });
    } else if (/error\s*:\s*/i.test(line)) {
      diags.push({ file: null, line: 0, col: 0, severity: 'error', message: line.trim(), raw: line });
    } else if (/warning\s*:\s*/i.test(line)) {
      diags.push({ file: null, line: 0, col: 0, severity: 'warning', message: line.trim(), raw: line });
    }
  }
  return diags;
}

/* -------------------------------------------------------------- run sessions */

const runSessions = new Map();

function startRun({ exe, cwd, args, env }) {
  const id = 'r' + Math.random().toString(36).slice(2, 10);
  const listeners = new Set();
  const broadcast = (obj) => { for (const fn of listeners) fn(obj); };
  let proc;
  try {
    proc = cp.spawn(exe, args || [], { cwd: cwd || path.dirname(exe), env: childEnv([]), windowsHide: false });
  } catch (e) {
    return { error: String(e) };
  }
  const session = {
    id, type: 'run', proc, exe, listeners,
    startTime: Date.now(), exited: false, exitCode: null,
    stop() {
      if (proc.exitCode === null) {
        try { cp.execSync(`taskkill /T /F /PID ${proc.pid}`, { timeout: 3000, windowsHide: true }); }
        catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
      }
    },
  };
  proc.stdout.on('data', (d) => broadcast({ type: 'out', stream: 'stdout', text: d.toString() }));
  proc.stderr.on('data', (d) => broadcast({ type: 'out', stream: 'stderr', text: d.toString() }));
  proc.on('error', (e) => { broadcast({ type: 'out', stream: 'stderr', text: 'Failed to start: ' + e.message + '\r\n' }); });
  proc.on('close', (code, signal) => {
    session.exited = true;
    session.exitCode = code;
    broadcast({ type: 'exit', code, signal });
    setTimeout(() => runSessions.delete(id), 60000);
  });
  runSessions.set(id, session);
  return { id };
}

/* ------------------------------------------------------------- term sessions */

const termSessions = new Map();

function startTerm(cwd) {
  const id = 't' + Math.random().toString(36).slice(2, 10);
  const listeners = new Set();
  const output = [];
  let outputSize = 0;
  const broadcast = (obj) => {
    if (obj.type === 'out' || obj.type === 'error') {
      output.push(obj);
      outputSize += obj.text.length;
      while (outputSize > 128 * 1024) outputSize -= output.shift().text.length;
    }
    for (const fn of listeners) fn(obj);
  };
  const shell = process.env.FULLIDE_SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
  const shellName = path.basename(shell);
  const shellArgs = /^(pwsh|powershell)(\.exe)?$/i.test(shellName)
    ? ['-NoLogo', '-NoProfile', '-NoExit']
    : [];
  const resolvedCwd = path.resolve(cwd || WORKSPACE);
  let proc;
  try {
    proc = cp.spawn(shell, shellArgs, {
      cwd: resolvedCwd,
      env: childEnv([]),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { error: 'Failed to start terminal shell "' + shell + '": ' + e.message };
  }
  const session = {
    id, type: 'term', proc, listeners, output, shell: shellName, cwd: resolvedCwd, exitMessage: null,
    write(data) {
      if (proc.exitCode !== null || proc.stdin.destroyed) return false;
      proc.stdin.write(data);
      return true;
    },
    stop() {
      if (proc.exitCode !== null) return;
      if (process.platform === 'win32' && proc.pid) {
        try { cp.execFile('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { windowsHide: true }, () => {}); }
        catch (e) { proc.kill(); }
      } else {
        proc.kill();
      }
    },
  };
  proc.stdout.on('data', (d) => broadcast({ type: 'out', text: d.toString() }));
  proc.stderr.on('data', (d) => broadcast({ type: 'out', text: d.toString() }));
  proc.stdin.on('error', (e) => broadcast({ type: 'error', text: 'Terminal input failed: ' + e.message + '\r\n' }));
  proc.on('error', (e) => broadcast({ type: 'error', text: 'Terminal failed to start: ' + e.message + '\r\n' }));
  proc.on('close', (code, signal) => {
    session.exitMessage = { type: 'exit', code, signal };
    broadcast(session.exitMessage);
    setTimeout(() => termSessions.delete(id), 60000).unref();
  });
  termSessions.set(id, session);
  return { id, shell: shellName, cwd: resolvedCwd };
}

/* --------------------------------------------------------------- clangd LSP */

const clangdSessions = new Map();
const clangdRoots = new Map();

function clangdSend(session, message) {
  if (session.proc.exitCode !== null || session.proc.stdin.destroyed) {
    throw new Error('clangd is not running');
  }
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  session.proc.stdin.write(Buffer.concat([
    Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'),
    body,
  ]));
}

function clangdRequest(session, method, params, timeoutMs) {
  const id = ++session.nextRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('clangd request timed out: ' + method));
    }, timeoutMs || 15000);
    session.pending.set(id, { resolve, reject, timer, method });
    try {
      clangdSend(session, { jsonrpc: '2.0', id, method, params: params || {} });
    } catch (e) {
      clearTimeout(timer);
      session.pending.delete(id);
      reject(e);
    }
  });
}

function clangdNotify(session, method, params) {
  if (session.status !== 'ready') throw new Error('clangd is not ready');
  clangdSend(session, { jsonrpc: '2.0', method, params: params || {} });
}

function handleClangdMessage(session, message) {
  if (message.method && message.id !== undefined) {
    let result = null;
    if (message.method === 'workspace/configuration') {
      result = (message.params && message.params.items || []).map(() => ({}));
    } else if (message.method === 'workspace/workspaceFolders') {
      result = [{ uri: require('url').pathToFileURL(session.root + path.sep).href, name: path.basename(session.root) }];
    } else if (message.method === 'workspace/applyEdit') {
      result = { applied: false, failureReason: 'FullIDE applies edits from its editor actions.' };
    } else if (!['client/registerCapability', 'window/workDoneProgress/create'].includes(message.method)) {
      clangdSend(session, {
        jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: 'Unsupported clangd client request: ' + message.method },
      });
      return;
    }
    clangdSend(session, { jsonrpc: '2.0', id: message.id, result });
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error)) {
    const pending = session.pending.get(message.id);
    if (pending) {
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'clangd request failed'));
      else pending.resolve(message.result);
    }
    return;
  }
  if (message.method === 'textDocument/publishDiagnostics') {
    session.diagnostics.set(message.params.uri, message.params);
    session.broadcast({ type: 'diagnostics', params: message.params });
  } else if (message.method === 'window/logMessage' || message.method === 'window/showMessage') {
    const params = message.params || {};
    session.broadcast({ type: 'log', message: params.message || '', severity: params.type || 3 });
  }
}

function readClangdMessages(session, chunk) {
  session.buffer = Buffer.concat([session.buffer, chunk]);
  while (true) {
    const boundary = session.buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    const header = session.buffer.subarray(0, boundary).toString('ascii');
    const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) throw new Error('clangd sent an invalid LSP message header');
    const length = Number(lengthMatch[1]);
    const bodyStart = boundary + 4;
    if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) {
      throw new Error('clangd sent an invalid LSP message size');
    }
    if (session.buffer.length < bodyStart + length) return;
    const body = session.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    session.buffer = session.buffer.subarray(bodyStart + length);
    let message;
    try { message = JSON.parse(body); }
    catch (e) { throw new Error('clangd sent invalid JSON: ' + e.message); }
    handleClangdMessage(session, message);
  }
}

function startClangd(root) {
  if (!TOOLS.clangd) return { error: 'clangd was not found. Install clangd or set it on PATH, then restart FullIDE.' };
  const resolvedRoot = path.resolve(root || WORKSPACE);
  let stat;
  try { stat = fs.statSync(resolvedRoot); }
  catch (e) { return { error: 'Cannot start clangd: ' + e.message }; }
  if (!stat.isDirectory()) return { error: 'clangd project root is not a directory' };
  const rootKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const existingId = clangdRoots.get(rootKey);
  const existing = existingId && clangdSessions.get(existingId);
  if (existing && existing.status !== 'stopped' && existing.status !== 'failed') {
    return { id: existing.id, root: resolvedRoot, status: existing.status };
  }

  const id = 'c' + Math.random().toString(36).slice(2, 10);
  let proc;
  try {
    const databaseDir = path.join(resolvedRoot, 'build');
    const args = ['--background-index'];
    const drivers = [TOOLS.gxx, TOOLS.gcc, TOOLS.clang].filter(Boolean);
    if (drivers.length) args.push('--query-driver=' + drivers.join(','));
    if (fs.existsSync(path.join(databaseDir, 'compile_commands.json'))) {
      args.push('--compile-commands-dir=' + databaseDir);
    } else if (fs.existsSync(path.join(resolvedRoot, 'compile_commands.json'))) {
      args.push('--compile-commands-dir=' + resolvedRoot);
    }
    proc = cp.spawn(TOOLS.clangd, args, {
      cwd: resolvedRoot,
      env: childEnv([]),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { error: 'Failed to start clangd: ' + e.message };
  }

  const session = {
    id, proc, root: resolvedRoot, rootKey, status: 'starting', buffer: Buffer.alloc(0),
    nextRequestId: 0, pending: new Map(), listeners: new Set(), events: [],
    diagnostics: new Map(), documents: new Map(), exitMessage: null,
    broadcast(event) {
      if (event.type === 'diagnostics') {
        this.diagnostics.set(event.params.uri, event.params);
      } else {
        this.events.push(event);
        if (this.events.length > 100) this.events.shift();
      }
      for (const listener of this.listeners) listener(event);
    },
  };
  session.ready = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });
  session.ready.catch(() => {});
  clangdSessions.set(id, session);
  clangdRoots.set(rootKey, id);

  proc.stdout.on('data', (chunk) => {
    try { readClangdMessages(session, chunk); }
    catch (e) {
      session.status = 'failed';
      session.broadcast({ type: 'error', message: e.message });
      proc.kill();
    }
  });
  proc.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim();
    if (message) session.broadcast({ type: 'log', message, severity: 2 });
  });
  proc.on('error', (e) => {
    session.status = 'failed';
    session.exitMessage = { type: 'status', status: 'failed', message: e.message };
    session.rejectReady(e);
    session.broadcast(session.exitMessage);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(e);
    }
    session.pending.clear();
  });
  proc.on('close', (code, signal) => {
    const message = session.status === 'failed' ? 'clangd exited after an error' : 'clangd stopped';
    if (session.status !== 'failed') session.status = 'stopped';
    session.exitMessage = { type: 'status', status: session.status, code, signal, message };
    session.rejectReady(new Error(message));
    session.broadcast(session.exitMessage);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    session.pending.clear();
    if (clangdRoots.get(rootKey) === id) clangdRoots.delete(rootKey);
    setTimeout(() => clangdSessions.delete(id), 60000).unref();
  });

  (async () => {
    try {
      const rootUri = require('url').pathToFileURL(resolvedRoot + path.sep).href;
      const initialized = await clangdRequest(session, 'initialize', {
        processId: process.pid,
        clientInfo: { name: 'FullIDE', version: '1.0.0' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(resolvedRoot) }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            completion: {
              completionItem: {
                snippetSupport: true, commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true,
                preselectSupport: true, insertReplaceSupport: true,
                resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
              },
            },
            publishDiagnostics: { versionSupport: true, relatedInformation: true },
            definition: { linkSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            formatting: { dynamicRegistration: false },
            rename: { prepareSupport: true },
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } } },
          },
          workspace: { applyEdit: false, workspaceFolders: true, configuration: true },
        },
        initializationOptions: { clangdFileStatus: true },
      });
      if (session.status !== 'starting') return;
      session.capabilities = initialized && initialized.capabilities || {};
      clangdSend(session, { jsonrpc: '2.0', method: 'initialized', params: {} });
      session.status = 'ready';
      session.resolveReady(session);
      session.broadcast({ type: 'status', status: 'ready', message: 'clangd ready' });
    } catch (e) {
      if (session.status !== 'failed' && session.status !== 'stopped') {
        session.status = 'failed';
        session.exitMessage = { type: 'status', status: 'failed', message: e.message };
        session.rejectReady(e);
        session.broadcast(session.exitMessage);
        proc.kill();
      }
    }
  })();
  return { id, root: resolvedRoot, status: session.status };
}

function stopClangd(session) {
  if (session.status === 'stopped' || session.status === 'failed' || session.status === 'stopping') return;
  const wasReady = session.status === 'ready';
  session.status = 'stopping';
  if (clangdRoots.get(session.rootKey) === session.id) clangdRoots.delete(session.rootKey);
  if (!wasReady) {
    setTimeout(() => { if (session.proc.exitCode === null) session.proc.kill(); }, 100).unref();
    return;
  }
  clangdRequest(session, 'shutdown', {}, 1000)
    .catch((e) => session.broadcast({ type: 'log', message: 'clangd shutdown request failed: ' + e.message, severity: 2 }))
    .finally(() => {
      try {
        if (session.proc.exitCode === null) clangdSend(session, { jsonrpc: '2.0', method: 'exit', params: null });
      } catch (e) {}
      setTimeout(() => { if (session.proc.exitCode === null) session.proc.kill(); }, 500).unref();
    });
}

/* ----------------------------------------------------------- debug sessions */

const debugSessions = new Map();

function startDebug({ exe, cwd, args }) {
  if (!TOOLS.gdb) return { error: 'gdb not found' };
  const id = 'd' + Math.random().toString(36).slice(2, 10);
  const listeners = new Set();
  const broadcast = (obj) => { for (const fn of listeners) fn(obj); };
  const proc = cp.spawn(TOOLS.gdb, ['--interpreter=mi2', '-ex', 'set confirm off', '-ex', 'set print pretty on', '-ex', 'set pagination off'], {
    cwd: cwd || path.dirname(exe), env: childEnv([]), windowsHide: true,
  });
  let buf = '';
  const session = {
    id, type: 'debug', proc, exe, listeners, running: false, exited: false,
    send(mi) { try { proc.stdin.write(mi + '\n'); } catch (e) {} },
    stop() {
      try { proc.stdin.write('-gdb-exit\n'); } catch (e) {}
      setTimeout(() => { try { proc.kill(); } catch (e) {} }, 500);
    },
  };
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.trim() === '' || line === '(gdb)') continue;
      broadcast({ type: 'mi', line });
    }
  });
  proc.stderr.on('data', (d) => broadcast({ type: 'out', text: d.toString() }));
  proc.on('close', () => { session.exited = true; broadcast({ type: 'exit' }); debugSessions.delete(id); });
  debugSessions.set(id, session);
  return { id };
}

/* ------------------------------------------------------------------- builds */

function collectSources(root) {
  const out = [];
  const walkFiles = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkFiles(full, depth + 1);
      else if (/\.(c|cc|cpp|cxx|C)$/.test(ent.name)) out.push(full);
    }
  };
  walkFiles(root, 0);
  return out;
}

function buildFallback(root) {
  const sources = collectSources(root);
  if (sources.length === 0) return { ok: false, output: 'No C/C++ source files found in project.', diagnostics: [], exePath: null };
  const isCpp = sources.some((f) => /\.(cc|cpp|cxx|C)$/.test(f));
  const compiler = isCpp ? (TOOLS.gxx || TOOLS.clang) : (TOOLS.gcc || TOOLS.clang);
  if (!compiler) return { ok: false, output: 'No compiler found (g++/gcc/clang++).', diagnostics: [], exePath: null };

  let usesRaylib = false;
  for (const f of sources) {
    try { if (/^\s*#\s*include\s*[<"]raylib\.h[>"]/m.test(fs.readFileSync(f, 'utf8'))) { usesRaylib = true; break; } } catch (e) {}
  }
  const projectName = path.basename(path.resolve(root));
  const binDir = path.join(root, 'bin');
  try { fs.mkdirSync(binDir, { recursive: true }); } catch (e) {}
  const exePath = path.join(binDir, projectName + '.exe');

  const std = isCpp ? 'c++23' : 'c17';
  const args = ['-std=' + std, '-g', '-O2', '-Wall', '-Wextra', '-I' + path.join(root, 'include'), '-I' + path.join(root, 'src')];
  const compileArgs = args.slice();
  if (usesRaylib && TOOLS.raylib) {
    args.push('-L' + TOOLS.raylibLib, '-lraylib', '-lopengl32', '-lgdi32', '-lwinmm', '-luser32', '-static-libgcc');
  }
  args.push('-o', exePath, ...sources);

  const t0 = Date.now();
  const r = cp.spawnSync(compiler, args, { cwd: root, env: childEnv([]), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  let output = (r.stdout || '') + (r.stderr || '');
  try {
    const databaseDir = path.join(root, 'build');
    fs.mkdirSync(databaseDir, { recursive: true });
    const database = sources.map((file) => ({
      directory: root,
      file,
      arguments: [compiler, ...compileArgs, '-c', file],
    }));
    fs.writeFileSync(path.join(databaseDir, 'compile_commands.json'), JSON.stringify(database, null, 2));
  } catch (e) {
    output += '\nWarning: could not write clangd compilation database: ' + e.message + '\n';
  }
  return {
    ok: r.status === 0,
    output,
    diagnostics: parseDiagnostics(output, root),
    exePath: r.status === 0 ? exePath : null,
    compiler, usesRaylib,
    duration: Date.now() - t0,
    mode: 'direct',
  };
}

function buildCMake(root) {
  const buildDir = path.join(root, 'build');
  const t0 = Date.now();
  let output = '';
  const runStep = (cmd, args, label) => {
    output += `\n=== ${label} ===\n`;
    const r = cp.spawnSync(cmd, args, { cwd: root, env: childEnv([]), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
    output += (r.stdout || '') + (r.stderr || '');
    return r.status === 0;
  };
  const ok = runStep(TOOLS.cmake, ['-S', '.', '-B', 'build', '-G', 'Ninja', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], 'Configure')
    && runStep(TOOLS.cmake, ['--build', 'build', '--parallel', '4'], 'Build');

  // find newest exe under build/
  let exePath = null, newest = 0;
  const scan = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) scan(full, depth + 1);
      else if (/\.exe$/i.test(ent.name)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > newest) { newest = st.mtimeMs; exePath = full; }
        } catch (e) {}
      }
    }
  };
  if (ok) scan(buildDir, 0);
  return { ok, output, diagnostics: parseDiagnostics(output, root), exePath, duration: Date.now() - t0, mode: 'cmake' };
}

function buildProject(root) {
  if (fs.existsSync(path.join(root, 'CMakeLists.txt')) && TOOLS.cmake && TOOLS.ninja) return buildCMake(root);
  if (fs.existsSync(path.join(root, 'CMakeLists.txt')) && TOOLS.cmake && TOOLS.make) {
    // CMake with Makefiles — reconfigure with default generator
    const buildDir = path.join(root, 'build');
    let output = '';
    const runStep = (args, label) => {
      output += `\n=== ${label} ===\n`;
      const r = cp.spawnSync(TOOLS.cmake, args, { cwd: root, env: childEnv([]), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
      output += (r.stdout || '') + (r.stderr || '');
      return r.status === 0;
    };
    const ok = runStep(['-S', '.', '-B', 'build', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], 'Configure') && runStep(['--build', 'build'], 'Build');
    let exePath = null, newest = 0;
    const scan = (dir, depth) => {
      if (depth > 6) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) scan(full, depth + 1);
        else if (/\.exe$/i.test(ent.name)) {
          try { const st = fs.statSync(full); if (st.mtimeMs > newest) { newest = st.mtimeMs; exePath = full; } } catch (e) {}
        }
      }
    };
    if (ok) scan(buildDir, 0);
    return { ok, output, diagnostics: parseDiagnostics(output, root), exePath, duration: 0, mode: 'cmake-make' };
  }
  return buildFallback(root);
}

/* --------------------------------------------------------------- file search */

const SEARCH_EXTS = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.hxx', '.txt', '.cmake', '.md', '.in', '.lua', '.py', '.json', '.ini', '.cfg', '.glsl', '.vert', '.frag']);

function searchFiles(root, query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  const results = [];
  let flags = 'g';
  if (!caseSensitive) flags += 'i';
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (wholeWord ? '\\b' : ''), flags);
  } catch (e) { return { error: 'Invalid search pattern' }; }
  const limit = 500;
  const scan = (dir, depth) => {
    if (depth > 7 || results.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { scan(full, depth + 1); continue; }
      if (!SEARCH_EXTS.has(path.extname(ent.name))) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          results.push({ path: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= limit) return;
        }
      }
    }
  };
  scan(root, 0);
  return { results, truncated: results.length >= limit };
}

/* ------------------------------------------------------------------ outline */

function outline(pathname) {
  let content;
  try { content = fs.readFileSync(pathname, 'utf8'); } catch (e) { return []; }
  const lines = content.split(/\r?\n/);
  const symbols = [];
  const funcRe = /^\s*(?:(?:static|inline|virtual|explicit|constexpr|const|extern|template\s*<[^>]*>)\s+)*[\w:~]+\s+([\w~]+)\s*\(([^;]*)\)\s*(?:const)?\s*\{/;
  const classRe = /^\s*(?:class|struct|union|enum\s+class)\s+([\w]+)/;
  const enumRe = /^\s*enum\s+([\w]+)/;
  const defineRe = /^\s*#\s*define\s+([\w]+)/;
  const namespaceRe = /^\s*namespace\s+([\w]+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = funcRe.exec(line);
    if (m && !line.includes(';')) { symbols.push({ kind: 'function', name: m[1], line: i + 1, detail: '(' + m[2].trim().slice(0, 60) + ')' }); continue; }
    m = classRe.exec(line);
    if (m) { symbols.push({ kind: 'class', name: m[1], line: i + 1 }); continue; }
    m = defineRe.exec(line);
    if (m) { symbols.push({ kind: 'macro', name: m[1], line: i + 1 }); continue; }
    m = namespaceRe.exec(line);
    if (m) { symbols.push({ kind: 'namespace', name: m[1], line: i + 1 }); continue; }
  }
  return symbols;
}

/* -------------------------------------------------------------- http server */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
  const u = url.parse(req.url, true);
  const pathname = u.pathname;

  if (req.method === 'GET' && pathname === '/api/env') return sendJSON(res, 200, {
    tools: TOOLS, workspace: WORKSPACE,
    clangd: { available: !!TOOLS.clangd, path: TOOLS.clangd },
  });

  if (req.method === 'GET' && pathname === '/api/settings') {
    try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(path.join(SETTINGS_DIR, 'settings.json'), 'utf8'))); }
    catch (e) { return sendJSON(res, 200, {}); }
  }
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = JSON.parse(await readBody(req));
    fs.writeFileSync(path.join(SETTINGS_DIR, 'settings.json'), JSON.stringify(body, null, 2));
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/templates') return sendJSON(res, 200, TEMPLATES.list());

  if (req.method === 'POST' && pathname === '/api/newproject') {
    const { root, name, template } = JSON.parse(await readBody(req));
    const projDir = path.join(path.resolve(root || WORKSPACE), name);
    try {
      fs.mkdirSync(projDir, { recursive: true });
      const files = TEMPLATES.files(template, name);
      for (const f of files) {
        const fp = path.join(projDir, f.name);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, f.content);
      }
      return sendJSON(res, 200, { path: projDir, files: files.length });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (req.method === 'GET' && pathname === '/api/dirs') {
    const p = u.query.path ? path.resolve(u.query.path) : WORKSPACE;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) throw new Error('Not a directory');
      let entries = fs.readdirSync(p, { withFileTypes: true });
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      const dirs = entries.filter((e) => e.isDirectory() && !IGNORE_DIRS_TREE.has(e.name))
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }));
      const files = entries.filter((e) => e.isFile() && /\.(c|cc|cpp|cxx|h|hpp|txt|cmake|md)$/i.test(e.name))
        .map((e) => ({ name: e.name, path: path.join(p, e.name) }));
      return sendJSON(res, 200, {
        path: p,
        parent: path.dirname(p) === p ? null : path.dirname(p),
        dirs, files,
        hasCMake: entries.some((e) => e.name === 'CMakeLists.txt'),
      });
    } catch (e) { return sendJSON(res, 400, { error: String(e) }); }
  }

  if (req.method === 'GET' && pathname === '/api/tree') {
    const p = u.query.path;
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory()) return sendJSON(res, 400, { error: 'Not a directory' });
      const out = [];
      walk(p, 6, 0, out, IGNORE_DIRS_TREE);
      return sendJSON(res, 200, { root: p, children: out });
    } catch (e) { return sendJSON(res, 400, { error: String(e) }); }
  }

  if (req.method === 'GET' && pathname === '/api/file') {
    const p = u.query.path;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) return sendJSON(res, 400, { error: 'Is a directory' });
      if (st.size > 8 * 1024 * 1024) return sendJSON(res, 200, { binary: true, size: st.size });
      const content = fs.readFileSync(p, 'utf8');
      return sendJSON(res, 200, { path: p, content, size: st.size });
    } catch (e) { return sendJSON(res, 400, { error: String(e) }); }
  }

  if (req.method === 'POST' && pathname === '/api/save') {
    const { path: p, content } = JSON.parse(await readBody(req));
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (req.method === 'POST' && pathname === '/api/create') {
    const { path: p, kind } = JSON.parse(await readBody(req));
    try {
      if (kind === 'dir') fs.mkdirSync(p, { recursive: true });
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (req.method === 'POST' && pathname === '/api/rename') {
    const { from, to } = JSON.parse(await readBody(req));
    try { fs.renameSync(from, to); return sendJSON(res, 200, { ok: true }); }
    catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (req.method === 'POST' && pathname === '/api/delete') {
    const { path: p } = JSON.parse(await readBody(req));
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    const r = searchFiles(u.query.path, u.query.q || '', {
      caseSensitive: u.query.case === '1', wholeWord: u.query.word === '1', regex: u.query.regex === '1',
    });
    return sendJSON(res, 200, r);
  }

  if (req.method === 'GET' && pathname === '/api/outline') {
    return sendJSON(res, 200, { symbols: outline(u.query.path) });
  }

  if (req.method === 'POST' && pathname === '/api/build') {
    const { root } = JSON.parse(await readBody(req));
    try { return sendJSON(res, 200, buildProject(path.resolve(root))); }
    catch (e) { return sendJSON(res, 500, { ok: false, output: String(e), diagnostics: [] }); }
  }

  if (req.method === 'POST' && pathname === '/api/run') {
    const body = JSON.parse(await readBody(req));
    return sendJSON(res, 200, startRun(body));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/run/')) {
    const id = pathname.split('/')[3];
    const s = runSessions.get(id);
    if (!s) return sendJSON(res, 404, { error: 'no session' });
    const send = sse(res);
    s.listeners.add(send);
    res.on('close', () => s.listeners.delete(send));
    if (s.exited) send({ type: 'exit', code: s.exitCode });
    return;
  }
  if (req.method === 'POST' && pathname.startsWith('/api/run/') && pathname.endsWith('/stop')) {
    const id = pathname.split('/')[3];
    const s = runSessions.get(id);
    if (s) s.stop();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/clangd/start') {
    const body = JSON.parse(await readBody(req));
    const result = startClangd(body.root);
    return sendJSON(res, result.error ? 503 : 200, result);
  }
  if (pathname.startsWith('/api/clangd/')) {
    const parts = pathname.split('/');
    const session = clangdSessions.get(parts[3]);
    if (!session) return sendJSON(res, 404, { error: 'no clangd session' });
    if (req.method === 'GET' && parts[4] === 'stream') {
      const send = sse(res);
      session.listeners.add(send);
      res.on('close', () => session.listeners.delete(send));
      for (const event of session.events) send(event);
      for (const params of session.diagnostics.values()) send({ type: 'diagnostics', params });
      if (session.exitMessage) send(session.exitMessage);
      return;
    }
    if (req.method === 'POST' && parts[4] === 'request') {
      const { method, params } = JSON.parse(await readBody(req));
      const allowed = new Set([
        'textDocument/completion', 'textDocument/definition', 'textDocument/hover',
        'textDocument/formatting', 'textDocument/rename', 'textDocument/codeAction',
        'textDocument/signatureHelp', 'textDocument/documentSymbol',
      ]);
      if (!allowed.has(method)) return sendJSON(res, 400, { error: 'unsupported clangd request' });
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return sendJSON(res, 400, { error: 'clangd request params must be an object' });
      }
      await session.ready;
      return sendJSON(res, 200, { result: await clangdRequest(session, method, params) });
    }
    if (req.method === 'POST' && parts[4] === 'notify') {
      const { method, params } = JSON.parse(await readBody(req));
      const allowed = new Set([
        'textDocument/didOpen', 'textDocument/didChange',
        'textDocument/didSave', 'textDocument/didClose',
      ]);
      if (!allowed.has(method)) return sendJSON(res, 400, { error: 'unsupported clangd notification' });
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return sendJSON(res, 400, { error: 'clangd notification params must be an object' });
      }
      if (!params.textDocument || typeof params.textDocument.uri !== 'string') {
        return sendJSON(res, 400, { error: 'clangd notification requires a document URI' });
      }
      await session.ready;
      if (method === 'textDocument/didOpen') {
        session.documents.set(params.textDocument.uri, params.textDocument.version);
      } else if (method === 'textDocument/didClose') {
        session.documents.delete(params.textDocument.uri);
        session.diagnostics.delete(params.textDocument.uri);
      } else if (method === 'textDocument/didChange') {
        session.documents.set(params.textDocument.uri, params.textDocument.version);
      }
      clangdNotify(session, method, params);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[4] === 'stop') {
      stopClangd(session);
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && pathname === '/api/term') {
    const { cwd } = JSON.parse(await readBody(req));
    const term = startTerm(cwd);
    return sendJSON(res, term.error ? 500 : 200, term);
  }
  if (req.method === 'GET' && pathname.startsWith('/api/term/')) {
    const id = pathname.split('/')[3];
    const s = termSessions.get(id);
    if (!s) return sendJSON(res, 404, { error: 'no session' });
    const send = sse(res);
    s.listeners.add(send);
    res.on('close', () => s.listeners.delete(send));
    for (const msg of s.output) send(msg);
    if (s.exitMessage) send(s.exitMessage);
    return;
  }
  if (req.method === 'POST' && pathname.startsWith('/api/term/') && pathname.endsWith('/write')) {
    const id = pathname.split('/')[3];
    const s = termSessions.get(id);
    const { data } = JSON.parse(await readBody(req));
    if (!s) return sendJSON(res, 404, { error: 'no terminal session' });
    if (typeof data !== 'string') return sendJSON(res, 400, { error: 'terminal input must be a string' });
    if (!s.write(data)) return sendJSON(res, 409, { error: 'terminal process is not accepting input' });
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname.startsWith('/api/term/') && pathname.endsWith('/kill')) {
    const id = pathname.split('/')[3];
    const s = termSessions.get(id);
    if (!s) return sendJSON(res, 404, { error: 'no terminal session' });
    s.stop();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/debug/start') {
    const body = JSON.parse(await readBody(req));
    return sendJSON(res, 200, startDebug(body));
  }
  if (req.method === 'POST' && pathname.startsWith('/api/debug/') && pathname.endsWith('/send')) {
    const id = pathname.split('/')[3];
    const s = debugSessions.get(id);
    const { mi } = JSON.parse(await readBody(req));
    if (s) s.send(mi);
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname.startsWith('/api/debug/')) {
    const id = pathname.split('/')[3];
    const s = debugSessions.get(id);
    if (!s) return sendJSON(res, 404, { error: 'no session' });
    const send = sse(res);
    s.listeners.add(send);
    res.on('close', () => s.listeners.delete(send));
    return;
  }
  if (req.method === 'POST' && pathname.startsWith('/api/debug/') && pathname.endsWith('/stop')) {
    const id = pathname.split('/')[3];
    const s = debugSessions.get(id);
    if (s) s.stop();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/git/status') {
    const p = u.query.path;
    try {
      const r = cp.spawnSync('git', ['-C', p, 'status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 30000 });
      return sendJSON(res, 200, { output: r.stdout, isRepo: r.status !== 128 });
    } catch (e) { return sendJSON(res, 200, { output: '', isRepo: false }); }
  }
  if (req.method === 'GET' && pathname === '/api/git/log') {
    const p = u.query.path;
    try {
      const r = cp.spawnSync('git', ['-C', p, 'log', '--oneline', '-30', '--decorate'], { encoding: 'utf8', timeout: 30000 });
      return sendJSON(res, 200, { output: r.stdout });
    } catch (e) { return sendJSON(res, 200, { output: '' }); }
  }
  if (req.method === 'POST' && pathname === '/api/git/commit') {
    const { path: p, message } = JSON.parse(await readBody(req));
    try {
      cp.spawnSync('git', ['-C', p, 'add', '-A'], { encoding: 'utf8', timeout: 60000 });
      const r = cp.spawnSync('git', ['-C', p, 'commit', '-m', message], { encoding: 'utf8', timeout: 60000 });
      return sendJSON(res, 200, { output: (r.stdout || '') + (r.stderr || '') });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }
  if (req.method === 'POST' && pathname === '/api/git/init') {
    const { path: p } = JSON.parse(await readBody(req));
    try {
      const r = cp.spawnSync('git', ['-C', p, 'init'], { encoding: 'utf8', timeout: 30000 });
      return sendJSON(res, 200, { output: (r.stdout || '') + (r.stderr || '') });
    } catch (e) { return sendJSON(res, 500, { error: String(e) }); }
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown API: ' + pathname });
  return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('request error:', e);
    if (!res.headersSent) sendJSON(res, 400, { error: String(e && e.message || e) });
    else res.end();
  }
});

process.on('uncaughtException', (e) => console.error('uncaught', e));

const PORT = process.env.FULLIDE_PORT || 6248;
server.listen(PORT, () => {
  console.log(`FullIDE server running at http://localhost:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Toolchain: ${TOOLS.gxx ? 'g++' : '?'} ${TOOLS.cmake ? '+cmake' : ''} ${TOOLS.ninja ? '+ninja' : ''} ${TOOLS.gdb ? '+gdb' : ''} raylib:${TOOLS.raylib ? 'yes' : 'no'}`);
});
