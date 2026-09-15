// mock.test.js -- the scripted demo (mock.js) is the one place ticket 04 lives: no DOM seam
// exists for the roster row or the panel figure (see spec.md's Testing Decisions), so these
// tests drive the script's own events through the Director exactly as tests/director.test.js
// does, checking that what the demo *authors* satisfies the acceptance criteria rather than
// re-testing aggregation rules already covered there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../src/agents/director.js';
import { validate } from '../src/agents/events.js';
import { demoScript } from '../src/agents/mock.js';
import { HOME_SEAT, MEETING_SEATS } from '../src/agents/team.js';

// ---------------------------------------------------------------- fakes (same shape as director.test.js)
function fakeCrew(ids) {
  const seats = new Map(Object.values(HOME_SEAT).concat(MEETING_SEATS).map((n, i) =>
    [n, { name: n, three: { approach: [i, 0, -i], seat: [i, 0.45, -i] } }]));
  const crew = {
    calls: [],
    pack: { seats },
    members: ids.map((id, i) => ({
      id, label: id, model: id, home: [i, -i],
      obj: { position: { x: i, y: 0, z: -i } },
      ctl: { state: 'idle', seat: null },
    })),
    sendToSeat(seat, member) { crew.calls.push(['seat', member.id, seat]); return { member }; },
    sendTo(x, z, member) { crew.calls.push(['walk', member.id, x, z]); return member; },
  };
  return crew;
}
const fakeBubbles = () => ({ calls: [], say(m, text, o) { this.calls.push([m.id, text, o?.kind]); }, clear(m) { this.calls.push([m.id, null]); } });
const fakePanel = () => new Proxy({ calls: [] }, {
  get(t, k) { return k === 'calls' ? t.calls : (...a) => t.calls.push([k, ...a]); },
});
const fakePlaces = () => ({
  calls: [],
  approach(name) { this.calls.push(['approach', name]); return { x: 9, z: -9 }; },
  highlight(name) { this.calls.push(['highlight', name]); },
});

const IDS = ['manager', 'eng_m1', 'eng_f1', 'eng_m2', 'eng_f2', 'eng_m3'];
function setup() {
  const crew = fakeCrew(IDS), bubbles = fakeBubbles(), panel = fakePanel(), places = fakePlaces();
  const d = new Director({ crew, bubbles, panel, places });
  return { d, crew, bubbles, panel, places };
}

/** Drive every event in the script through the Director, exactly as main.js's receive() does:
 *  a `hello` step is a connection snapshot, not something the Director handles itself. */
function replay(d, script) {
  let budget;
  for (const step of script) {
    const e = step.ev ?? step.ask ?? step.toolAsk;
    if (!e) continue;
    if (e.type === 'hello') { budget = e.snapshot?.dailyBudgetUsd; d.setBudget(budget); continue; }
    d.handle(e);
  }
  return budget;
}

// ---------------------------------------------------------------- tests
test('the demo script opens with a hello event carrying a fake daily budget, same as the server', () => {
  const [first] = demoScript();
  assert.ok(first.ev, 'first step is an event');
  assert.equal(first.ev.type, 'hello');
  assert.deepEqual(validate(first.ev), []);
  assert.equal(typeof first.ev.snapshot?.dailyBudgetUsd, 'number');
  assert.ok(first.ev.snapshot.dailyBudgetUsd > 0);
});

test('every event the demo script emits validates against the schema', () => {
  for (const step of demoScript()) {
    const e = step.ev ?? step.ask ?? step.toolAsk;
    if (!e) continue;
    assert.deepEqual(validate(e), [], `${e.type} should validate`);
  }
});

test('the mock emits session.cost with a session id as the scripted flow plays, rising per session', () => {
  const costs = demoScript().filter((s) => s.ev?.type === 'session.cost').map((s) => s.ev);
  assert.ok(costs.length > 5, 'the flow reports cost more than once');
  assert.ok(costs.every((c) => typeof c.session === 'string' && c.session.length > 0),
    'every cost event carries a session id');
  const bySession = new Map();
  for (const c of costs) {
    const prev = bySession.get(c.session);
    assert.ok(prev === undefined || c.usd >= prev, `${c.session} running total must not fall`);
    bySession.set(c.session, c.usd);
  }
});

test('at least one crew member ends the demo with a figure summing more than one session', () => {
  const { d } = setup();
  replay(d, demoScript());
  const costs = demoScript().filter((s) => s.ev?.type === 'session.cost').map((s) => s.ev);
  const sessionsByAgent = new Map();
  for (const c of costs) {
    const set = sessionsByAgent.get(c.agent) ?? new Set();
    set.add(c.session);
    sessionsByAgent.set(c.agent, set);
  }
  const multi = [...sessionsByAgent.entries()].filter(([, set]) => set.size > 1);
  assert.ok(multi.length > 0, 'at least one agent id has more than one session key');
  const [agent] = multi[0];
  // the roster figure must be the sum of the sessions, not merely the last one emitted
  const lastPerSession = new Map();
  for (const c of costs) if (c.agent === agent) lastPerSession.set(c.session, c.usd);
  const expected = [...lastPerSession.values()].reduce((a, b) => a + b, 0);
  assert.equal(d.memberCost(agent), expected);
  assert.ok(d.memberCost(agent) > Math.max(...lastPerSession.values()),
    'the summed figure must exceed any single session on its own');
});

test('the team figure reaches the warning band before the scripted run finishes', () => {
  const { d } = setup();
  const script = demoScript();
  let budget;
  let warnIndex = -1;
  script.forEach((step, i) => {
    const e = step.ev ?? step.ask ?? step.toolAsk;
    if (!e) return;
    if (e.type === 'hello') { budget = e.snapshot?.dailyBudgetUsd; d.setBudget(budget); return; }
    d.handle(e);
    if (warnIndex === -1 && d.teamCost() >= budget * 0.8) warnIndex = i;
  });
  assert.notEqual(warnIndex, -1, 'the team figure never reaches 80% of the fake budget');
  assert.ok(warnIndex < script.length - 5,
    'the warning band should be reached with the run still going, not only on its final beat');
  assert.ok(d.teamCost() < budget, 'the demo should not need to exceed the budget to show the warning');
});
