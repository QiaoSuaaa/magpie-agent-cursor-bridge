import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {read as readBridgeSettings, write as writeBridgeSettings, defaults as bridgeDefaults, rules as bridgeRules, modes as bridgeModes, subagentModes as bridgeSubagentModes, tabModes as bridgeTabModes, settingsFile} from '../lib/bridge-settings.js';
import {readDatabase, cleanDatabase, extractCursorAuthToken} from './database.js';
import {validate, gatewayModels} from '../lib/config.js';
import {atomic} from '../lib/settings.js';
import platform from '../lib/platform.js';

// The control console is served from the Magpie plugin host. It runs the
// same setup.command the user would type in a terminal, so the panel and
// the CLI can never disagree about what "start" or "restart" means.
//
// Security model (mirrors the sandboxed panel that opens it):
//  - loopback only, and the Host header must be this very server;
//  - the page runs in an opaque-origin sandbox, so it needs CORS with
//    Access-Control-Allow-Origin: null and a per-process token;
//  - the token is inline in the HTML only. /api/* without it is refused,
//    which keeps any other opaque-origin frame from driving the bridge.
const TOKEN_HEADER = 'x-magpiebridge-token';
const LABEL = 'local.magpie.cursor-bridge';
const MAX_BODY = 16 * 1024;
const ACTION_TIMEOUT = 180000;
let busy = null;
let busyAt = 0;

function resolveDataDir(root, home) {
  if (process.env.CURSOR_BYOK_DATA_DIR && process.env.CURSOR_BYOK_DATA_DIR.trim()) {
    return process.env.CURSOR_BYOK_DATA_DIR.trim();
  }
  if (process.env.CURSOR_DATA_DIR && process.env.CURSOR_DATA_DIR.trim()) {
    return process.env.CURSOR_DATA_DIR.trim();
  }
  // 1. 检查插件 config 目录下的 data_location.txt
  const pointerFile = path.join(root, 'data_location.txt');
  try {
    if (fs.existsSync(pointerFile)) {
      const target = fs.readFileSync(pointerFile, 'utf8').trim();
      if (target && fs.existsSync(target)) return target;
    }
  } catch {}
  // 2. 检查 Cursor BYOK 默认主目录下的 data_location.txt（自动继承用户原本在 E 盘等设置的重定向指针！）
  const byokPointer = path.join(home || os.homedir(), '.cursor-byok-v3', 'data_location.txt');
  try {
    if (fs.existsSync(byokPointer)) {
      const target = fs.readFileSync(byokPointer, 'utf8').trim();
      if (target && fs.existsSync(target)) return target;
    }
  } catch {}
  return path.join(root, 'data');
}

function resolveDatabaseFile(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const bridgeDb = path.join(dataDir, 'bridge.db');
  const byokDb = path.join(dataDir, 'cursor-byok.db');
  if (fs.existsSync(bridgeDb)) return bridgeDb;
  if (fs.existsSync(byokDb)) return byokDb;
  return bridgeDb;
}

function copyDirRecursiveSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'data_location.txt' || entry.name.endsWith('-shm')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function paths(repoRoot) {
  // CURSOR_BRIDGE_HOME keeps tests (and a portable copy) away from the real
  // ~/.config; the normal path is always the user's home.
  const home = process.env.CURSOR_BRIDGE_HOME || os.homedir();
  const layout = platform.pathsFor(home);
  const root = layout.config;
  const share = layout.share;
  const dataDir = resolveDataDir(root, home);
  const dbFile = resolveDatabaseFile(dataDir);
  // Magpie may write the agent connection to a different file on Windows;
  // `connections` lists the same candidates the supervisor reads.
  const connections = platform.current.connectionFiles(home);
  return {
    home,
    root,
    share,
    data: dataDir,
    database: dbFile,
    databaseWal: `${dbFile}-wal`,
    databaseShm: `${dbFile}-shm`,
    plist: layout.plist,
    autostart: layout.autostart || null,
    status: path.join(root, 'status.json'),
    effective: path.join(root, 'effective.json'),
    installation: path.join(root, 'installation.json'),
    connection: connections[0],
    connections,
    supervisorPid: path.join(root, 'supervisor.lock/pid'),
    engineLog: path.join(root, 'engine.log'),
    supervisorLog: path.join(root, 'supervisor.log'),
    supervisorError: path.join(root, 'supervisor-error.log'),
    settings: settingsFile(root),
    setup: path.join(repoRoot, 'setup.command'),
    repo: repoRoot
  };
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const readPid = (file) => {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
};
const stat = (file) => {
  try {
    const s = fs.statSync(file);
    return {size: s.size, updated: s.mtime.toISOString()};
  } catch { return null; }
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 快速安全读取大日志文件末尾 N 行，防止撑爆内存
 * @param {string} filePath 日志文件绝对路径
 * @param {number} maxLines 最大行数（默认 80 行）
 */
function readLogTail(filePath, maxLines = 80) {
  if (!fs.existsSync(filePath)) return { text: '(日志文件尚不存在)', lines: 0 };
  try {
    const s = fs.statSync(filePath);
    if (s.size === 0) return { text: '(日志文件为空)', lines: 0 };
    const readSize = Math.min(s.size, 128 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, s.size - readSize);
    fs.closeSync(fd);
    let str = buf.toString('utf8');
    if (readSize < s.size) {
      const firstNewline = str.indexOf('\n');
      if (firstNewline !== -1) str = str.slice(firstNewline + 1);
    }
    const lines = str.split(/\r?\n/);
    const slice = lines.slice(-maxLines);
    return { text: slice.join('\n').trim(), lines: slice.length };
  } catch (err) {
    return { text: `读取日志异常: ${err.message}`, lines: 0 };
  }
}

function run(command, args, {timeout = 15000} = {}) {
  return new Promise((resolve) => {
    // windowsHide is a no-op off Windows; there it keeps the PowerShell pid
    // probe from flashing a console window on every status poll.
    execFile(command, args, {encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true}, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : (error ? null : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

async function commandOf(pid) {
  if (!alive(pid)) return '';
  const probe = platform.current.processCommand(pid);
  if (!probe) return '';
  const result = await run(probe.command, probe.args, {timeout: 5000});
  return result.ok ? result.stdout.trim() : '';
}

async function stopProcess(pid, marker, graceMs) {
  if (!alive(pid)) return false;
  const command = await commandOf(pid);
  if (!command.includes(marker)) return false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(pid, signal); } catch { return false; }
    const until = Date.now() + graceMs;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await wait(150);
    }
  }
  return !alive(pid);
}

async function launchAgentState(repoRoot) {
  if (!platform.serviceSupported) return {registered: false, state: null, pid: null, supported: false};
  if (platform.IS_WIN) {
    // Windows autostart is a launcher script in the user's Startup folder,
    // not a scheduled task: creating an ONLOGON task needs elevation the
    // console cannot request.
    const p = paths(repoRoot);
    const pid = readPid(p.supervisorPid);
    const registered = !!p.autostart && fs.existsSync(p.autostart);
    return {
      registered,
      state: pid ? (alive(pid) ? 'running' : 'stopped') : (registered ? 'ready' : null),
      pid,
      supported: true
    };
  }
  const domain = `gui/${process.getuid()}`;
  const result = await run('/bin/launchctl', ['print', `${domain}/${LABEL}`], {timeout: 10000});
  if (!result.ok) return {registered: false, state: null, pid: null, supported: true};
  const state = /state = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() || null;
  const pid = Number(/pid = (\d+)/.exec(result.stdout)?.[1] || 0) || null;
  return {registered: true, state, pid, supported: true};
}

/// 解析并获取 Magpie 客户端传递的连接配置及全部可用模型列表
function safeConnection(repoRoot) {
  let data = null;
  for (const candidate of paths(repoRoot).connections) {
    if (!fs.existsSync(candidate)) continue;
    data = readJson(candidate);
    break;
  }
  const availableModels = [];
  if (Array.isArray(data?.models)) {
    for (const m of data.models) {
      const id = typeof m === 'string' ? m : (m?.id || m?.name);
      if (id && !availableModels.includes(id)) availableModels.push(id);
    }
  }
  // 额外从 effective.json 读取备用模型列表，保证在任何阶段都能获取到完整模型清单
  const p = paths(repoRoot);
  const effFile = path.join(p.root, 'effective.json');
  if (fs.existsSync(effFile)) {
    try {
      const eff = JSON.parse(fs.readFileSync(effFile, 'utf8'));
      if (Array.isArray(eff?.models)) {
        for (const m of eff.models) {
          const id = typeof m === 'string' ? m : (m?.id || m?.name);
          if (id && !availableModels.includes(id)) availableModels.push(id);
        }
      }
    } catch {}
  }

  if (!data || typeof data !== 'object') {
    return {exists: false, models: availableModels.length, modelList: availableModels};
  }
  return {
    exists: true,
    enabled: data.enabled === true,
    model: typeof data.model === 'string' ? data.model : null,
    models: availableModels.length || (Array.isArray(data.models) ? data.models.length : 0),
    modelList: availableModels,
    gateway: typeof data.gateway === 'string' ? data.gateway : null
  };
}

async function overview(repoRoot, port) {
  const p = paths(repoRoot);
  const installation = readJson(p.installation);
  const runtime = readJson(p.status);
  const supervisorPid = readPid(p.supervisorPid);
  const supervisorAlive = !!supervisorPid && alive(supervisorPid);
  const enginePid = Number(runtime?.pid) || null;
  const engineAlive = !!enginePid && alive(enginePid);
  const agent = await launchAgentState(repoRoot);
  const connection = safeConnection(repoRoot);
  return {
    now: new Date().toISOString(),
    version: typeof installation?.version === 'string' ? installation.version : null,
    installation: installation ? {
      version: installation.version || null,
      installed: installation.installed || null,
      release: installation.release || null,
      source: installation.source || null
    } : null,
    runtime: runtime ? {
      state: runtime.state || null,
      model: runtime.model || null,
      models: Number(runtime.models) || 0,
      proxy: runtime.proxy || null,
      backend: runtime.backend || null,
      pid: Number(runtime.pid) || null,
      updated: runtime.updated || null,
      warning: runtime.warning || null,
      reason: runtime.reason || null
    } : null,
    supervisor: {
      pid: supervisorPid,
      alive: supervisorAlive,
      expected: supervisorAlive
    },
    engine: {
      pid: enginePid,
      alive: engineAlive,
      expected: engineAlive
    },
    launchAgent: agent,
    platform: platform.platform,
    serviceSupported: platform.serviceSupported,
    connection,
    availableModels: connection.modelList || [],
    database: stat(p.database),
    settings: {
      values: readBridgeSettings(p.root),
      defaults: bridgeDefaults,
      rules: bridgeRules,
      modes: bridgeModes,
      subagentModes: bridgeSubagentModes,
      tabModes: bridgeTabModes,
      file: p.settings
    },
    paths: {
      configDir: p.root,
      installDir: p.share,
      dataDir: p.data,
      databaseFile: p.database,
      plist: p.plist,
      repo: p.repo,
      setup: p.setup
    },
    logs: {
      engine: stat(p.engineLog),
      supervisor: stat(p.supervisorLog),
      error: stat(p.supervisorError)
    },
    control: {port, pid: process.pid, uptime: Math.round(process.uptime())}
  };
}

function capture(child, resolve) {
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer = null;
  const clip = (text) => text.length > 60000 ? text.slice(-60000) : text;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve({...value, stdout, stderr});
  };
  child.stdout?.on('data', (chunk) => { stdout = clip(stdout + chunk); });
  child.stderr?.on('data', (chunk) => { stderr = clip(stderr + chunk); });
  child.once('error', (error) => finish({ok: false, code: null, error: String(error.message || error)}));
  child.once('close', (code) => finish(code === 0
    ? {ok: true, code: 0, error: ''}
    : {ok: false, code, error: `命令退出码 ${code ?? '未知'}`}));
  timer = setTimeout(() => {
    if (settled) return;
    try { child.kill('SIGTERM'); } catch {}
    finish({ok: false, code: null, error: '命令超时（180 秒）', timedOut: true});
  }, ACTION_TIMEOUT);
}

function installerCommand(repoRoot, action) {
  const p = paths(repoRoot);
  if (platform.IS_DARWIN) {
    const bash = platform.current.bash() || '/bin/bash';
    return {command: bash, args: [p.setup, action]};
  }
  // Windows/Linux run the installer with the host runtime instead of bash.
  return {command: process.execPath, args: [path.join(repoRoot, 'install.js'), action]};
}

function runSetup(repoRoot) {
  if (!platform.serviceSupported) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `当前平台（${platform.platform}）暂不支持自动安装后台服务`});
  }
  const {command, args} = installerCommand(repoRoot, 'setup');
  if (!fs.existsSync(args[0])) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${args[0]}`});
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    capture(child, resolve);
  });
}

function runStatus(repoRoot) {
  const p = paths(repoRoot);
  if (!platform.serviceSupported) {
    // No service manager on this platform, but status.json is still the
    // source of truth a manually started bridge writes.
    const text = fs.existsSync(p.status) ? fs.readFileSync(p.status, 'utf8') : '未安装或尚未运行';
    return Promise.resolve({ok: true, code: 0, stdout: text, stderr: '', error: ''});
  }
  const {command, args} = installerCommand(repoRoot, 'status');
  if (!fs.existsSync(args[0])) {
    return Promise.resolve({ok: false, code: null, stdout: '', stderr: '', error: `找不到 ${args[0]}`});
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {...process.env, TERM: 'dumb'},
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ok: false, code: null, stdout: '', stderr: '', error: '状态命令超时'});
    }, 20000);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr, error: String(error.message || error)});
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? {ok: true, code: 0, stdout, stderr, error: ''}
        : {ok: false, code, stdout, stderr, error: `命令退出码 ${code ?? '未知'}`});
    });
  });
}

async function stopBridge(repoRoot) {
  const p = paths(repoRoot);
  if (platform.IS_WIN) {
    await run('schtasks', ['/End', '/TN', platform.serviceName], {timeout: 15000});
  } else if (platform.serviceSupported) {
    await run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], {timeout: 15000});
  }
  const supervisorPid = readPid(p.supervisorPid);
  if (supervisorPid) await stopProcess(supervisorPid, 'bridge.js', 10000);
  const runtime = readJson(p.status);
  const enginePid = Number(runtime?.pid) || null;
  if (enginePid) await stopProcess(enginePid, 'cursor-magpie-bridge', 5000);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(res.req)
  });
  res.end(JSON.stringify(body));
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  return {
    'access-control-allow-origin': origin === 'null' ? 'null' : origin || 'null',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'vary': 'Origin'
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}


const here = path.dirname(fileURLToPath(import.meta.url));

/// 获取或持久化稳定的本地控制口令，防止后台服务重启导致已打开的前端面板因 Token 不一致而失效
function resolveControlToken(repoRoot) {
  const p = paths(repoRoot);
  const tokenFile = path.join(p.root, 'control-token.txt');
  try {
    if (fs.existsSync(tokenFile)) {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing && existing.length === 64) return existing;
    }
  } catch {}
  const created = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(p.root, {recursive: true, mode: 0o700});
    fs.writeFileSync(tokenFile, created, {mode: 0o600});
  } catch {}
  return created;
}

export function createControlServer({repoRoot, port, log = console.log}) {
  const token = resolveControlToken(repoRoot);
  const htmlFile = path.join(here, 'ui.html');
  const readAsset = (name, type) => {
    const file = path.join(here, name);
    if (!fs.existsSync(file)) return null;
    return {body: fs.readFileSync(file), type};
  };
  let busy = null;
  let ownPort = port;
  // Content-byte statistics scan the whole database (seconds on a multi-GB
  // file), so concurrent panels share one read and a short-lived cache.
  let databaseCache = {at: 0, data: null, deep: false};
  let databasePending = null;
  let databaseEpoch = 0;
  const DATABASE_CACHE_MS = 20000;
  // /api/status is polled every five seconds per open console, and each miss
  // spawns ps/launchctl. A two-second cache collapses concurrent panels into
  // one snapshot without making the panel feel stale.
  let overviewCache = {at: 0, data: null, pending: null};
  let settingsQueue = Promise.resolve();
  function cachedOverview() {
    if (overviewCache.data && Date.now() - overviewCache.at < 2000) {
      return Promise.resolve(overviewCache.data);
    }
    if (!overviewCache.pending) {
      overviewCache.pending = overview(repoRoot, ownPort)
        .then((data) => {
          overviewCache = {at: Date.now(), data, pending: null};
          return data;
        })
        .catch((error) => {
          overviewCache.pending = null;
          throw error;
        });
    }
    return overviewCache.pending;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${ownPort}`);
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${ownPort}` && host !== `localhost:${ownPort}`) {
        res.writeHead(421, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('misdirected request');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null' && origin !== `http://127.0.0.1:${ownPort}` && origin !== `http://localhost:${ownPort}`) {
        res.writeHead(403, {'content-type': 'text/plain; charset=utf-8'});
        return res.end('origin not allowed');
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {...corsHeaders(req), 'access-control-max-age': '600'});
        return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(htmlFile, 'utf8')
          .replace('__CONTROL_TOKEN__', token)
          .replace('__CONTROL_PORT__', String(ownPort));
        // A sandboxed frame has an opaque origin, where CSP 'self' matches
        // nothing. Name the loopback sources explicitly or ui.css/ui.js are
        // refused and the page falls back to unstyled HTML with no handlers.
        const origin = `http://127.0.0.1:${ownPort}`;
        const alt = `http://localhost:${ownPort}`;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'none'; script-src ${origin} ${alt} 'unsafe-inline'; style-src ${origin} ${alt} 'unsafe-inline'; img-src ${origin} ${alt} data:; connect-src ${origin} ${alt}; font-src ${origin} ${alt}; base-uri 'none'; form-action 'self' ${origin} ${alt}; frame-ancestors 'self' wails: http://wails.localhost http://localhost:* http://127.0.0.1:*`
        });
        return res.end(html);
      }

      if (req.method === 'GET' && (url.pathname === '/ui.css' || url.pathname === '/ui.js')) {
        const asset = readAsset(url.pathname.slice(1), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        if (!asset) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, {'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
        return res.end(asset.body);
      }

      if (url.pathname.startsWith('/api/')) {
        const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
        const want = Buffer.from(token);
        if (got.length !== want.length || !timingSafeEqual(got, want)) {
          return sendJson(res, 403, {ok: false, error: '控制口令无效'});
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(res, 200, {ok: true, overview: await cachedOverview()});
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const p = paths(repoRoot);
        return sendJson(res, 200, {
          ok: true,
          settings: readBridgeSettings(p.root),
          defaults: bridgeDefaults,
          rules: bridgeRules,
          modes: bridgeModes,
          subagentModes: bridgeSubagentModes,
          tabModes: bridgeTabModes,
          file: p.settings
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const body = await readBody(req);
        // Serialise writes so two panels saving at once cannot interleave
        // read-modify-write and leave the file with the older payload.
        const job = settingsQueue.then(() => {
          try {
            const p = paths(repoRoot);
            const saved = writeBridgeSettings(p.root, body);
            // 同步更新 effective.json，使运行中的引擎实时感知并热生效 Tab 配置
            const effFile = path.join(p.root, 'effective.json');
            if (fs.existsSync(effFile)) {
              try {
                const eff = JSON.parse(fs.readFileSync(effFile, 'utf8'));
                eff.tab = {
                  mode: saved.tabMode || 'official',
                  token: saved.tabToken || '',
                  model_id: saved.tabModelId || '',
                  address: saved.tabAddress || ''
                };
                atomic(effFile, JSON.stringify(eff));
              } catch {}
            }
            log(`bridge settings saved: ${JSON.stringify(saved)}`);
            return {status: 200, body: {ok: true, settings: saved}};
          } catch (error) {
            return {status: 400, body: {ok: false, error: String(error.message || error)}};
          }
        });
        settingsQueue = job.then(() => {}, () => {});
        const result = await job;
        return sendJson(res, result.status, result.body);
      }

      /// 一键从本地 Cursor 状态数据库提取官方登录 Token
      if (req.method === 'POST' && url.pathname === '/api/tab/token/extract') {
        try {
          const auth = await extractCursorAuthToken();
          return sendJson(res, 200, {
            ok: true,
            token: auth.token,
            email: auth.email,
            membershipType: auth.membershipType,
            dbPath: auth.dbPath
          });
        } catch (error) {
          return sendJson(res, 400, {ok: false, error: String(error.message || error)});
        }
      }

      /// 单模型连通性与延迟测速接口
      if (req.method === 'POST' && url.pathname === '/api/agent/test') {
        const body = await readBody(req).catch(() => ({}));
        const modelId = typeof body?.model === 'string' ? body.model.trim() : '';
        if (!modelId) return sendJson(res, 400, {ok: false, error: '未指定要测试的模型 ID'});

        const p = paths(repoRoot);
        let config = null;
        try {
          if (fs.existsSync(p.effective)) {
            config = JSON.parse(fs.readFileSync(p.effective, 'utf8'));
          }
          if (!config || !config.gateway) {
            for (const candidate of p.connections) {
              if (fs.existsSync(candidate)) {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (parsed?.gateway) { config = parsed; break; }
              }
            }
          }
        } catch {}

        if (!config || !config.gateway) {
          return sendJson(res, 400, {ok: false, error: '未找到生效的 Magpie 连接配置'});
        }

        const gateway = String(config.gateway).replace(/\/+$/, '');
        const apiKey = config.key || '';
        // 如果网关地址自带了 /v1，则不再重复拼接，否则补全 /v1
        const targetUrl = gateway.endsWith('/v1') ? `${gateway}/chat/completions` : `${gateway}/v1/chat/completions`;

        const startAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);

        try {
          const resp = await fetch(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: modelId,
              messages: [{role: 'user', content: 'hi'}],
              max_tokens: 8
            }),
            signal: controller.signal
          });
          clearTimeout(timer);
          const latencyMs = Date.now() - startAt;
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return sendJson(res, 200, {
              ok: false,
              latencyMs,
              error: `HTTP ${resp.status}: ${errText.slice(0, 120)}`
            });
          }
          const data = await resp.json().catch(() => ({}));
          const reply = data?.choices?.[0]?.message?.content || 'OK';
          return sendJson(res, 200, {
            ok: true,
            latencyMs,
            reply: reply.trim().slice(0, 60)
          });
        } catch (fetchErr) {
          clearTimeout(timer);
          const latencyMs = Date.now() - startAt;
          const isTimeout = fetchErr.name === 'AbortError';
          return sendJson(res, 200, {
            ok: false,
            latencyMs,
            error: isTimeout ? '请求超时（>12s）' : String(fetchErr.message || fetchErr)
          });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/database') {
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        const p = paths(repoRoot);
        const fresh = url.searchParams.get('refresh') === '1';
        const deep = url.searchParams.get('deep') === '1';
        const usable = () => databaseCache.data
          && Date.now() - databaseCache.at < DATABASE_CACHE_MS
          && (databaseCache.deep || !deep);
        if (!fresh && usable()) {
          return sendJson(res, 200, {ok: true, database: databaseCache.data, cached: true});
        }
        try {
          // A scan already in flight is shared; wait for it and reuse the
          // result when it covers what this request asked for.
          if (databasePending) {
            await databasePending.promise.catch(() => {});
            if (usable()) {
              return sendJson(res, 200, {ok: true, database: databaseCache.data, cached: true});
            }
          }
          if (!databasePending) {
            const epoch = databaseEpoch;
            const promise = readDatabase(p.database, {deep})
              .then((data) => {
                if (epoch === databaseEpoch) databaseCache = {at: Date.now(), data, deep};
                return data;
              })
              .finally(() => {
                if (databasePending?.promise === promise) databasePending = null;
              });
            databasePending = {deep, promise};
          }
          const data = await databasePending.promise;
          return sendJson(res, 200, {ok: true, database: data, cached: false,depth: deep ? 'deep' : 'fast'});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: `读取数据库失败：${error.message}`});
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/database/cleanup') {
        const body = await readBody(req);
        const scope = String(body.scope || '');
        if (!['traces', 'sessions', 'all', 'vacuum'].includes(scope)) {
          return sendJson(res, 400, {ok: false, error: `未知的清理范围：${scope || '空'}`});
        }
        const olderThanDays = body.olderThanDays === undefined ? 3 : Number(body.olderThanDays);
        if (scope === 'sessions' && (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650)) {
          return sendJson(res, 400, {ok: false, error: '保留天数需为 1–3650 的整数'});
        }
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        // 清理数据库：加忙碌锁，执行完毕后释放并让统计缓存失效
        const p = paths(repoRoot);
        busy = '清理数据库';
        try {
          const cleanup = await cleanDatabase(p.database, {scope, olderThanDays, vacuum: body.vacuum !== false});
          databaseEpoch += 1;
          databaseCache = {at: 0, data: null, deep: false};
          log(`database cleanup: ${scope}`);
          return sendJson(res, 200, {ok: true, cleanup});
        } catch (error) {
          return sendJson(res, 500, {ok: false, error: `清理失败：${error.message}`});
        } finally {
          busy = null;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/storage/migrate') {
        const body = await readBody(req);
        const targetDir = String(body.targetDir || '').trim();
        if (!targetDir) {
          return sendJson(res, 400, { ok: false, error: '目标目录不能为空' });
        }
        const resolvedTarget = path.resolve(targetDir);
        const p = paths(repoRoot);
        const currentDataDir = p.data;
        if (path.resolve(currentDataDir) === resolvedTarget) {
          return sendJson(res, 400, { ok: false, error: '目标目录与当前生效目录相同' });
        }
        if (busy) return sendJson(res, 409, { ok: false, error: `正在执行「${busy}」，请稍候` });
        busy = '数据迁移';
        log(`storage migrate: ${currentDataDir} -> ${resolvedTarget}`);
        try {
          const runtime = readJson(p.status);
          const enginePid = Number(runtime?.pid) || null;
          const supervisorPid = readPid(p.supervisorPid);
          const wasRunning = (!!enginePid && alive(enginePid)) || (!!supervisorPid && alive(supervisorPid));
          if (wasRunning) await stopBridge(repoRoot);

          fs.mkdirSync(resolvedTarget, { recursive: true });
          const currentDb = p.database;
          const targetBridgeDb = path.join(resolvedTarget, 'bridge.db');
          const targetByokDb = path.join(resolvedTarget, 'cursor-byok.db');
          if (fs.existsSync(currentDb) && !fs.existsSync(targetBridgeDb) && !fs.existsSync(targetByokDb)) {
            copyDirRecursiveSync(currentDataDir, resolvedTarget);
          }

          fs.writeFileSync(path.join(p.root, 'data_location.txt'), resolvedTarget);
          const byokDir = path.join(p.home, '.cursor-byok-v3');
          try {
            fs.mkdirSync(byokDir, { recursive: true });
            fs.writeFileSync(path.join(byokDir, 'data_location.txt'), resolvedTarget);
          } catch {}

          let restart = null;
          if (wasRunning) {
            try { restart = await runSetup(repoRoot); } catch (e) { restart = { ok: false, error: String(e.message || e) }; }
          }
          overviewCache = { at: 0, data: null, pending: null };
          databaseCache = { at: 0, data: null, deep: false };
          return sendJson(res, 200, { ok: true, targetDir: resolvedTarget, restart });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: `迁移失败: ${error.message}` });
        } finally {
          busy = null;
        }
      }

      /// 立即从 Magpie 网关同步最新开启/关闭的模型并热更新生效配置
      if (req.method === 'POST' && url.pathname === '/api/models/sync') {
        const p = paths(repoRoot);
        let raw = null;
        for (const candidate of p.connections) {
          try {
            if (fs.existsSync(candidate)) {
              raw = fs.readFileSync(candidate, 'utf8');
              if (raw && raw.trim() !== '{}') break;
            }
          } catch {}
        }
        if (!raw || raw.trim() === '{}') {
          return sendJson(res, 400, { ok: false, error: '未找到 Magpie 连接配置，请先在 Magpie 的 Agent 列表中开启并连接「Cursor · Magpie 智能桥接」' });
        }
        try {
          const c = validate(JSON.parse(raw));
          if (!c) return sendJson(res, 400, { ok: false, error: '当前连接配置格式无效' });
          const effective = await gatewayModels(c);
          atomic(p.effective, JSON.stringify(effective, null, 2));
          overviewCache = { at: 0, data: null, pending: null };
          return sendJson(res, 200, {
            ok: true,
            count: effective.models.length,
            models: effective.models.map(m => m.name || m.id)
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: `同步 Magpie 模型目录失败: ${err.message}` });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(req);
        const action = String(body.action || '');
        if (action === 'reset') {
            const p = paths(repoRoot);
            try {
                // 删除整个数据目录 (慎重：这会重置所有状态)
                if (fs.existsSync(p.data)) fs.rmSync(p.data, { recursive: true, force: true });
                // 停止并清理状态
                await stopBridge(repoRoot);
                log('control action: reset (data wiped)');
                return sendJson(res, 200, { ok: true, action: 'reset', message: '状态已重置，数据目录已清空' });
            } catch (err) {
                return sendJson(res, 500, { ok: false, error: `重置失败: ${err.message}` });
            }
        }
        if (!['start', 'status', 'restart'].includes(action)) {
          return sendJson(res, 400, {ok: false, error: `未知操作：${action || '空'}`});
        }
        // 增加对繁忙状态的强制过期机制
        if (busy && Date.now() - busyAt > 30000) {
            log(`检测到执行任务超时卡死，强制释放 busy 锁: ${busy}`);
            busy = null;
            busyAt = 0;
        }
        if (busy) return sendJson(res, 409, {ok: false, error: `正在执行「${busy}」，请稍候`});
        busy = action;
        busyAt = Date.now();
        log(`control action: ${action}`);
        try {
          let result;
          if (action === 'status') {
            result = await runStatus(repoRoot);
          } else if (action === 'restart') {
            await stopBridge(repoRoot);
            result = await runSetup(repoRoot);
          } else {
            result = await runSetup(repoRoot);
          }
          result.action = action;
          result.overview = await overview(repoRoot, ownPort);
          overviewCache = {at: Date.now(), data: result.overview, pending: null};
          return sendJson(res, 200, result);
        } finally {
          busy = null;
        }
      }

      /// 获取实时日志末尾行内容接口
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const p = paths(repoRoot);
        const name = url.searchParams.get('name') || 'engine';
        const lines = Number(url.searchParams.get('lines')) || 80;
        let targetFile = p.engineLog;
        if (name === 'supervisor') targetFile = p.supervisorLog;
        else if (name === 'error' || name === 'supervisor-error') targetFile = p.supervisorError;

        const result = readLogTail(targetFile, lines);
        return sendJson(res, 200, {
          ok: true,
          name,
          path: targetFile,
          lines: result.lines,
          text: result.text
        });
      }

      /// 运行服务与依赖一键体检接口
      if (req.method === 'POST' && url.pathname === '/api/selftest') {
        const body = await readBody(req).catch(() => ({}));
        const withModel = body.model === true;
        const p = paths(repoRoot);
        const checks = [];
        let allOk = true;

        // 1. 控制服务连通性
        const t0 = Date.now();
        checks.push({
          label: '控制服务与端口',
          ok: true,
          detail: `控制服务运行正常 · PID ${process.pid} · 端口 ${ownPort}`,
          durationMs: Date.now() - t0
        });

        // 2. 原生引擎与代理拦截
        const t1 = Date.now();
        let engineOk = false;
        let engineDetail = '';
        try {
          const runtime = readJson(p.status);
          const supervisorAlive = alive(readPid(p.supervisorPid));
          const enginePid = runtime?.pid ? Number(runtime.pid) : null;
          const isEngineAlive = enginePid ? alive(enginePid) : false;
          if (runtime && isEngineAlive) {
            engineOk = true;
            engineDetail = `代理端口 127.0.0.1:${runtime.proxy || 45678} · PID ${enginePid} · 状态: ${runtime.state || 'connected'}`;
          } else if (supervisorAlive) {
            engineDetail = `守护进程 PID ${readPid(p.supervisorPid)} 存活，但原生引擎未在运行`;
          } else {
            engineDetail = '原生引擎未运行，请在控制台上方点击「启动」';
          }
        } catch (e) {
          engineDetail = `检测异常: ${e.message}`;
        }
        if (!engineOk) allOk = false;
        checks.push({
          label: '原生引擎与代理端口',
          ok: engineOk,
          detail: engineDetail,
          durationMs: Date.now() - t1
        });

        // 3. CA 根证书就绪状态
        const t2 = Date.now();
        let certOk = false;
        let certDetail = '';
        try {
          const certCandidates = [
            path.join(p.root, 'data/ca/ca.crt'),
            path.join(p.data, 'ca/ca.crt'),
            path.join(p.root, 'ca.crt')
          ];
          const found = certCandidates.find(c => fs.existsSync(c));
          if (found) {
            certOk = true;
            certDetail = `根证书文件就绪 (${path.basename(path.dirname(found))}/${path.basename(found)})`;
          } else {
            certDetail = '未在数据目录中找到 ca.crt 根证书文件';
          }
        } catch (e) {
          certDetail = `证书检测异常: ${e.message}`;
        }
        if (!certOk) allOk = false;
        checks.push({
          label: 'MITM 根证书状态',
          ok: certOk,
          detail: certDetail,
          durationMs: Date.now() - t2
        });

        // 4. 数据库存储与读写状态
        const t3 = Date.now();
        let dbOk = false;
        let dbDetail = '';
        try {
          if (fs.existsSync(p.database)) {
            const s = fs.statSync(p.database);
            const mb = (s.size / (1024 * 1024)).toFixed(2);
            dbOk = true;
            dbDetail = `正常 · 大小 ${mb} MB · 位于 ${p.database}`;
          } else {
            dbDetail = `数据库尚未生成 (${p.database})`;
          }
        } catch (e) {
          dbDetail = `存储检测异常: ${e.message}`;
        }
        if (!dbOk) allOk = false;
        checks.push({
          label: '数据库存储状态',
          ok: dbOk,
          detail: dbDetail,
          durationMs: Date.now() - t3
        });

        // 5. Magpie 上游网关与模型测试
        const t4 = Date.now();
        let gwOk = false;
        let gwDetail = '';
        try {
          let config = null;
          if (fs.existsSync(p.effective)) config = readJson(p.effective);
          if (!config?.gateway) {
            for (const cand of p.connections) {
              if (fs.existsSync(cand)) {
                const parsed = readJson(cand);
                if (parsed?.gateway) { config = parsed; break; }
              }
            }
          }
          if (!config || !config.gateway) {
            gwDetail = '未找到 Magpie 网关连接配置';
          } else {
            const gateway = String(config.gateway).replace(/\/+$/, '');
            // 网关地址可能已自带 /v1，统一得到 /v1 基址，避免拼成 /v1/v1 导致 404
            const apiBase = gateway.endsWith('/v1') ? gateway : `${gateway}/v1`;
            const activeModel = config.model || (Array.isArray(config.models) && (config.models[0]?.id || config.models[0]?.name)) || 'default';
            if (withModel) {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 10000);
              const resp = await fetch(`${apiBase}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${config.key || ''}`
                },
                body: JSON.stringify({
                  model: activeModel,
                  messages: [{ role: 'user', content: 'ping' }],
                  max_tokens: 8
                }),
                signal: controller.signal
              }).finally(() => clearTimeout(timer));
              const lat = Date.now() - t4;
              if (resp.ok) {
                gwOk = true;
                gwDetail = `网关 ${gateway} 连通 · 模型 ${activeModel} 探测通过 (${lat}ms)`;
              } else {
                gwDetail = `网关 ${gateway} 返回 HTTP ${resp.status}`;
              }
            } else {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              const resp = await fetch(`${apiBase}/models`, {
                headers: { 'Authorization': `Bearer ${config.key || ''}` },
                signal: controller.signal
              }).finally(() => clearTimeout(timer));
              const lat = Date.now() - t4;
              if (resp.ok) {
                gwOk = true;
                gwDetail = `网关 ${gateway} 连通响应正常 (${lat}ms)`;
              } else {
                gwDetail = `网关返回 HTTP ${resp.status}`;
              }
            }
          }
        } catch (e) {
          gwDetail = `网关请求超时或失败: ${e.message}`;
        }
        if (!gwOk) allOk = false;
        checks.push({
          label: 'Magpie 网关与模型',
          ok: gwOk,
          detail: gwDetail,
          durationMs: Date.now() - t4
        });

        return sendJson(res, 200, {
          ok: true,
          result: {
            ok: allOk,
            checks
          }
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readBody(req);
        const p = paths(repoRoot);
        const targets = {
          config: p.root,
          data: p.data,
          'engine-log': p.engineLog,
          'supervisor-log': p.supervisorLog,
          'supervisor-error-log': p.supervisorError,
          install: p.share,
          repo: p.repo,
          plist: p.plist || ''
        };
        const target = targets[String(body.target || '')];
        if (!target) return sendJson(res, 400, {ok: false, error: '未知的打开目标'});
        const opener = platform.current.openCommand(target);
        if (!opener) return sendJson(res, 400, {ok: false, error: `当前平台（${platform.platform}）没有可用的打开命令`});
        if (!fs.existsSync(target)) {
          if (['config', 'data', 'install', 'repo'].includes(String(body.target || ''))) {
            try { fs.mkdirSync(target, { recursive: true }); } catch {}
          } else {
            // 若日志文件不存在，先创建空文件再打开，防止报红“路径不存在”
            try { fs.writeFileSync(target, ''); } catch {
              return sendJson(res, 404, {ok: false, error: `路径不存在：${target}`});
            }
          }
        }
        const result = await run(opener.command, opener.args, {timeout: 10000});
        // explorer.exe exits 1 even when it opened the folder.
        const opened = result.ok || (platform.IS_WIN && result.code === 1);
        return sendJson(res, opened ? 200 : 500, opened ? {ok: true} : {ok: false, error: result.error || '打开失败'});
      }

      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
    } catch (error) {
      log(`control request failed: ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, {ok: false, error: String(error?.message || error)});
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      ownPort = server.address().port;
      log(`listening on http://127.0.0.1:${ownPort}`);
      resolve({server, port: ownPort});
    });
  });
}
