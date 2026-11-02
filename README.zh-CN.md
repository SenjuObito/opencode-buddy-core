<a id="readme-top"></a>

<div align="center">

# OpenCode Buddy Core (`opencode-buddy-core`)

<p align="center">
  <strong>OpenCode IDE 插件生态的统一 SSOT 协议守护进程与运行时内核</strong>
  <br />
  <span>驱动 VS Code 与 IntelliJ IDEA 双端插件的唯一领域模型权威数据源</span>
</p>

[![CI & Release](https://img.shields.io/github/actions/workflow/status/SenjuObito/opencode-buddy-core/ci.yml?branch=main&style=flat-square&logo=github)](https://github.com/SenjuObito/opencode-buddy-core/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/SenjuObito/opencode-buddy-core/pulls)

<p align="center">
  <a href="README.md">English</a> •
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#-架构定位与核心职责">架构定位</a> •
  <a href="#-项目结构">项目结构</a> •
  <a href="#-快速上手">快速上手</a> •
  <a href="#-双端插件集成规范">集成规范</a> •
  <a href="#-参与贡献">参与贡献</a> •
  <a href="#-许可证">许可证</a>
</p>

</div>

---

<details>
  <summary>目录导航</summary>
  <ol>
    <li><a href="#-架构定位与核心职责">架构定位与核心职责</a></li>
    <li><a href="#-项目结构">项目结构</a></li>
    <li>
      <a href="#-快速上手">快速上手</a>
      <ul>
        <li><a href="#1-环境要求">1. 环境要求</a></li>
        <li><a href="#2-安装依赖">2. 安装依赖</a></li>
        <li><a href="#3-运行单元测试">3. 运行单元测试</a></li>
        <li><a href="#4-构建分发产物">4. 构建分发产物</a></li>
      </ul>
    </li>
    <li><a href="#-双端插件集成规范">双端插件集成规范</a></li>
    <li><a href="#-参与贡献">参与贡献</a></li>
    <li><a href="#-许可证">许可证</a></li>
  </ol>
</details>

---

## 🎯 架构定位与核心职责

在传统的多端插件开发模式中，VS Code（TypeScript）与 IntelliJ IDEA（Kotlin/Java）各自编写一套胶水层维护会话状态机，这往往导致跨端代码漂移、解析事件不一致与状态割裂等诸多问题。

**`opencode-buddy-core`** 将所有跨端的核心业务逻辑下沉并彻底收敛，充当双端插件**唯一的领域模型权威数据源（Single Source of Truth, SSOT）**：

```
       ┌────────────────────────┐      ┌─────────────────────────┐
       │  VS Code 插件宿主      │      │  IntelliJ IDEA 插件宿主 │
       │  (TypeScript)          │      │  (Kotlin / Java)        │
       └───────────┬────────────┘      └────────────┬────────────┘
                   │                                │
                   └───────────┐        ┌───────────┘
                               ▼        ▼
                        标准 I/O (NDJSON 事件流)
                               │        │
             ┌─────────────────┴────────┴─────────────────┐
             │       opencode-buddy-core 守护进程         │
             │  - 进程治理、智能预热与崩溃自愈保活        │
             │  - 会话轮次状态机与 Token/费用原子聚合     │
             │  - 协议归一化与安全沙箱拦截                │
             └─────────────────────┬──────────────────────┘
                                   │
                                   ▼
                       opencode serve (OpenCode CLI)
```

### 核心职责

1. **守护进程治理与生命周期管理**：
   - 跨平台智能自动探测系统中的 `opencode` CLI 可执行文件路径；
   - 治理后台 `opencode serve` 服务的启动、秒级预热（Prewarm）、心跳保活与异常崩溃自愈。
2. **会话轮次状态机与 Token/费用原子聚合**：
   - 监听底层 `message.updated` 与 `step-finish` 事件，实时累加一轮会话中所有子步骤的输出（`output`）与思考（`reasoning`）Token；
   - 统一精确换算多模型服务商的实际消费成本（USD Cost），产出不可变的轮次终态快照。
3. **协议与事件标准化归一**：
   - 将底层 OpenCode SDK 复杂多样的事件统一转换为轻量级标准 NDJSON 数据帧，通过标准 I/O 流式推送到插件宿主。
4. **多模态附件与权限安全通道**：
   - 负责文件与图片附件解析（`file-parts`）、工具调用权限审批（单次允许、始终允许、拒绝）与安全沙箱拦截。

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

## ⚡ 快速上手

### 1. 环境要求
- **Node.js** >= 18.0.0
- **npm** 或 **pnpm**
- 系统中已安装 **opencode** CLI 并配置至系统环境变量 `PATH`

### 2. 安装依赖
```bash
git clone https://github.com/SenjuObito/opencode-buddy-core.git
cd opencode-buddy-core
npm install
```

### 3. 运行单元测试
本项目内置覆盖全流程的单元测试套件（涵盖协议解析、模型解析、多模态、进程管理与路径探测）：
```bash
npm test
```

### 4. 构建分发产物
一键将生产依赖与核心源码打包为供 IDE 插件直接使用的独立 ZIP 归档包：
```bash
npm run pack:zip
```
打包完成后会在 `dist/` 目录输出：
- `dist/ai-bridge.zip`：自包含完整运行依赖的归档包（终端用户零 `npm install` 依赖，解压即用）；
- `dist/ai-bridge.hash`：ZIP 包的 SHA-256 校验和，确保分发完整性。

---

## 🔌 双端插件集成规范

### 1. IntelliJ IDEA 插件集成
JetBrains 插件通过 Gradle 任务消费构建产物：
- **生产发布**：通过 GitHub Actions 自动化流程拉取对应 Release Tag 的 `ai-bridge.zip`；
- **本地开发**：配置环境变量 `OPENCODE_DEV_BRIDGE_PATH=/path/to/opencode-buddy-core`，即可实现本地源码修改秒级生效。

### 2. VS Code 插件集成
VS Code 扩展宿主在启动时直接将 `daemon.js` 作为子进程运行，通过 Stdio NDJSON 流交换报文，保持协议逻辑与 JetBrains 端 100% 字节级一致。

---

## 🤝 参与贡献

开源社区的魅力正是来源于每一位开发者的贡献、交流与创造。
1. Fork 本仓库并创建分支（`git checkout -b feature/AmazingFeature`）
2. 提交你的修改（`git commit -m 'feat: Add some AmazingFeature'`）
3. 推送分支（`git push origin feature/AmazingFeature`）
4. 发起 Pull Request

---

## 📄 许可证

本项目基于 **MIT License** 开源。详情参见 [`LICENSE`](./LICENSE)。

<p align="right">(<a href="#readme-top">回到顶部 ↑</a>)</p>
