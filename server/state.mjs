// state.mjs -- what survives a server restart, and the cost-accounting helpers built on it.
//
// One JSON file per project under server/state/<project>.json holding the manager's SDK
// session id, the active feature, the current phase, the ticket sessions in flight and
// today's running totals by session key (a live mirror of the log, see runningTotals).
// Small enough to rewrite whole on every change. load()/save() persist it; sessionKey,
// runningTotals, recordCost, runningTotalFor, managerRunningTotal and costEvents are the
// money-key helpers flow.mjs, pipeline.mjs and index.mjs call directly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession } from '../src/agents/events.js';

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
  costsDay: null,          // the UTC day `costs` is a bucket for, see recordCost
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
  fs.appendFileSync(path.join(LOG_DIR, `${projectId}-${dayOf(ev)}.jsonl`), JSON.stringify(ev) + '\n');
}

export function readLog(projectId, day = today()) {
  try {
    return fs.readFileSync(path.join(LOG_DIR, `${projectId}-${day}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

/** The UTC day string the log is filed by (ADR-0002: the boundary is the log's own, not local time). */
export function today() { return new Date().toISOString().slice(0, 10); }

/** The UTC day one event's own timestamp falls on -- what `today()` reduces to once an event, not the clock, is the source of the day. */
export function dayOf(ev) { return new Date(ev?.t ?? Date.now()).toISOString().slice(0, 10); }

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
  return withSession({ agent: ev.agent, usd: ev.usd }, ev.session);
}

/** Folds one event into a `costs` map, replacing its session's entry (ADR-0002); anything that isn't a well-formed session.cost line is returned unchanged. Shared by runningTotals (a whole log) and recordCost (one live event) so the guard can't drift between them. */
export function foldCost(costs, ev) {
  if (!ev || typeof ev !== 'object') return costs;
  if (ev.type !== 'session.cost') return costs;
  if (typeof ev.agent !== 'string' || typeof ev.usd !== 'number') return costs;
  return { ...costs, [sessionKey(ev)]: costEntry(ev) };
}

/**
 * A day's `session.cost` events reduced to the latest entry per session key
 * (`ev.session ?? ev.agent`) -- the boot-time seed so a restart never makes the figure
 * shown to the scene jump backwards.
 */
export function runningTotals(events) {
  let totals = {};
  for (const ev of events ?? []) totals = foldCost(totals, ev);
  return totals;
}

/**
 * Folds one live `session.cost` event into `state.costs`, discarding the previous bucket the
 * moment the event's own day no longer matches it (ADR-0002's "old bucket is discarded") --
 * the running counterpart to `runningTotals`' one-shot reduction over a whole log, so
 * index.mjs's broadcast() neither reimplements the fold nor lets `costs` grow across a UTC
 * midnight the server happens to stay up through.
 */
export function recordCost(st, ev) {
  const day = dayOf(ev);
  if (st.costsDay !== day) { st.costs = {}; st.costsDay = day; }
  st.costs = foldCost(st.costs, ev);
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

/**
 * `state.costs` turned back into the `session.cost` events a newly-connected scene needs. A
 * legacy agent-keyed entry (ADR-0001, no `session`) is dropped once that same agent also has a
 * session-keyed entry: both would otherwise replay as if they were two sessions, and the
 * Director would sum the stale figure into the member's cost a second time -- exactly the
 * accumulation a running total is defined not to do (CONTEXT.md).
 */
export function costEvents(costs) {
  const entries = Object.values(costs ?? {});
  const sessioned = new Set(entries.filter((e) => e.session).map((e) => e.agent));
  return entries
    .filter((e) => e.session || !sessioned.has(e.agent))
    .map(({ agent, usd, session }) => withSession({ agent, usd }, session));
}
