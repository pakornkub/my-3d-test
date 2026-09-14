// state.mjs -- what survives a server restart.
//
// One JSON file per project under server/state/<project>.json holding the manager's SDK
// session id, the active feature, the current phase and the ticket sessions in flight.
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
  costUsd: 0,
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

export function readLog(projectId, day = new Date().toISOString().slice(0, 10)) {
  try {
    return fs.readFileSync(path.join(LOG_DIR, `${projectId}-${day}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
