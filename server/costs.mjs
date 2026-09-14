// costs.mjs -- the running-total-per-session accounting rules (ADR-0002): how one event
// folds into state.runningTotals, how a day's log seeds it at boot, and how it reads back
// out. flow.mjs and pipeline.mjs call managerRunningTotal(); index.mjs calls the rest.

import { dayOf } from './state.mjs';

/** The one place the money key is derived, so callers can never disagree on it (ADR-0002). */
export function sessionKey({ agent, session }) { return session ?? agent; }

/** One `runningTotals`-entry built from a `session.cost` event (ADR-0001: `session` is optional). */
export function costEntry(ev) {
  return { agent: ev.agent, usd: ev.usd, ...(ev.session ? { session: ev.session } : {}) };
}

/** Folds one event into a running-totals map, replacing its session's entry (ADR-0002); a malformed or unrelated event passes through unchanged. */
export function foldCost(totals, ev) {
  if (!ev || typeof ev !== 'object') return totals;
  if (ev.type !== 'session.cost') return totals;
  if (typeof ev.agent !== 'string' || typeof ev.usd !== 'number') return totals;
  return { ...totals, [sessionKey(ev)]: costEntry(ev) };
}

/** A day's `session.cost` events reduced to the latest entry per session key -- the boot-time seed for `state.runningTotals`. */
export function runningTotals(events) {
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

/** `state.runningTotals` turned back into the `session.cost` events a newly-connected scene needs. */
export function costEvents(totals) {
  return Object.values(totals ?? {});
}
