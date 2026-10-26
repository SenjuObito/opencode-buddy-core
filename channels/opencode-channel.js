/**
 * OpenCode channel command handler – keeps OpenCode-specific logic separated.
 * Uses the persistent `opencode serve` connection via the daemon service.
 */
import { sendMessage as openCodeSendMessage } from '../services/opencode/message-service.js';
import { listModels as openCodeListModels, ensureServerReady } from '../services/opencode/models-service.js';
import { getSessionDirectory } from '../services/opencode/opencode-daemon-service.js';
import {
  getSubagentHistory as openCodeGetSubagentHistory,
  listSubagentStatuses as openCodeListSubagentStatuses,
} from '../services/opencode/subagent-service.js';
import * as engineRegistry from '../services/opencode/engine-registry.js';
import {
  replyPermission as openCodeReplyPermission,
  replyQuestion as openCodeReplyQuestion,
  rejectQuestion as openCodeRejectQuestion,
  listMessages as openCodeListMessages,
  findFiles as openCodeFindFiles,
  getAgents as openCodeGetAgents,
  getCommands as openCodeGetCommands,
  getMcpStatus as openCodeGetMcpStatus,
  shareSession as openCodeShareSession,
  unshareSession as openCodeUnshareSession,
  revertSession as openCodeRevertSession,
  unrevertSession as openCodeUnrevertSession,
  forkSession as openCodeForkSession,
  summarizeSession as openCodeSummarizeSession,
  getSession as openCodeGetSession,
  listSessions as openCodeListSessions,
  deleteSession as openCodeDeleteSession,
  updateSessionTitle as openCodeUpdateSessionTitle,
  toggleSessionFavorite as openCodeToggleSessionFavorite,
} from '../services/opencode/opencode-sdk-client.js';

/**
 * Execute an OpenCode command.
 *
 * Parameter-name compatibility: hosts historically send the working directory
 * as `cwd` (matching opencode.send / opencode.preconnect), while channel
 * commands read `directory`. Missing `directory` used to make session-scoped
 * queries (listMessages / getSessionInfo / revert / …) hit the default
 * directory instead of the project's, which opencode resolves to an empty
 * session — surfacing as "history session loads but the transcript is blank".
 * Backfill `directory` from `cwd` here so both names work.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOpenCodeCommand(command, args, stdinData) {
  if (
    stdinData
    && typeof stdinData === 'object'
    && (stdinData.directory === undefined || stdinData.directory === null || stdinData.directory === '')
    && typeof stdinData.cwd === 'string'
    && stdinData.cwd !== ''
  ) {
    stdinData.directory = stdinData.cwd;
  }

  // Gate the whole one-shot channel entry point on a verified engine mode.
  //
  // This entry is used by the host for history / session / file / MCP commands,
  // and it runs in a *fresh* process that did not spawn `opencode serve` — so it
  // cannot rely on any in-memory mode decided by daemon.js. Previously the
  // per-command `isV2()` read lazily triggered a boot-time-equivalent detection
  // here, which fails on Windows and silently fell back to v1 routes — the
  // "history will not load" failure. `ensure()` probes the already-running
  // server's capabilities instead (one HTTP call in the common case), and is
  // idempotent/O(1) once locked.
  await engineRegistry.ensure();

  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          attachments,
        } = stdinData;
        await openCodeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await openCodeSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      await openCodeListModels();
      break;

    case 'listMessages': {
      const { sessionId, directory, limit } = stdinData || {};
      // 冷启动兜底：历史会话恢复依赖 opencode serve 已就绪。preconnect 在插件
      // 启动时预热 serve，但若 preconnect 失败/过慢，首次 listMessages 会打到
      // 冷 serve 导致 getClient().session.messages 失败/返回空，表现为「首次加载
      // 会话消息列表为空、二次及以后正常」。这里显式等待 serve 就绪再查询。
      await ensureServerReady();
      const limitNum = limit ? Number(limit) : 0;
      const messages = await openCodeListMessages(
        sessionId || '',
        directory || undefined,
        { limit: limitNum > 0 ? limitNum : undefined },
      );
      // 逐条输出（NDJSON）：此前整包单行 JSON 会被 daemon stdout 拦截器再次
      // stringify（转义膨胀），宿主侧还要 chunks 累积 + join + 全文提取——
      // 长会话恢复时内存峰值放大 5-8 倍。逐条输出每行都是小字符串，宿主
      // ListMessagesCollector 逐行解析只保留 entry 对象。
      const entries = Array.isArray(messages) ? messages : [];
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        messagesStart: true,
        count: entries.length,
      }));
      for (const entry of entries) {
        console.log(JSON.stringify({
          success: true,
          provider: 'opencode',
          sessionId: sessionId || '',
          messageEntry: entry,
        }));
      }
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        messagesDone: true,
        count: entries.length,
      }));
      break;
    }

    case 'getSubagentHistory': {
      const { sessionId, toolUseId, description, directory, poll } = stdinData || {};
      await ensureServerReady();
      const history = await openCodeGetSubagentHistory({
        parentSessionId: sessionId || '',
        toolUseId: toolUseId || '',
        description: description || '',
        directory: directory || undefined,
        poll: poll === true,
      });
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        history: history ?? null,
      }));
      break;
    }

    case 'getSessionSubagents': {
      const { sessionId, directory, limit } = stdinData || {};
      await ensureServerReady();
      const result = await openCodeListSubagentStatuses({
        parentSessionId: sessionId || '',
        directory: directory || undefined,
        limit: Number(limit) || 20,
      });
      console.log(JSON.stringify({
        success: result.success !== false,
        provider: 'opencode',
        sessionId: sessionId || '',
        subagents: result.subagents ?? [],
        ...(result.error ? { error: result.error } : {}),
      }));
      break;
    }

    case 'getSessionInfo': {
      const { sessionId, directory } = stdinData || {};
      // 与 listMessages 同因：跨会话加载时从 daemon session.get 读权威状态，
      // 同样需要 serve 就绪，否则首次查询失败返回空而第二次才成功。
      await ensureServerReady();
      // opencode session 原生持久化 agent（模式）与 model {providerID, id, variant}
      // （variant 即推理力度映射），是会话级状态的权威来源。
      const session = await openCodeGetSession(sessionId || '', directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        session: session ?? null,
      }));
      break;
    }

    case 'findFiles': {
      // @ 文件补全：服务端 fs.find（与 TUI 同源，已按 frecency+模糊排序）。
      const { query, limit, directory } = stdinData || {};
      try {
        await ensureServerReady();
        const entries = await openCodeFindFiles({
          query: typeof query === 'string' ? query : '',
          limit: typeof limit === 'string' ? limit : '20',
          directory: directory || undefined,
        });
        console.error(
          `[DEBUG][OpenCodeFindFiles] query="${query || ''}" directory=${directory || '-'} entries=${entries.length}`,
        );
        console.log(JSON.stringify({
          success: true,
          provider: 'opencode',
          entries: Array.isArray(entries) ? entries : [],
        }));
      } catch (err) {
        console.error(`[DEBUG][OpenCodeFindFiles] failed: ${err?.message || err}`);
        throw err;
      }
      break;
    }

    case 'listAgents': {
      const { directory } = stdinData || {};
      const agents = await openCodeGetAgents(directory || undefined);
      // 输出约定与 listModels/listMessages 一致：单行 JSON（daemon 模式包装为 {id,line}）。
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        agents: Array.isArray(agents) ? agents : [],
      }));
      break;
    }

    case 'listCommands': {
      const { directory } = stdinData || {};
      const commands = await openCodeGetCommands(directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        commands: Array.isArray(commands) ? commands : [],
      }));
      break;
    }

    case 'listMcpServers': {
      const { directory } = stdinData || {};
      // opencode 的 MCP server 配置由 opencode 自身管理（config.json）；插件侧
      // 从 mcp.status 枚举服务器名作为可展示列表（server spec 不暴露时给占位）。
      const statuses = await openCodeGetMcpStatus(directory || undefined);
      const servers = (Array.isArray(statuses) ? statuses : []).map((s) => ({
        id: s.name,
        name: s.name,
        server: { type: 'stdio' },
        description: 'opencode MCP server',
      }));
      console.log(JSON.stringify({ success: true, provider: 'opencode', servers }));
      break;
    }

    case 'getMcpStatus': {
      const { directory } = stdinData || {};
      const statuses = await openCodeGetMcpStatus(directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        statuses: Array.isArray(statuses) ? statuses : [],
      }));
      break;
    }

    case 'replyPermission': {
      const { sessionId, permissionID, reply, rejectMessage, directory } = stdinData || {};
      // Reply endpoint is workspace-scoped; prefer the daemon's session
      // registry (authoritative), fall back to an explicit `directory` param
      // from the host (covers daemons restarted mid-turn with an empty registry).
      const resolvedDirectory = getSessionDirectory(sessionId) || directory;
      // cc-gui vocabulary (allow/allowAlways/deny) → SDK PermissionV2Reply
      const sdkReply = reply === 'allowAlways' ? 'always' : reply === 'deny' ? 'reject' : 'once';
      await openCodeReplyPermission(sessionId, permissionID, sdkReply, rejectMessage, resolvedDirectory);
      break;
    }

    case 'replyQuestion': {
      const { sessionId, answers, directory: explicitDirectory } = stdinData || {};
      const questionID = stdinData?.questionID || stdinData?.requestId || stdinData?.id;
      const directory = getSessionDirectory(sessionId) || explicitDirectory;
      console.log(`[opencode-channel] replyQuestion sessionId=${sessionId} questionID=${questionID} directory=${directory || '-'} answers=${JSON.stringify(answers)}`);
      await openCodeReplyQuestion(sessionId, questionID, Array.isArray(answers) ? answers : [], directory);
      console.log(`[opencode-channel] replyQuestion SUCCESS`);
      break;
    }

    case 'rejectQuestion': {
      const { sessionId, directory: explicitDirectory } = stdinData || {};
      const questionID = stdinData?.questionID || stdinData?.requestId || stdinData?.id;
      const directory = getSessionDirectory(sessionId) || explicitDirectory;
      await openCodeRejectQuestion(sessionId, questionID, directory);
      break;
    }

    case 'summarize': {
      const { sessionId, directory, model: explicitModel, providerID, modelID } = stdinData || {};
      const model = explicitModel || (providerID && modelID ? `${providerID}/${modelID}` : undefined);
      // summarize 需要项目目录来运行摘要任务；宿主未传时回退到 daemon 记录的会话目录。
      // 与 listMessages 同因：resolveSummarizeModel 要查 session.get，冷 serve 会静默失败。
      console.error(`[summarize] start sessionId=${sessionId} directory=${directory || '-'} model=${model || '(session default)'} pid=${process.pid}`);
      try {
        await ensureServerReady();
        console.error('[summarize] server ready, calling summarizeSession');
        await openCodeSummarizeSession(sessionId, directory || getSessionDirectory(sessionId), model);
        console.error('[summarize] summarizeSession resolved OK');
        console.log(JSON.stringify({ success: true, provider: 'opencode' }));
      } catch (err) {
        console.error(`[summarize] failed: ${err?.message || err}`);
        throw err;
      }
      break;
    }

    case 'shareSession': {
      const { sessionId, directory } = stdinData || {};
      const share = await openCodeShareSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', share: share ?? null }));
      break;
    }

    case 'unshareSession': {
      const { sessionId, directory } = stdinData || {};
      await openCodeUnshareSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode' }));
      break;
    }

    case 'revert': {
      const { sessionId, messageID, directory } = stdinData || {};
      const result = await openCodeRevertSession(sessionId, messageID, directory || undefined);
      const revertInfo = result?.revert ?? (result?.messageID ? result : null);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        session: result?.revert ? result : (revertInfo ? { revert: revertInfo } : result),
        revert: revertInfo,
      }));
      break;
    }

    case 'unrevert': {
      const { sessionId, directory } = stdinData || {};
      const result = await openCodeUnrevertSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', session: result ?? null, revert: null }));
      break;
    }

    case 'fork': {
      const { sessionId, messageID, directory } = stdinData || {};
      const forked = await openCodeForkSession(sessionId, messageID, directory || undefined);
      // 与 listMessages 相同输出约定：单行 JSON。
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        newSessionId: forked?.id ?? '',
        session: forked ?? null,
      }));
      break;
    }

    case 'listSessions': {
      const { directory, limit, parentID } = stdinData || {};
      await ensureServerReady();
      const limitNum = limit ? Number(limit) : undefined;
      const sessions = await openCodeListSessions(directory || undefined, limitNum, parentID || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessions: Array.isArray(sessions) ? sessions : [],
      }));
      break;
    }

    case 'deleteSession': {
      const { sessionId, directory } = stdinData || {};
      await ensureServerReady();
      await openCodeDeleteSession(sessionId || '', directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', sessionId }));
      break;
    }

    case 'updateSessionTitle': {
      const { sessionId, title, directory } = stdinData || {};
      await ensureServerReady();
      await openCodeUpdateSessionTitle(sessionId || '', title || '', directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', sessionId, title }));
      break;
    }

    case 'toggleFavorite': {
      const { sessionId, isFavorited, directory } = stdinData || {};
      await ensureServerReady();
      const res = await openCodeToggleSessionFavorite(sessionId || '', isFavorited, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', sessionId, ...res }));
      break;
    }

    default:
      throw new Error(`Unknown OpenCode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return [
    'send', 'listModels', 'listMessages', 'getSubagentHistory', 'getSessionSubagents', 'getSessionInfo', 'listAgents', 'listCommands',
    'listMcpServers', 'getMcpStatus', 'replyPermission', 'replyQuestion', 'rejectQuestion',
    'shareSession', 'unshareSession', 'revert', 'unrevert', 'fork', 'summarize',
    'findFiles', 'listSessions', 'deleteSession', 'updateSessionTitle', 'toggleFavorite',
  ];
}
