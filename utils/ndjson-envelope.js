/**
 * NDJSON envelope + line splitting for the daemon's stdout protocol.
 *
 * This is the **only** place session identity enters the wire format. It lives
 * in its own module (rather than inlined in `daemon.js`) so the contract —
 * envelope shape and the single-line fast path — is unit-testable without
 * booting the daemon.
 *
 * Envelope:
 *   { id, session, turn, seq, line }
 *     id      request/response pairing key (control plane); null otherwise
 *     session the session the line belongs to (data ownership); null ⇒ the line
 *             belongs to no session and MUST NOT be attributed to one
 *     turn    turnId — the session's `durable.seq` at turn start; null outside a turn
 *     seq     server-provided monotonic sequence within the session
 *
 * See `docs/multi-session-identity-refactoring.md` §2.2.
 */

/**
 * Does this identity record carry anything at all?
 * @param {{ id: string|null, sessionId: string|null }} ctx
 * @returns {boolean}
 */
export function hasIdentity(ctx) {
  return Boolean(ctx) && (ctx.id !== null || ctx.sessionId !== null);
}

/**
 * Build the wire envelope for one protocol line.
 * @param {{ id: string|null, sessionId: string|null, turnId: number|null, seq: number|null }} ctx
 * @param {string} line
 */
export function buildEnvelope(ctx, line) {
  return {
    id: ctx?.id ?? null,
    session: ctx?.sessionId ?? null,
    turn: ctx?.turnId ?? null,
    seq: ctx?.seq ?? null,
    line,
  };
}

/**
 * Split a stdout chunk into protocol lines and hand each to `onLine`.
 *
 * Fast path: during streaming, a chunk is almost always exactly one
 * `[TAG] …\n` string, so comparing indices avoids allocating a split array
 * (~100×/s per active session). Empty lines are dropped.
 *
 * @param {string} text
 * @param {(line: string) => void} onLine
 */
export function forEachProtocolLine(text, onLine) {
  if (text.length === 0) return;
  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) {
    onLine(text);
    return;
  }
  if (firstNewline === text.length - 1) {
    // Fast path: exactly `…\n`
    onLine(text.slice(0, firstNewline));
    return;
  }
  if (text.indexOf('\n', firstNewline + 1) === -1) {
    // Two lines, only the first is terminated
    onLine(text.slice(0, firstNewline));
    onLine(text.slice(firstNewline + 1));
    return;
  }
  for (const line of text.split('\n')) onLine(line);
}
