// events.js -- the contract between the scene and whatever drives it (mock or server).
//
// One flat JSON object per event. Every event carries `v` (schema version), `t` (ms since
// epoch) and `type`; the rest is per type. Both sides validate with the same table, so a
// field renamed on one side fails loudly on the other instead of silently doing nothing.

export const EVENT_VERSION = 1;

/**
 * Required fields per type. `agent` is the crew id. `ticket` is the ticket id ("03").
 * Scene → driver messages are listed too because the mock answers them.
 */
export const SCHEMA = {
  // ---- driver → scene: the flow ------------------------------------------------
  'flow.phase':       ['phase'],                          // + hitl?, feature?
  'flow.ask':         ['askId', 'kind', 'text'],          // kind: question | seams | tickets
  'board.update':     ['tickets'],                        // full list, see TICKET_STATUS
  'docs.update':      ['path'],                           // + content?, kind?
  'project.status':   ['project', 'steps'],               // steps: [{n, title, state, detail}]
  // ---- driver → scene: one agent -----------------------------------------------
  'agent.start':      ['agent', 'ticket', 'brief'],       // + mode: implement|review|verify|research
  'agent.tool':       ['agent', 'tool', 'summary'],
  'agent.say':        ['agent', 'text'],
  'agent.ask':        ['agent', 'askId', 'tool', 'summary'],
  'agent.done':       ['agent', 'ticket', 'result', 'summary'],   // result: done | blocked | fail
  'agent.stalled':    ['agent', 'ticket', 'minutes'],
  'agent.retry':      ['agent', 'ticket', 'attempt', 'note'],
  'ticket.escalated': ['ticket', 'reason'],
  'review.result':    ['agent', 'ticket', 'standards', 'spec', 'verdict'],   // verdict: pass | fail
  'verify.result':    ['agent', 'ticket', 'criteria', 'verdict'],           // criteria: [{text, pass}]
  'gate.result':      ['agent', 'ticket', 'gate', 'pass', 'output'],        // gate: test|typecheck|e2e
  'ticket.closed':    ['ticket', 'report'],               // report: markdown, template level 1
  'feature.report':   ['feature', 'report'],              // report: markdown, template level 2
  'ci.status':        ['pr', 'state'],
  'error':            ['message'],
  // ---- scene → driver ------------------------------------------------------------
  'command':          ['text'],
  'flow.answer':      ['askId'],                          // + text? / approved?
  'answer':           ['askId', 'allow'],
  'project.add':      ['path'],
  'project.select':   ['project'],
  'project.recheck':  ['project', 'step'],
  'merge':            ['branch'],
  'cancel':           [],
  'replay':           ['job'],
};

export const PHASES = ['onboard', 'grill', 'spec', 'tickets', 'implement', 'done'];

export const TICKET_STATUS = ['blocked', 'ready', 'in-progress', 'review', 'verify', 'done', 'needs-human'];

export function make(type, fields = {}) {
  return { v: EVENT_VERSION, t: Date.now(), type, ...fields };
}

/** @returns string[] of problems; empty when the event is well-formed. */
export function validate(ev) {
  const errs = [];
  if (!ev || typeof ev !== 'object') return ['not an object'];
  if (ev.v !== EVENT_VERSION) errs.push(`v: expected ${EVENT_VERSION}, got ${ev.v}`);
  if (typeof ev.t !== 'number') errs.push('t: missing');
  const req = SCHEMA[ev.type];
  if (!req) { errs.push(`type: unknown "${ev.type}"`); return errs; }
  for (const f of req) if (ev[f] === undefined || ev[f] === null) errs.push(`${f}: missing`);
  if (ev.type === 'flow.phase' && !PHASES.includes(ev.phase)) errs.push(`phase: unknown "${ev.phase}"`);
  if (ev.type === 'board.update') {
    if (!Array.isArray(ev.tickets)) errs.push('tickets: not an array');
    else ev.tickets.forEach((tk, i) => {
      if (!tk.id) errs.push(`tickets[${i}].id: missing`);
      if (!TICKET_STATUS.includes(tk.status)) errs.push(`tickets[${i}].status: "${tk.status}"`);
    });
  }
  return errs;
}

/** Tickets whose blockers are all done and nobody has claimed: what the team can grab now. */
export function frontier(tickets) {
  const done = new Set(tickets.filter((t) => t.status === 'done').map((t) => t.id));
  return tickets.filter((t) => t.status === 'ready' && !t.assignee
    && (t.blockedBy ?? []).every((b) => done.has(b)));
}
