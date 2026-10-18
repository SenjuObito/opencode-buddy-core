/**
 * Shared AsyncLocalStorage context for per-request / per-session output
 * attribution.
 *
 * This is the **single source of session identity** for every line the daemon
 * writes to stdout. Nothing else is allowed to invent a session, infer one, or
 * fall back to "the current session" — see
 * `docs/multi-session-identity-refactoring.md` (INV-A).
 *
 * Store shape (a mutable identity record):
 *
 *   {
 *     id:        string|null   // request/response correlation key (HTTP pairing).
 *                              //   Answers "which request does this reply belong to".
 *                              //   Control-plane acks (`done`) need it; data lines don't.
 *     sessionId: string|null   // the session this output belongs to (data ownership).
 *                              //   Answers "which conversation does this content belong to".
 *     turnId:    number|null   // the turn this output belongs to; null outside a turn
 *     seq:       number|null   // server-provided monotonic sequence within the
 *                              //   session (opencode `durable.seq`); null when the
 *                              //   server does not supply one
 *   }
 *
 * `id` and `sessionId` deliberately coexist: conflating them into one string is
 * what made concurrent sessions un-attributable (the old `{id, line}` envelope).
 *
 * The record is created once per request/event and then **mutated in place** via
 * `bindSession()` / `bindSeq()` as the identity becomes known (a brand-new
 * session's id only exists after the server creates it). Mutating the active
 * store is what lets a single long-lived async turn keep tagging every line it
 * emits — including lines emitted after dozens of awaits — without threading an
 * explicit parameter through the whole call chain.
 *
 * daemon.js reads this in the stdout interceptor and stamps the NDJSON envelope
 * `{id, session, turn, seq, line}`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

/** An empty (all-unknown) identity record. Frozen — never mutate this one. */
export const EMPTY_CONTEXT = Object.freeze({
  id: null,
  sessionId: null,
  turnId: null,
  seq: null,
});

/**
 * Read the active identity record, normalized to the four-field shape.
 * @returns {{ id: string|null, sessionId: string|null, turnId: number|null, seq: number|null }}
 */
export function currentContext() {
  const store = requestContext.getStore();
  if (!store || typeof store !== 'object') return { ...EMPTY_CONTEXT };
  return {
    id: store.id ?? null,
    sessionId: store.sessionId ?? null,
    turnId: store.turnId ?? null,
    seq: store.seq ?? null,
  };
}

/**
 * Attach a session identity to the **active** record (no-op when there is none).
 * Called by the turn path as soon as the session id is known — which, for a
 * newly created session, is after `createSession()` returns.
 *
 * @param {string|null} sessionId
 * @param {{ turnId?: number|null }} [opts]
 * @returns {boolean} true when a live record was updated
 */
export function bindSession(sessionId, opts = {}) {
  const store = requestContext.getStore();
  if (!store || typeof store !== 'object') return false;
  store.sessionId = sessionId || null;
  if (Object.prototype.hasOwnProperty.call(opts, 'turnId')) {
    store.turnId = opts.turnId ?? null;
  }
  return true;
}

/**
 * Attach the server-provided sequence number to the active record.
 * @param {number|null} seq
 * @param {{ turnId?: number|null }} [opts]
 * @returns {boolean}
 */
export function bindSeq(seq, opts = {}) {
  const store = requestContext.getStore();
  if (!store || typeof store !== 'object') return false;
  store.seq = typeof seq === 'number' ? seq : null;
  if (Object.prototype.hasOwnProperty.call(opts, 'turnId')) {
    store.turnId = opts.turnId ?? null;
  }
  return true;
}

/**
 * Run `fn` with an explicit, already-known identity. Used by paths that have no
 * ambient record but still must emit session-scoped lines — the serve-exit
 * watchdog and the abort bypass are the two cases.
 *
 * @param {{ id?: string|null, sessionId?: string|null, turnId?: number|null, seq?: number|null }} ctx
 * @param {() => any} fn
 */
export function runWithIdentity(ctx, fn) {
  return requestContext.run({
    id: ctx?.id ?? null,
    sessionId: ctx?.sessionId ?? null,
    turnId: ctx?.turnId ?? null,
    seq: ctx?.seq ?? null,
  }, fn);
}
