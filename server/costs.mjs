// costs.mjs -- the running-total-per-session accounting rules (ADR-0002): how one event
// folds into a running-totals map, how a day's log derives the boot-time seed, and how the
// manager reads its own total back. flow.mjs and pipeline.mjs call managerRunningTotal();
// index.mjs calls the rest and is the one that actually assigns state.runningTotals.

import { dayOf } from './state.mjs';

/** @typedef {{ agent: string, usd: number, session?: string }} CostFields -- one session key's entry: the running total, the agent it belongs to, and its session id once known (ADR-0001). */

/** The session key a running total is filed under (see CONTEXT.md, ADR-0002). */
export function sessionKey({ agent, session }) { return session ?? agent; }

/** @returns {CostFields} -- the shape both a running-totals entry (foldCost) and a live session.cost payload (runner.mjs) build `session` onto. */
export function costFields(agent, usd, session) {
  return { agent, usd, ...(session ? { session } : {}) };
}

/** Folds one event into a running-totals map, replacing its session key's entry (ADR-0002); a malformed or unrelated event passes through unchanged. */
export function foldCost(totals, ev) {
  if (!ev || typeof ev !== 'object') return totals;
  if (ev.type !== 'session.cost') return totals;
  if (typeof ev.agent !== 'string' || typeof ev.usd !== 'number') return totals;
  return { ...totals, [sessionKey(ev)]: costFields(ev.agent, ev.usd, ev.session) };
}

/** A day's `session.cost` events reduced to the latest entry per session key -- the boot-time seed for `state.runningTotals` (spec: "the server's day-seed function"). */
export function daySeed(events) {
  let totals = {};
  for (const ev of events ?? []) totals = foldCost(totals, ev);
  return totals;
}

/** Folds one live `session.cost` event into `state.runningTotals`, starting a fresh bucket the moment its day no longer matches the one already held (ADR-0002). */
export function recordCost(st, ev) {
  const day = dayOf(ev);
  if (st.runningTotalsDay !== day) { st.runningTotals = {}; st.runningTotalsDay = day; }
  st.runningTotals = foldCost(st.runningTotals, ev);
}

/** One identity's latest running total: the session key if known, else the plain agent id (ADR-0001 fallback for a pre-ADR-0002 log line). */
export function runningTotalFor(totals, { agent, session }) {
  return totals?.[sessionKey({ agent, session })]?.usd ?? totals?.[agent]?.usd ?? 0;
}

/** The manager's own running total -- the one lookup flow.mjs and pipeline.mjs both defer to, so they can't drift apart. */
export function managerRunningTotal(state) {
  return runningTotalFor(state.runningTotals, { agent: 'manager', session: state.managerSessionId });
}
