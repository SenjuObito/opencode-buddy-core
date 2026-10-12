# OpenCode Buddy Core (`opencode-buddy-core`)

[![CI & Release](https://github.com/SenjuObito/opencode-buddy-core/actions/workflows/ci.yml/badge.svg)](https://github.com/SenjuObito/opencode-buddy-core/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**OpenCode Buddy Core** 是 OpenCode Buddy 插件生态的核心协议守护进程与运行时引擎（Core Daemon & Lifecycle Kernel）。

它作为 **唯一的领域模型权威数据源（Single Source of Truth, SSOT）**，同时驱动 **VS Code 插件** 与 **IntelliJ IDEA 插件**。

---

## 🎯 架构定位与核心职责

在传统模式下，双端插件各自用 TypeScript / Java 胶水层手写会话状态机，导致跨平台代码漂移与状态割裂。`opencode-buddy-core` 将所有跨端的核心业务逻辑下沉并彻底收敛：

1. **OpenCode Serve 守护进程治理**：自动探测 CLI 路径、管理后台 `opencode serve` 启停、心跳保活与异常崩溃自愈；
2. **Turn 生命周期与 Token/费用原子聚合**：
   - 监听 `message.updated` 与 `step-finish`，实时累加一轮会话中所有子步骤的 `output` 与 `reasoning` Token；
   - 统一换算多模型消费成本（USD Cost），产出不可变的轮次终态快照；
3. **协议与事件归一化（Event Normalization）**：
   - 将 OpenCode SDK 的底层事件统一转换为标准 NDJSON 协议，通过标准 I/O 向上推送到插件宿主；
4. **多模态与工具权限通道**：
   - 处理图片/文件附件解析（`file-parts`）、工具调用权限审批（Permission Request）与安全拦截。

---

## 📂 项目结构

```text
opencode-buddy-core/
├── daemon.js                     # 守护进程主入口 (Stdio NDJSON 协议服务)
├── channel-manager.js            # 渠道与命令调度管理
├── permission-handler.js         # 权限审批与安全策略
├── channels/
│   └── opencode-channel.js       # OpenCode 专属渠道实现
├── config/
│   └── api-config.js             # API 与环境安全配置
├── services/
│   └── opencode/
│       ├── opencode-daemon-service.js  # Turn 状态机、Token/费用聚合核心
│       ├── opencode-sdk-client.js      # @opencode-ai/sdk 客户端封装
│       ├── opencode-serve-manager.js   # opencode serve 进程管理
│       ├── models-service.js           # 模型动态目录拉取
│       └── event-normalize.js          # 事件解析与标准化
├── utils/                        # 跨平台路径、命令行探测、日志、工具函数
├── scripts/
│   └── pack-zip.mjs              # 双端通用的产物打包脚本
└── .github/workflows/ci.yml      # 自动化 CI 与 Release 流程
```

---

## 🚀 快速上手

### 1. 环境要求
* Node.js >= 18.0.0
* npm 或 pnpm

### 2. 安装依赖
```bash
npm install
```

### 3. 运行全量单元测试
本项目内置全面的测试套件（覆盖协议解析、模型解析、多模态、进程管理、路径探测等）：
```bash
npm test
```

### 4. 构建分发产物
一键将生产依赖与核心源码打包为供 IDE 插件直接使用的 Zip 包：
```bash
npm run pack:zip
```
执行后将在 `dist/` 目录下生成：
* `dist/ai-bridge.zip`：自包含生产运行依赖的归档包（解压即用，用户端零 `npm install` 需求）；
* `dist/ai-bridge.hash`：ZIP 包的 SHA-256 校验和。

---

## 🔌 双端插件集成规范

### 1. IntelliJ IDEA 插件集成
IDEA 插件通过 Gradle 任务直接消费构建产物：
* CI / 生产发布时：自动下载 GitHub Releases 中对应 Tag 的 `ai-bridge.zip`；
* 本地调试时：可通过指定 `OPENCODE_DEV_BRIDGE_PATH` 环境变量直接指向本仓库目录，实现代码改动即时生效。

### 2. VS Code 插件集成
VS Code 扩展宿主可直接通过子进程或 npm 依赖运行 `daemon.js`，保持协议与 IDEA 端 100% 字节级一致。

---

## 📄 License
MIT License.
