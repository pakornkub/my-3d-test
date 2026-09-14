// state.mjs -- what survives a server restart.
//
// One JSON file per project under server/state/<project>.json holding the manager's SDK
// session id, the active feature, the current phase, the ticket sessions in flight and
// today's running totals by session key -- a live mirror of the day's log kept in sync by
// index.mjs's broadcast() on every session.cost event, and re-derived from the log itself
// at boot (see runningTotals), so the file is never the source of truth, only a cache of it.
// Small enough to rewrite whole on every change; a database can replace it later without
// touching callers, which only ever call load()/save().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.join(here, 'state');
export const LOG_DIR = path.join(here, 'log');

const EMPTY = () => ({
  managerSessionId: null,
  feature: null,
  phase: 'onboard',
  onboarding: [],          // [{ n, state, detail }]
  jobs: {},                // ticket id -> { agent, sessionId, attempt, status, worktree }
  costs: {},               // session key (`ev.session ?? ev.agent`) -> { agent, usd }, see runningTotals
  updatedAt: null,
});

export function load(projectId) {
  try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(file(projectId), 'utf8')) }; }
  catch { return EMPTY(); }
}

export function save(projectId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(file(projectId), JSON.stringify(state, null, 2) + '\n');
  return state;
}

function file(projectId) { return path.join(STATE_DIR, `${projectId}.json`); }

/** Append-only JSONL of every event the server emitted, one file per project per day. */
export function logEvent(projectId, ev) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date(ev.t ?? Date.now()).toISOString().slice(0, 10);
  fs.appendFileSync(path.join(LOG_DIR, `${projectId}-${day}.jsonl`), JSON.stringify(ev) + '\n');
}

export function readLog(projectId, day = today()) {
  try {
    return fs.readFileSync(path.join(LOG_DIR, `${projectId}-${day}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** The UTC day string the log is filed by (ADR-0002: the boundary is the log's own, not local time). */
export function today() { return new Date().toISOString().slice(0, 10); }

/** The one place the money key is derived, so state.mjs, flow.mjs and pipeline.mjs can never disagree on it (ADR-0002). */
export function sessionKey({ session, agent }) { return session ?? agent; }

/**
 * One `costs`-map entry built from a `session.cost` event: the agent alongside the total
 * (not just the map key) so a key that turns out to be a session id, not a crew id, can
 * still be read back under its real agent, and `session` carried through unchanged so
 * costEvents can tell a session-keyed entry from a legacy agent-keyed one by looking at the
 * entry itself rather than re-deriving it from the key (ADR-0001, ADR-0002).
 */
export function costEntry(ev) {
  return { agent: ev.agent, usd: ev.usd, ...(ev.session ? { session: ev.session } : {}) };
}

/**
 * A day's `session.cost` events reduced to the latest entry per session key
 * (`ev.session ?? ev.agent`) -- the boot-time seed so a restart never makes the figure
 * shown to the scene jump backwards. A cost event replaces its key's total rather than
 * adding to it (ADR-0002); malformed or unrelated entries are skipped, not thrown on.
 */
export function runningTotals(events) {
  const totals = {};
  for (const ev of events ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type !== 'session.cost') continue;
    if (typeof ev.agent !== 'string' || typeof ev.usd !== 'number') continue;
    totals[sessionKey(ev)] = costEntry(ev);
  }
  return totals;
}

/**
 * One identity's latest running total out of a `runningTotals`-shaped map. Tries the
 * session key first (once a `session.cost` event carries `session`, ADR-0002), then falls
 * back to the plain agent key -- the shape every event has today, and what a log written
 * before the `session` field existed will always produce (ADR-0001). Without this fallback
 * a session id becoming known makes the seed silently resolve to 0.
 */
export function runningTotalFor(costs, { agent, session }) {
  return costs?.[sessionKey({ agent, session })]?.usd ?? costs?.[agent]?.usd ?? 0;
}

/** The manager's own running total out of `state.costs` -- the one lookup flow.mjs and pipeline.mjs both need, kept in one place so they can't drift apart. */
export function managerRunningTotal(state) {
  return runningTotalFor(state.costs, { agent: 'manager', session: state.managerSessionId });
}

/** `state.costs` turned back into the `session.cost` events a newly-connected scene needs. */
export function costEvents(costs) {
  return Object.values(costs ?? {}).map(({ agent, usd, session }) => ({ agent, usd, ...(session ? { session } : {}) }));
}
