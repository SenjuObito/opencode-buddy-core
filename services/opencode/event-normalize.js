/**
 * event-normalize.js
 *
 * Pure normalizers for opencode SSE permission / question events.
 *
 * Two wire shapes exist in the wild:
 *   v1: fields directly on `properties`  — { id, sessionID, questions|permission... }
 *   v2: same payload nested under `properties.data`
 * Both must map onto the canonical request object the host hands to the
 * webview dialogs.
 */

/**
 * Normalize a permission event (v1 `permission.asked` / v2 `permission.v2.asked`)
 * into a canonical request object for the host.
 *
 * v1 data: { id, sessionID, permission, patterns }
 * v2 data: { id, sessionID, action, resources, save? }
 *
 * @param {object} props - event properties (with optional nested `data` for v2)
 * @returns {object}
 */
export function normalizePermissionRequest(props) {
  const data = (props && typeof props.data === 'object') ? props.data : (props || {});
  const permissionId = data.id ?? data.requestID ?? props?.permissionId ?? props?.requestID ?? props?.id ?? '';
  const resources = Array.isArray(data.resources)
    ? data.resources
    : Array.isArray(data.patterns)
      ? data.patterns
      : [];
  const tool = data.action ?? data.permission ?? props?.action ?? props?.tool ?? '';
  // opencode attaches the originating tool call to permission requests
  // (data.tool.callID). Carry it through so the webview can anchor the card to
  // that exact tool_use block. Without it the card can only try to match the
  // action name against the block's tool name, and when that fails it renders
  // at the bottom of the conversation instead of inline.
  const toolCallId = (data.tool && typeof data.tool === 'object')
    ? (data.tool.callID ?? data.tool.messageID ?? '')
    : '';
  const toolUseId = toolCallId || permissionId;
  return {
    type: 'permission',
    sessionId: data.sessionID ?? props?.sessionID ?? undefined,
    permissionId,
    toolUseId,
    // The host reads the snake_case alias (see MessageHandler); keep both
    // spellings so either naming convention resolves to the same call id.
    tool_use_id: toolUseId,
    tool,
    toolName: tool,
    description: resources.join(', '),
    inputs: { command: tool, patterns: resources },
    directory: data.directory ?? props?.directory ?? undefined,
  };
}

/**
 * Normalize a question event (v1 `question.asked` / v2 `question.v2.asked` / `form.created` / `form.asked`)
 * into a canonical request object for the host.
 *
 * v1/v2 question data: { id, sessionID, questions: [QuestionInfo], tool? }
 * v2 form data: { id, sessionID, title, fields: [FormField] }
 *
 * @param {object} props - event properties (with optional nested `data` for v2)
 * @returns {object}
 */
export function normalizeQuestionRequest(props) {
  const data = (props && typeof props.data === 'object') ? props.data : (props || {});
  const tool = (data.tool && typeof data.tool === 'object')
    ? (data.tool.id ?? data.tool.callID ?? data.tool.messageID ?? '')
    : (props?.tool ?? '');

  let questions = [];
  if (Array.isArray(data.questions)) {
    questions = data.questions.map((q) => {
      const item = {
        question: q.question ?? q.text ?? '',
        header: q.header ?? '',
        multiSelect: Boolean(q.multiple ?? q.multiSelect),
        custom: q.custom !== false,
        options: Array.isArray(q.options) ? q.options : [],
      };
      if (q.key !== undefined) item.key = q.key;
      return item;
    });
  } else if (Array.isArray(data.fields) || Array.isArray(props?.fields)) {
    const fields = Array.isArray(data.fields) ? data.fields : props.fields;
    const headerTitle = data.title || props?.title || '';
    questions = fields.map((f) => ({
      key: f.key ?? f.id,
      question: f.title || f.description || f.key || '',
      header: headerTitle,
      multiSelect: f.type === 'multiselect',
      custom: f.custom !== false,
      options: Array.isArray(f.options)
        ? f.options.map((opt) => (typeof opt === 'object' && opt !== null ? { label: opt.label ?? opt.value ?? '', description: opt.description ?? opt.hint ?? '' } : { label: String(opt), description: '' }))
        : [],
    }));
  }

  return {
    type: 'question',
    sessionId: data.sessionID ?? props?.sessionID ?? undefined,
    requestId: data.id ?? props?.requestId ?? props?.id ?? '',
    tool,
    questions,
    directory: data.directory ?? props?.directory ?? undefined,
  };
}
