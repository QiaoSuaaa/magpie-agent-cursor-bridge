import fs from 'node:fs';
import path from 'node:path';

// User-editable bridge parameters. They live beside the other runtime state so
// the supervisor (bridge.js) and the control panel read the same file. Every
// read tolerates a missing or malformed file and falls back to the defaults;
// only an explicit write from the control panel is validated strictly.
export const defaults = Object.freeze({
  runMode: 'default',
  subagentMode: 'async',
  refreshSeconds: 3,
  gatewayGraceSeconds: 60,
  logLimitMB: 4,
  tabMode: 'official',
  tabToken: '',
  tabModelId: '',
  tabAddress: ''
});

// Run modes are intentionally a closed set: the native engine switches its
// storage strategy from this value, so an unknown mode must never fall through
// to a half-configured state.
export const modes = Object.freeze({
  default: '默认模式',
  lite: '轻量模式'
});

// Subagent modes decide how Task calls reach the client. `async` keeps the
// model's own run_in_background intent and lets the bridge wake the parent when
// the subagent finishes; `sync` forces run_in_background=false so the parent
// turn waits for an inline result.
export const subagentModes = Object.freeze({
  async: '异步后台（默认）',
  sync: '同步阻塞'
});

/// Tab 代码智能补全支持的工作模式
export const tabModes = Object.freeze({
  official: '官方 Token 极速模式（推荐）',
  model: 'Magpie 模型补全模式',
  direct: '直连官方',
  public: '公共服务',
  custom: '自定义端点'
});

export const rules = Object.freeze({
  refreshSeconds: {min: 1, max: 300, step: 1, label: '模型目录同步间隔（秒）'},
  gatewayGraceSeconds: {min: 10, max: 600, step: 1, label: '网关断线容错（秒）'},
  logLimitMB: {min: 1, max: 64, step: 1, label: '引擎日志上限（MB）'}
});

export function settingsFile(root) {
  return path.join(root, 'bridge-settings.json');
}

export function normalize(input, {strict = false} = {}) {
  const out = {};
  const mode = input?.runMode;
  if (mode === undefined || mode === null || mode === '') {
    out.runMode = defaults.runMode;
  } else if (Object.hasOwn(modes, mode)) {
    out.runMode = mode;
  } else if (strict) {
    throw new Error(`运行模式需为 ${Object.keys(modes).join(' 或 ')}`);
  } else {
    out.runMode = defaults.runMode;
  }
  const subagentMode = input?.subagentMode;
  if (subagentMode === undefined || subagentMode === null || subagentMode === '') {
    out.subagentMode = defaults.subagentMode;
  } else if (Object.hasOwn(subagentModes, subagentMode)) {
    out.subagentMode = subagentMode;
  } else if (strict) {
    throw new Error(`子代理模式需为 ${Object.keys(subagentModes).join(' 或 ')}`);
  } else {
    out.subagentMode = defaults.subagentMode;
  }
  for (const [key, rule] of Object.entries(rules)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || raw === '') {
      out[key] = defaults[key];
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      if (strict) throw new Error(`${rule.label}需为 ${rule.min}–${rule.max} 的整数`);
      out[key] = defaults[key];
      continue;
    }
    out[key] = value;
  }

  // 规范化 Tab 补全设置
  const tabMode = input?.tabMode;
  if (tabMode && Object.hasOwn(tabModes, tabMode)) {
    out.tabMode = tabMode;
  } else {
    out.tabMode = defaults.tabMode;
  }
  out.tabToken = typeof input?.tabToken === 'string' ? input.tabToken.trim() : defaults.tabToken;
  out.tabModelId = typeof input?.tabModelId === 'string' ? input.tabModelId.trim() : defaults.tabModelId;
  out.tabAddress = typeof input?.tabAddress === 'string' ? input.tabAddress.trim() : defaults.tabAddress;

  return out;
}

export function read(root) {
  try {
    return normalize(JSON.parse(fs.readFileSync(settingsFile(root), 'utf8')));
  } catch {
    return {...defaults};
  }
}

export function write(root, input) {
  const value = normalize(input, {strict: true});
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const file = settingsFile(root);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  return value;
}
