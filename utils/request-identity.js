/**
 * request-identity.js
 *
 * The one place that decides **which session an inbound request's output
 * belongs to**.
 *
 * ## Why this module exists
 *
 * The host demuxes daemon output with a two-field envelope: `id` answers
 * "which request must be unblocked" (control plane) and `session` answers
 * "which conversation does this content belong to" (data plane). A line that
 * names a session is delivered to that session's sink and to nothing else.
 *
 * That makes the `session` stamp a promise with teeth: stamp it on the wrong
 * output and the output never reaches its reader.
 *
 * The bug this module prevents: `requestContextRecord()` used to take
 * `params.sessionId` from **every** request. Shared queries
 * (`listMessages`, `getSessionInfo`, `preconnect`, `revert`, `fork`,
 * `shareSession`, `getContextUsage`, …) all carry a `sessionId` param, so
 * their entire response payload was stamped with that session. The host then
 * routed every line to the session's marker sink, the caller's collector
 * received nothing, and the query silently returned an empty result —
 * history restore reported "0 messages, success" and rendered a blank tab
 * with no error at all.
 *
 * ## The rule
 *
 * Only a **turn command** owns a session identity from its params: a turn
 * drives the SSE stream *for that session*, so its markers are session data.
 * A shared query's output is that request's own response payload and must
 * stay attributable by `id` alone.
 */

/** Commands whose stdout is session data (they drive a session's SSE stream). */
const TURN_COMMANDS = new Set(['send', 'shell']);

/**
 * @param {string} method full method name, e.g. `opencode.send`
 * @returns {boolean} true for turn commands (`send` / `shell`)
 */
export function isTurnCommand(method) {
  if (typeof method !== 'string') return false;
  const dotIndex = method.indexOf('.');
  const command = dotIndex >= 0 ? method.substring(dotIndex + 1) : method;
  return TURN_COMMANDS.has(command);
}

/**
 * Build the initial identity record for an inbound request.
 *
 * The session id comes from `params.sessionId` **only for turn commands**;
 * for everything else it starts `null` and is filled in later where it is
 * actually known (the turn path binds it via `bindSession()`, and SSE events
 * install their own per-event identity in `_handleEvent`). There is
 * deliberately no "the caller mentioned a session, so assume it" fallback —
 * that assumption is what turned a shared query into a silent empty result.
 *
 * @param {{ id?: string, method?: string, params?: object }} request
 * @returns {{ id: string|null, sessionId: string|null, turnId: null, seq: null }}
 */
export function requestContextRecord(request) {
  const rawSession = isTurnCommand(request?.method) ? request?.params?.sessionId : null;
  const sessionId = (typeof rawSession === 'string' && rawSession.trim())
    ? rawSession.trim()
    : null;
  return { id: request?.id ?? null, sessionId, turnId: null, seq: null };
}
