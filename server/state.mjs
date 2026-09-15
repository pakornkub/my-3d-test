// state.mjs -- what survives a server restart: one JSON file per project under
// server/state/<project>.json, load()/save()'d whole, and the append-only per-day event
// log (logEvent/readLog) it can be rebuilt from. state.runningTotals is one of its fields;
// costs.mjs computes what goes into it, index.mjs is the one that assigns and saves it.

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
  jobs: {},                // ticket id -> { agent, sessionId, attempt, status, worktree, usd/usdWasted (pipeline.mjs) }
  runningTotals: {},       // session key (`ev.session ?? ev.agent`) -> { agent, usd }, see costs.mjs
  runningTotalsDay: null,  // the UTC day `runningTotals` is a bucket for, see costs.mjs:recordCost
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

/** The UTC day one event's own timestamp falls on. */
export function dayOf(ev) { return new Date(ev?.t ?? Date.now()).toISOString().slice(0, 10); }
