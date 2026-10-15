<a id="readme-top"></a>

<div align="center">

# OpenCode Buddy Core (`opencode-buddy-core`)

<p align="center">
  <strong>The Unified SSOT Protocol Daemon & Runtime Kernel for OpenCode IDE Plugins</strong>
  <br />
  <span>驱动 VS Code 与 IntelliJ IDEA 双端插件的唯一领域模型权威数据源与协议守护进程</span>
</p>

[![CI & Release](https://img.shields.io/github/actions/workflow/status/SenjuObito/opencode-buddy-core/ci.yml?branch=main&style=flat-square&logo=github)](https://github.com/SenjuObito/opencode-buddy-core/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/SenjuObito/opencode-buddy-core/pulls)

<p align="center">
  <a href="#-architecture--responsibilities">Architecture</a> •
  <a href="#-project-structure">Structure</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-ide-integration-specification">Integration Spec</a> •
  <a href="#-contributing">Contributing</a> •
  <a href="#-license">License</a>
</p>

</div>

---

<details>
  <summary>Table of Contents / 目录</summary>
  <ol>
    <li><a href="#-architecture--responsibilities">Architecture & Responsibilities</a></li>
    <li><a href="#-project-structure">Project Structure</a></li>
    <li>
      <a href="#-quick-start">Quick Start</a>
      <ul>
        <li><a href="#1-prerequisites">Prerequisites</a></li>
        <li><a href="#2-installation">Installation</a></li>
        <li><a href="#3-running-tests">Running Tests</a></li>
        <li><a href="#4-building-distribution-artifacts">Building Artifacts</a></li>
      </ul>
    </li>
    <li><a href="#-ide-integration-specification">IDE Integration Specification</a></li>
    <li><a href="#-contributing">Contributing</a></li>
    <li><a href="#-license">License</a></li>
  </ol>
</details>

---

## 🎯 Architecture & Responsibilities

在传统多端插件开发模式下，VS Code（TypeScript）与 IntelliJ IDEA（Java）往往各自编写一套胶水层维护会话状态机，导致跨端代码漂移、解析不一致与状态割裂。

**`opencode-buddy-core`** 将所有跨端的核心业务逻辑下沉并彻底收敛，充当双端插件**唯一的领域模型权威数据源（Single Source of Truth, SSOT）**：

```
       ┌────────────────────────┐      ┌─────────────────────────┐
       │  VS Code Extension     │      │  IntelliJ IDEA Plugin   │
       │  (TypeScript Host)     │      │  (Kotlin / Java Host)   │
       └───────────┬────────────┘      └────────────┬────────────┘
                   │                                │
                   └───────────┐        ┌───────────┘
                               ▼        ▼
                      Standard I/O (NDJSON Events)
                               │        │
             ┌─────────────────┴────────┴─────────────────┐
             │       opencode-buddy-core Daemon           │
             │  - Process Governance & Prewarm / Keepalive│
             │  - Turn State Machine & Token Aggregation  │
             │  - Protocol Normalization & Safety Checks  │
             └─────────────────────┬──────────────────────┘
                                   │
                                   ▼
                       opencode serve (OpenCode CLI)
```

### 核心职责

1. **OpenCode 进程治理（Daemon Lifecycle）**：
   - 智能自动探测系统中的 `opencode` CLI 可执行文件路径；
   - 治理后台 `opencode serve` 服务的启动、预热（Prewarm）、心跳保活与异常崩溃自愈。
2. **Turn 轮次生命周期与 Token/费用原子聚合**：
   - 监听 `message.updated` 与 `step-finish` 事件，实时累加一轮会话中所有子步骤的 `output` 与 `reasoning` Token；
   - 统一精确换算多模型消费成本（USD Cost），产出不可变的轮次终态快照。
3. **协议与事件归一化（Event Normalization）**：
   - 将底层 OpenCode SDK 多样化事件统一转换为标准轻量 NDJSON 协议，通过标准 I/O 向上推送到插件宿主。
4. **多模态与工具权限安全通道**：
   - 处理图片/文件附件解析（`file-parts`）、工具调用权限审批（Permission Request）与安全沙箱拦截。

---

## 📂 Project Structure

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

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js** >= 18.0.0
- **npm** 或 **pnpm**
- **opencode** CLI

### 2. Installation
```bash
git clone https://github.com/SenjuObito/opencode-buddy-core.git
cd opencode-buddy-core
npm install
```

### 3. Running Tests
本项目内置覆盖全流程的单元测试（协议解析、模型解析、多模态、进程管理、路径探测等）：
```bash
npm test
```

### 4. Building Distribution Artifacts
一键将生产依赖与核心源码打包为供 IDE 插件直接分发的独立 ZIP 归档包：
```bash
npm run pack:zip
```
打包完成后会在 `dist/` 目录输出：
- `dist/ai-bridge.zip`：自包含运行依赖的独立归档包（用户端零 `npm install` 需求，解压即用）；
- `dist/ai-bridge.hash`：ZIP 包的 SHA-256 完整性校验和。

---

## 🔌 IDE Integration Specification

### 1. IntelliJ IDEA 插件集成
IDEA 插件通过 Gradle 任务消费构建产物：
- **生产发布**：通过 GitHub Actions 自动下载 Release 对应 Tag 中的 `ai-bridge.zip`；
- **本地调试**：配置环境变量 `OPENCODE_DEV_BRIDGE_PATH=/path/to/opencode-buddy-core`，实现本地修改秒级热生效。

### 2. VS Code 插件集成
VS Code 扩展宿主在启动时通过子进程调用 `daemon.js`，通过 Stdio NDJSON 交换报文，保持协议与状态机字节级一致。

---

## 🤝 Contributing

欢迎任何形式的贡献！如果你有新想法或发现了 Bug：
1. Fork 本仓库并创建分支 (`git checkout -b feature/AmazingFeature`)
2. 提交你的修改 (`git commit -m 'feat: Add some AmazingFeature'`)
3. 推送分支 (`git push origin feature/AmazingFeature`)
4. 提交 Pull Request

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for more information.

<p align="right">(<a href="#readme-top">back to top ↑</a>)</p>
