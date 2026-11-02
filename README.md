<a id="readme-top"></a>

<div align="center">

# OpenCode Buddy Core (`opencode-buddy-core`)

<p align="center">
  <strong>The Unified SSOT Protocol Daemon &amp; Runtime Kernel for OpenCode IDE Plugins</strong>
  <br />
  <span>The authoritative single source of truth driving both VS Code and IntelliJ IDEA plugins</span>
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
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#-architecture--responsibilities">Architecture &amp; Responsibilities</a></li>
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

In traditional multi-IDE plugin architectures, VS Code (TypeScript) and IntelliJ IDEA (Kotlin/Java) each implement their own glue layer to manage conversational state machines. This inevitably leads to cross-platform code drift, divergent event handling, and synchronization bugs.

**`opencode-buddy-core`** consolidates and encapsulates all cross-platform business logic, serving as the **Single Source of Truth (SSOT)** for both extension hosts:

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

### Core Responsibilities

1. **Process Governance & Daemon Lifecycle**:
   - Automatically discovers the executable path of the `opencode` CLI across different operating systems;
   - Manages background `opencode serve` daemon lifecycle, including instant pre-warming, heartbeat monitoring, and automatic crash recovery.
2. **Turn Lifecycle & Atomic Token/Cost Aggregation**:
   - Listens to `message.updated` and `step-finish` events, aggregating output tokens and reasoning tokens across all sub-steps within an interaction turn;
   - Unifies real-time cost calculation (USD) across diverse model providers and delivers immutable turn completion snapshots.
3. **Protocol & Event Normalization**:
   - Translates low-level OpenCode SDK events into standardized, lightweight NDJSON streaming frames dispatched via standard I/O to IDE hosts.
4. **Multimodal Attachments & Permission Security Channel**:
   - Handles file and image attachments (`file-parts`), interactive user permission requests (allow once, always allow, reject), and safety sandbox verification.

---

## 📂 Project Structure

```text
opencode-buddy-core/
├── daemon.js                     # Main daemon entrypoint (Stdio NDJSON protocol server)
├── channel-manager.js            # Channel dispatcher and command router
├── permission-handler.js         # Permission approval and security policies
├── channels/
│   └── opencode-channel.js       # Dedicated OpenCode channel implementation
├── config/
│   └── api-config.js             # Environment and API configuration
├── services/
│   └── opencode/
│       ├── opencode-daemon-service.js  # Turn state machine and token aggregation engine
│       ├── opencode-sdk-client.js      # Encapsulated @opencode-ai/sdk client
│       ├── opencode-serve-manager.js   # Background opencode serve process manager
│       ├── models-service.js           # Dynamic model catalog retrieval
│       └── event-normalize.js          # Event parsing and normalization
├── utils/                        # Cross-platform paths, CLI detection, logging, utilities
├── scripts/
│   └── pack-zip.mjs              # Universal artifact packaging script
└── .github/workflows/ci.yml      # Automated CI and release pipeline
```

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js** >= 18.0.0
- **npm** or **pnpm**
- **opencode** CLI installed and available on `PATH`

### 2. Installation
```bash
git clone https://github.com/SenjuObito/opencode-buddy-core.git
cd opencode-buddy-core
npm install
```

### 3. Running Tests
The repository includes a comprehensive unit test suite covering protocol parsing, model resolution, multimodal handling, process management, and path detection:
```bash
npm test
```

### 4. Building Distribution Artifacts
Package the production dependencies and core source code into a standalone, zero-dependency ZIP archive for IDE plugins:
```bash
npm run pack:zip
```
Build outputs generated in the `dist/` directory:
- `dist/ai-bridge.zip`: Self-contained runtime archive requiring no `npm install` on the user's machine;
- `dist/ai-bridge.hash`: SHA-256 integrity checksum for verification.

---

## 🔌 IDE Integration Specification

### 1. IntelliJ IDEA Plugin Integration
The JetBrains plugin consumes the packaged runtime directly via Gradle tasks:
- **Production Releases**: Automated CI downloads the `ai-bridge.zip` asset corresponding to the release tag;
- **Local Development**: Set the environment variable `OPENCODE_DEV_BRIDGE_PATH=/path/to/opencode-buddy-core` for instant live code reloading.

### 2. VS Code Extension Integration
The VS Code extension host launches `daemon.js` as a background child process, communicating over Stdio NDJSON streams to maintain identical protocol semantics and state machine behavior with the JetBrains edition.

---

## 🤝 Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create.
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'feat: Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for more information.

<p align="right">(<a href="#readme-top">back to top ↑</a>)</p>
