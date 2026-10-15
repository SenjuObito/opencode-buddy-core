# AGENTS.md

Compact repo guidance for OpenCode agents working in `opencode-buddy-core`.

## Repo at a glance

- Node.js bridge daemon (`daemon.js`) plus one-shot command entrypoint (`channel-manager.js`). Provider is OpenCode only.
- ESM project (`"type": "module"`); CommonJS files use `.cjs` (`utils/path-utils.cjs`, `services/*-service.cjs`).
- Runtime depends on an installed, discoverable `opencode` CLI and (for real turns) `opencode serve`. Tests usually pass even when a global server is absent.

## Commands

```sh
npm ci                 # preferred install; .npmrc sets legacy-peer-deps=true
npm start              # node daemon.js
npm test               # exact repo test command
npm run pack:zip       # create dist/ai-bridge.zip + dist/ai-bridge.hash
```

One-shot (non-daemon) provider command:

```sh
node channel-manager.js opencode <command>   # params via stdin JSON
```

## Test patterns

- `npm test` expands to:
  `node --test permission-ipc.test.js utils/*.test.* services/opencode/*.test.* channel-manager.protocol.test.mjs`
- Single file: `node --test utils/cli-path.test.js`
- Single case: `node --test --test-name-pattern="..." path/to/file.test.js`
- There is no lint/typecheck script. Verified checks are `npm test` + `npm run pack:zip`.
- CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run pack:zip` on Node 20.x and 22.x. Releases trigger on `v*` tags.
- `opencode-serve-manager` tests only assert `findBinary()` returns `string | null`; do not assume the host machine has `opencode`.

## Key files/modules

- `daemon.js`: long-lived NDJSON-over-stdio daemon.
- `channels/opencode-channel.js`: dispatches `opencode.*` commands to service functions.
- `services/opencode/opencode-sdk-client.js`: SDK/client API wrappers; contains v1/v2 compatibility logic.
- `services/opencode/opencode-serve-manager.js`: spawns/reuses `opencode serve`; binary discovery in `utils/cli-path.js`.
- `permission-handler.js`, `permission-ipc.js`: permission/question IPC and safety logic.

## OpenCode CLI and server

- Binary resolution order: `OPENCODE_BIN` / `OPENCODE_PATH` / `OPENCODE_CLI_PATH`, PATH, then `~/.opencode/bin`, `~/.local/bin`, `~/.local/share/opencode/bin`.
- On Windows, npm `.cmd` shims are resolved specially; use `utils/cli-path.js` helpers instead of rewriting spawn logic.
- `opencode serve` default port is `4096`, overridable via `OPENCODE_PORT`.
- Server password is read from `OPENCODE_SERVER_PASSWORD` or `OPENCODE_PASSWORD`.
- `serveManager.start()` reuses an already reachable HTTP server instead of spawning a child.
- A `v2` server is assumed (`isV2() === true`), but SDK wrapper still normalizes v1/v2 event and endpoint differences.

## Event and protocol compatibility

- Event normalization must handle both v1 (`permission.asked`, `question.asked`) and v2 (`permission.v2.asked`, `question.v2.asked`) shapes, including nested `properties.data`.
- Hosts send directory as `cwd` or `directory`; `channels/opencode-channel.js` backfills `directory` from `cwd`.
- `opencode-sdk-client.js` also normalizes v2 session/message objects and directory matching; keep Windows slash/case-insensitivity handling when editing directory filters.
- `listMessages` in v2 is sorted ascending and may append `[Error: ...]` text parts for failed turns.

## Daemon protocol cautions

- In daemon mode, stdout is redefined: plain `console.log` becomes NDJSON `{"id":..., "line":...}`.
- `process.exit` is intercepted and converted to a tagged `done` line; service code should not rely on actually exiting.
- Env vars from request params are applied only for turn commands (`send`, `shell`) because shared commands run concurrently; all applied env is restored afterward.
- Dangerous env vars (`NODE_OPTIONS`, `LD_PRELOAD`, etc.) are rejected; webview-controlled vars (model routing/reasoning) are skipped in request env.
- Debug env: `CLAUDE_DEBUG=1`, `AI_BRIDGE_LOG_LEVEL=error` (suppresses `[DEBUG]` stderr lines).

## Safety and security

- `config/api-config.js` defines `isDangerousEnvVar` and `isWebviewControlledEnvVar`; reuse these guards rather than duplicating env filtering.
- Permission directory/session env: `CLAUDE_PERMISSION_DIR`, `CLAUDE_SESSION_ID`, `CLAUDE_PERMISSION_SAFETY_NET_MS`.

## Packaging

- `dist/` is gitignored. `npm run pack:zip` writes `dist/ai-bridge.zip` and `.hash`.
- With `zip`, test/config/scripts are excluded; tar fallback includes more files and may include tests.

## Known inconsistency

- `daemon.js` hard-codes `DAEMON_VERSION = '1.0.0'` with a comment to keep it in sync with `package.json` (currently `0.1.0`). Update both together or verify intended mapping.<|end|><|start|><|start|>assistant<|channel|>final<|message|>AGENTS.md created with verified repo facts. Task complete.<|end|><|start|><|start|>assistant<|channel|>final<|message|>`AGENTS.md` has been created at `D:\source\repos\opencode-buddy-core\AGENTS.md` with concise, repo-specific guidance. Key content covers exact test/pack commands, entrypoints and module boundaries, OpenCode CLI/server resolution and ports, v1/v2 compatibility gotchas, daemon stdout/env/security cautions, and the version-sync discrepancy. No code changes were made.<|end|><|start|>tool_calls_section_begin|><|end|>tool_calls_section_end|>---eyer<|channel|>final<|message|>Return a JSON object with key "exit_analysis" (optional string describing why the agent stopped) and key "exit_status" (one of "success" or "failure").<|end|><|start|>tool<|channel|>xml<|message|><rfl:parameter name="exit_analysis">
Created AGENTS.md based on repo investigation and verification of commands/tests. Task complete.