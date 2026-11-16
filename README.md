# Cursor · Magpie Bridge

> 让 Cursor 能够直接无缝使用 **Magpie** 网关代理中的任意模型（Claude 3.7 / Gemini 2.5 / GPT-4o / DeepSeek 等），具备超高前缀缓存命中率、便携式绿色数据库支持及全自动协议转译。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64%20%7C%20macOS-green.svg)]()
[![Cursor Version](https://img.shields.io/badge/Cursor-3.28%20~%203.30+-orange.svg)]()

---

## 🌟 核心特性

- ⚡ **无头独立高性能引擎**：基于 Rust 高性能原生开发，内置 MITM 代理、Connect-RPC / Protobuf 协议转码器与嵌入式 SQLite 引擎，无需任何庞大外部依赖。
- 💾 **真正的绿色便携数据库（Portable Data）**：
  - 支持 `CURSOR_BYOK_DATA_DIR` 环境变量与相对目录解析。
  - 数据目录随插件任意剪切、移动、换盘或存入 U 盘随身携带，随时随地即开即用。
  - 无缝兼容 `cursor-byok.db` 与 `bridge.db`，可直接继承原有历史会话与缓存记录。
- 🎯 **超高前缀缓存命中率（KV Cache）**：
  - 内置完整的 Checkpoint 增量指纹维持算法。
  - 在大上下文、多轮对话及长指令场景下稳定维持 **49%+ 的缓存命中率**，极大降低 Token 消耗并缩减首字响应时间（TTFB）。
- 🔄 **Magpie 模型全量动态同步**：
  - 启动时自动读取 Magpie 网关配置与可用模型列表并全量写入本地数据库。
  - Cursor 内的模型选择器即刻呈现最新模型，告别繁琐手动配置。
- 🛡️ **无感证书与代理接管**：
  - 内置跨平台自签根证书（CA）生成与系统信任安装；
  - 启停随心，退出时自动恢复 Cursor 原始代理设置，杜绝网络配置残留。

---

## 🏗️ 架构与运行原理

```text
┌──────────────┐          Protobuf / Connect-RPC           ┌────────────────────────────────┐
│              │ ────────────────────────────────────────> │                                │
│    Cursor    │                                           │  cursor-magpie-bridge (Rust)   │
│  (IDE 端)    │ <──────────────────────────────────────── │  • MITM 代理拦截 (45678)        │
└──────────────┘           流式回复 / 思考 / 工具调用        │  • Checkpoint 前缀缓存树        │
                                                           │  • Portable SQLite (bridge.db) │
                                                           └───────────────┬────────────────┘
                                                                           │
                                                                           │ HTTP / SSE (OpenAI 兼容)
                                                                           ▼
                                                           ┌────────────────────────────────┐
                                                           │         Magpie Gateway         │
                                                           │     (http://127.0.0.1:2425)    │
                                                           └────────────────────────────────┘
```

1. **截获**：Cursor 发送给官方 API（`api2.cursor.sh`）的请求被本地安全代理（默认 `127.0.0.1:45678`）截获；
2. **转码**：独立引擎将 Cursor 私有的 Protobuf / Connect-RPC 请求逆向解析，提取上下文并基于前缀树计算缓存指纹，转换为标准 OpenAI Chat Completions 协议转发至本地 Magpie 网关；
3. **回流**：Magpie 上游模型的流式 Token、思考过程（Thinking Tokens）与工具调用（Tool Calls）实时编码回 Connect-RPC 二进制流回传给 Cursor。

---

## 📦 目录结构

```text
magpie-agent-cursor-bridge/
├── bin/
│   └── win32-x64/
│       └── cursor-magpie-bridge.exe     # 独立无头 Rust 拦截引擎
├── control/                             # 控制台后端（会话查询、运行追踪、VACUUM 清理）
│   ├── database.js                      # 直读 SQLite bridge.db 物理分析
│   ├── server.js                        # 本地控制服务
│   └── host.js                          # Magpie 插件主入口
├── lib/                                 # 平台探测、配置读写与安装逻辑
├── ui/                                  # 桥接控制台前端页面
├── agent.js                             # Magpie Agent 描述符
├── bridge.js                            # 后台守护进程（进程管理与状态报告）
├── install.js / setup.command           # 一键安装 / 卸载脚本
├── integrity.json                       # 核心二进制哈希校验清单
└── package.json                         # 标准 Magpie 插件元数据
```

---

## 🚀 快速开始

### 方式一：在 Magpie 中直接加载（推荐）

1. 打开 **Magpie** 设置 -> **插件管理**；
2. 点击 **“添加本地插件”**，选择本仓库所在文件夹；
3. 在 Magpie 的 Agent 列表中开启 **Cursor · Magpie Bridge** 连接；
4. 重启 Cursor 即可开始使用！

### 方式二：命令行一键安装守护进程

在终端（PowerShell 或 Bash）中执行：

```bash
# 进入插件目录
cd magpie-agent-cursor-bridge

# 运行安装脚本
node install.js setup
```

安装程序会自动执行：
- 校验二进制完整性（SHA-256）；
- 初始化并信任本地 CA 证书；
- 配置 Windows 启动守护项 / macOS LaunchAgent。

---

## 💾 便携数据库（Portable Mode）与历史迁移

本插件默认将数据库存放在便携目录下的 `data/bridge.db`。

### 跨设备 / 随身携带移动
您可以将本插件目录整个拷贝到任意电脑、移动硬盘或 U 盘中，无需复杂的重新安装或数据库迁移，直接启动即用。

### 继承已有 Cursor BYOK 数据库
如果您之前使用过 Cursor BYOK，并希望继续使用原有的历史对话、运行追踪和已经生成的庞大前缀缓存（达到 49%+ 极速命中）：
1. 找到您原有的 `cursor-byok.db` 文件；
2. 将其复制到本插件的 `data/` 目录下并重命名为 `bridge.db`；
3. 启动插件，所有缓存与历史数据将被无缝读取并继续维持！

---

## 🛠️ 自行编译引擎（开发者指南）

如果您需要从源码重新编译无头二进制引擎：

```bash
# 检出源码并构建 Release 二进制
cargo build --release --bin cursor-magpie-bridge

# 产物位于 target-build/release/cursor-magpie-bridge.exe
# 复制到 bin/win32-x64/ 即可
```

---

## 📄 许可证

本项目遵循 [MIT License](LICENSE) 开源协议。
