#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {atomic, applyProxy, restoreProxy} from './lib/settings.js';
import {read as readBridgeSettings} from './lib/bridge-settings.js';
import platform from './lib/platform.js';
import {createSupervisor} from './lib/supervisor.js';
import {pruneDatabase} from './control/database.js';
import {version} from './version.js';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.CURSOR_BRIDGE_ROOT || platform.current.paths().config;
const file = name => path.join(root, name);

let lastStatus = '';
const status = (state, extra = {}) => {
  const signature = JSON.stringify({version, state, ...extra});
  if (signature !== lastStatus) {
    atomic(file('status.json'), JSON.stringify({version, state, ...extra, updated: new Date().toISOString()}, null, 2));
    lastStatus = signature;
  }
};

const connectionFiles = process.env.CURSOR_BRIDGE_ROOT
  ? [file('connection.json'), ...platform.current.connectionFiles()]
  : platform.current.connectionFiles();

function connectionText() {
  for (const candidate of connectionFiles) {
    try { return fs.readFileSync(candidate, 'utf8'); } catch { }
  }
  return '{}';
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// 引擎日志轮转逻辑 (借鉴增强版)
let engineLogFd = null;
let engineLogSize = 0;
let engineLogLimit = 0;
function openEngineLog() {
  if (engineLogFd !== null) return engineLogFd;
  const log = file('engine.log');
  if (!engineLogLimit) engineLogLimit = readBridgeSettings(root).logLimitMB * 1024 * 1024;
  try { engineLogSize = fs.statSync(log).size; } catch { engineLogSize = 0; }
  if (engineLogSize > engineLogLimit) {
    try { fs.renameSync(log, file('engine.log.1')); } catch { }
    engineLogSize = 0;
  }
  engineLogFd = fs.openSync(log, 'a', 0o600);
  return engineLogFd;
}
function appendEngineLog(chunk) {
  try {
    const fd = openEngineLog();
    fs.writeSync(fd, chunk);
    engineLogSize += chunk.length;
    if (engineLogSize > engineLogLimit) {
      try { fs.closeSync(fd); } catch { }
      engineLogFd = null;
      try { fs.renameSync(file('engine.log'), file('engine.log.1')); } catch { }
      engineLogSize = 0;
    }
  } catch { }
}

const command = process.argv[2] || 'status';
if (command === 'status') {
  console.log(fs.existsSync(file('status.json')) ? fs.readFileSync(file('status.json'), 'utf8') : '未安装或尚未运行');
} else if (command === 'restore') {
  console.log(JSON.stringify({preservedExternalChanges: restoreProxy(file('settings-journal.json'))}));
} else if (command === 'supervise') {
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  if (!platform.IS_WIN) process.umask(0o077);
  
  const lock = file('supervisor.lock');
  try { fs.mkdirSync(lock); } catch {
    // 这里可以加入 isLiveSupervisor 探测
    fs.rmSync(lock, {recursive: true, force: true}); fs.mkdirSync(lock);
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  
  let ending = false;
  let preferredProxyPort = '';
  try { const last = JSON.parse(fs.readFileSync(file('status.json'), 'utf8')); const url = new URL(last.proxy); if (url.port) preferredProxyPort = url.port; } catch { }

  const supervisor = createSupervisor({
    initialProxyPort: preferredProxyPort,
    readSettings: () => readBridgeSettings(root),
    readConnection: connectionText,
    fetchCatalogue: async (connection, config) => { /* 保留模型目录逻辑 */ return {models: []}; },
    writeEffective: text => atomic(file('effective.json'), text),
    publish: (state, extra) => status(state, extra),
    applyProxy: proxy => applyProxy(root, file('settings-journal.json'), proxy),
    restoreProxy: () => restoreProxy(file('settings-journal.json')),
    pruneDatabase: ({tracesDays, sessionsDays}) => pruneDatabase(file('data/bridge.db'), {tracesDays, sessionsDays}),
    onPrune: result => atomic(file('retention.json'), JSON.stringify(result, null, 2)),
    spawnEngine: ({mode, subagentMode, preferredProxyPort: port}) => spawn(platform.enginePathFor(packageDir), [file('effective.json')], {
      env: {...process.env, CURSOR_BYOK_DATA_DIR: file('data'), CURSOR_BRIDGE_RUN_MODE: mode, CURSOR_BRIDGE_SUBAGENT_MODE: subagentMode, ...(port ? {CURSOR_BRIDGE_PROXY_PORT: port} : {})}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    }),
    onEngineStderr: appendEngineLog,
    wait,
    isEnding: () => ending
  });
  
  process.on('SIGTERM', () => { ending = true; });
  process.on('SIGINT', () => { ending = true; });
  
  try { await supervisor.run(); } finally { fs.rmSync(lock, {recursive: true, force: true}); }
} else { throw new Error('usage: node bridge.js status|supervise|restore'); }
