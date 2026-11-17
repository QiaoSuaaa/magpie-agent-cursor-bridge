# 更新日志 / CHANGELOG

All notable changes to **Cursor · Magpie Bridge** will be documented in this file.  
本项目的所有重要更新、功能演变与问题修复均记录于此。

---

## [v0.2.23] - 2026-11-17

### 🇨🇳 中文更新记录
#### 🎯 重点修复与体验强化
- **彻底消除 Cursor 客户端右下角默认 Auto 开关**：
  - 深入逆向 Cursor 模型选择器 Protobuf 协议，在 `AvailableModels` 的 Field 15 注入 `ModelPickerDisplayConfiguration`，下发 `hide_routed_model_view = true` 与空的 `named_view_to_routed_model_view_no_button = NoAutoButton {}`；
  - 彻底抹平 Cursor 界面右下角的 Auto 控件，根除 Cursor 启动后自动切换为 Auto 导致路由混乱的问题；
  - 原生引擎全面拦截所有可能携带的 `auto` 或 `default` 请求，平滑接管并无缝回退至本地首选模型。
- **模型展示名智能短名化（Short Model Name）**：
  - 针对多段冗长模型名（如 `deepseek-ai/DeepSeek-V3 · 官方 · 亚太`），自动截取首段关键简称为短名，消除 Cursor 模型下拉列表中的文字截断与排版凌乱。
- **控制台全新「模型管理与连通性测试」卡片**：
  - 控制台新增模型列表表格，清晰展示当前生效的所有模型 ID 与 Cursor 显示简称；
  - 每个模型独立配备「测试」按钮，点击向 Magpie 发送 8-token 超轻量探测，毫秒级反馈延迟（如 `🟢 168ms`）或精准错误详情；
  - 支持模型即时搜索过滤及「一键测全部」，便于一键排查全部模型的实际连通性与健康状态。
- **控制台内嵌「日志查看器与一键全项自检」**：
  - 新增 `GET /api/logs` 端点，控制台内嵌实时日志窗口，可一键切换查看 `engine.log`、`supervisor.log`、`supervisor-error.log` 的最新 80 行内容，免去到文件夹翻找文件的繁琐；
  - 新增 `POST /api/selftest` 端点，一键检测控制服务、原生引擎与代理端口、MITM 根证书状态、数据库存储以及 Magpie 网关连通性 5 大核心环节，毫秒级定位运行异常。
- **构建自动化与完整性校验维护**：
  - 新增 `scripts/update-integrity.js`，一键自动完成二进制复制、SHA-256 哈希计算、`integrity.json` 更新与环境同步。

### 🇬🇧 English Release Notes
#### 🎯 Key Fixes & Feature Enhancements
- **Completely Eliminate Cursor's Default Auto Picker**:
  - Reverse-engineered Cursor's picker Protobuf protocol. Injected `ModelPickerDisplayConfiguration` at Field 15 of `AvailableModels`, broadcasting `hide_routed_model_view = true` along with an empty `named_view_to_routed_model_view_no_button = NoAutoButton {}`.
  - Completely hides the client-side "Auto" button, preventing Cursor from resetting to Auto mode upon startup.
  - Native engine now catches any incoming `auto` / `default` requests and transparently routes them to the user's primary selected model.
- **Intelligent Short Model Names**:
  - Automatically extracts the concise prefix for multi-part model IDs (e.g., `deepseek-v3` instead of lengthy supplier/region metadata), preventing UI overflow and text truncation in the Cursor model dropdown.
- **Console Model Management & Latency Ping**:
  - Added an interactive model management card to the bridge console showing active model IDs and concise Cursor display names.
  - Independent **"Test"** button for each model: sends an ultra-lightweight 8-token request to Magpie, returning millisecond-level latency (e.g. `🟢 168ms`) or precise error status.
  - Supports live fuzzy search and one-click batch testing for all configured models.
- **Real-time Log Viewer & One-Click System Health Check**:
  - Added `GET /api/logs` endpoint with an embedded log viewer in the web UI. Easily switch between `engine.log`, `supervisor.log`, and `supervisor-error.log` without browsing system directories.
  - Added `POST /api/selftest` endpoint: one-click diagnostics covering Control Service, Native Engine/Proxy, CA Certificate, SQLite Database, and Magpie Gateway connectivity.
- **Build Automation**:
  - Added `scripts/update-integrity.js` to automatically calculate SHA-256 binary checksums, update `integrity.json`, and synchronize with local active installation directories.

---

## [v0.2.22] - 2026-11-17

### 🇨🇳 中文更新记录
- **全面更名为「Cursor · Magpie 智能桥接」**：
  - 插件名称、侧边栏标题、控制台界面及 Agent 选项全量规范化为「Cursor · Magpie 智能桥接」，更具辨识度与中文亲和力。
- **全平台自适应路径统一（消除沙箱跨平台误判）**：
  - 彻底解决 Magpie 在独立沙箱中加载 `agent.js` 时因缺乏 `process.platform` 而默认回退为 `darwin`，进而检查 `\Applications\Cursor.app` 不存在并在 Agent 列表中强制隐藏插件的严重 Bug；
  - 统一遵循 Magpie 官方生态最佳实践，将 `agent.dir` 与 `agent.config` 指向跨平台通用自适应路径 `~/.config/magpie-cursor-bridge`；
  - 无论在 Windows（任意盘符）、macOS 还是 Linux 上，无论 Cursor 是否安装在默认目录，Magpie 校验均 100% 成功，Agent 列表永久可见。
- **配置目录自动预创建与防御性容错**：
  - 在插件宿主初始化（`host.js`）及安装入口（`install.js`）加入自动预创建机制，新电脑首次安装插件无需手动点击，环境目录即刻就绪。

### 🇬🇧 English Release Notes
- **Official Branding Update to "Cursor · Magpie Bridge"**:
  - Unified plugin name, console UI titles, and Magpie Agent menu items across the entire suite.
- **Universal Adaptive Path Resolution (Sandbox Isolation Fix)**:
  - Resolved a critical issue where running `agent.js` inside Magpie's isolated sandbox lacked `process.platform`, causing false fallbacks to macOS `/Applications/Cursor.app` and hiding the plugin on Windows/Linux.
  - Aligned with Magpie ecosystem standards by pointing `agent.dir` and `agent.config` to `~/.config/magpie-cursor-bridge`.
  - Works reliably across Windows (any drive), macOS, and Linux regardless of custom Cursor installation paths.
- **Automatic Directory Provisioning**:
  - Added automated pre-creation of required configuration and runtime folders on clean installations.

---

## [v0.2.21] - 2026-11-16

### 🇨🇳 中文更新记录
- **Cursor Tab 智能代码补全（双模加速）**：
  - 官方 Token 极速模式：支持 16 个上游端点精准分流（`StreamCpp`, `FSSyncFile`, `RecordCppFate` 等），自动计算动态 Checksum 并隔离生成，控制台支持“一键提取本机 Cursor 登录凭据”；
  - Magpie 模型补全模式：支持将 Tab 代码补全请求定向调度至在 Magpie 接入的任意代码模型（如 DeepSeek、GPT-6.1-Sol 等）；
  - 新增直连官方模式、自定义服务端点模式与公共服务模式。
- **全量模型自由挑选**：
  - 控制台 Tab 补全模型下拉框现已支持从当前连接的所有网关可用模型中自由挑选，亦可选择跟随默认代码模型。
- **子代理（Subagent / Task）深度支持与调度**：
  - 完整兼容 Cursor Agent 模式下的 `Task` 工具派发与多轮子代理流转；
  - 支持子代理自动继承父对话模型（`inherit` / `default`）；
  - 控制台支持【异步后台（默认）】与【同步阻塞（`run_in_background=false`）】双模式切换。
- **修复状态读取卡死在「读取状态…」的隐蔽 Bug**：
  - 将控制口令持久化存储在 `control-token.txt`，保证服务重启后 Token 恒定不失效；
  - 前端引入自动 Token 静默无缝换取与重试机制，彻底杜绝 403 挂死；接口响应提速至 36 毫秒。
- **修复 Tab 配置保存无反应问题**：
  - 避免内嵌 WebView 中的表单提交拦截，改用原生按钮事件监听并提供全局绿色悬浮通知。

### 🇬🇧 English Release Notes
- **Cursor Tab Autocomplete (Dual Accelerated Modes)**:
  - **Official Token High-Speed Mode**: Precision upstream routing across 16 specialized endpoints with dynamic checksum acceleration. One-click token extraction directly in the console.
  - **Magpie Model Autocomplete Mode**: Forward Tab code completions to any configured Magpie model (e.g., DeepSeek, GPT-6.1-Sol).
  - Also added Direct, Custom Server, and Public Service modes.
- **Full Model Selection**:
  - Tab completion model selector now lists all gateway-connected models alongside the default coding model.
- **Subagent (Task) Deep Integration**:
  - Full support for Cursor Agent mode `Task` tool invocations and multi-turn workflows.
  - Automatic model inheritance from parent conversations.
  - Console support for switching between Asynchronous Background (recommended) and Synchronous Blocking modes.
- **Fix "Reading status..." Infinite Loading Loop**:
  - Persisted control tokens in `control-token.txt` to maintain validity across service restarts.
  - Implemented silent token refresh on 403 errors and accelerated status queries to ~36ms.
- **Fix Tab Settings Save Glitch**:
  - Resolved form submission interception in embedded WebViews using explicit button event listeners and toast notifications.
