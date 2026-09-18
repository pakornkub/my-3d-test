import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../src/agents/director.js';
import { make } from '../src/agents/events.js';
import { HOME_SEAT, MEETING_SEATS } from '../src/agents/team.js';

// ---------------------------------------------------------------- fakes
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

// ---------------------------------------------------------------- tests
test('malformed events are dropped, not thrown', () => {
  const { d, crew } = setup();
  assert.equal(d.handle({ type: 'agent.start' }), false);
  assert.deepEqual(crew.calls, []);
});

test('grill phase sends the manager to the meeting table', () => {
  const { d, crew } = setup();
  d.handle(make('flow.phase', { phase: 'grill' }));
  assert.deepEqual(crew.calls, [['seat', 'manager', MEETING_SEATS[0]]]);
  assert.equal(d.status.manager.state, 'meeting');
});

test('architecture phase brings the manager back to the meeting table for the grilling', () => {
  const { d, crew } = setup();
  d.handle(make('flow.phase', { phase: 'architecture', hitl: true }));
  assert.deepEqual(crew.calls, [['seat', 'manager', MEETING_SEATS[0]]]);
  assert.equal(d.status.manager.state, 'meeting');
});

test('agent.start puts an implementer on their own chair, QA at the TV, reviewer at their desk', () => {
  const { d, crew, places } = setup();
  d.handle(make('agent.start', { agent: 'eng_m1', ticket: '01', brief: 'x' }));
  d.handle(make('agent.start', { agent: 'eng_m3', ticket: '01', brief: 'x' }));
  d.handle(make('agent.start', { agent: 'eng_f2', ticket: '01', brief: 'x' }));
  assert.deepEqual(crew.calls[0], ['seat', 'eng_m1', HOME_SEAT.eng_m1]);
  assert.deepEqual(crew.calls[1], ['walk', 'eng_m3', 9, -9]);
  assert.deepEqual(places.calls[0], ['approach', 'TV']);
  assert.deepEqual(crew.calls[2], ['seat', 'eng_f2', HOME_SEAT.eng_f2]);
  assert.equal(d.status.eng_m1.state, 'working');
  assert.equal(d.status.eng_m3.state, 'verifying');
  assert.equal(d.status.eng_f2.state, 'reviewing');
  assert.equal(d.status.eng_m1.ticket, '01');
});

test('agent.ask makes the person stand by their desk and wait; answered() sits them back down', () => {
  const { d, crew, panel } = setup();
  d.handle(make('agent.start', { agent: 'eng_m2', ticket: '03', brief: 'x' }));
  d.handle(make('agent.ask', { agent: 'eng_m2', askId: 'p1', tool: 'Bash', summary: 'git push' }));
  const approach = crew.pack.seats.get(HOME_SEAT.eng_m2).three.approach;
  assert.deepEqual(crew.calls.at(-1), ['walk', 'eng_m2', approach[0], approach[2]]);
  assert.equal(d.status.eng_m2.state, 'waiting');
  assert.ok(panel.calls.some(([k]) => k === 'approval'));
  d.answered('p1');
  assert.deepEqual(crew.calls.at(-1), ['seat', 'eng_m2', HOME_SEAT.eng_m2]);
  assert.equal(d.status.eng_m2.state, 'working');
  assert.equal(d.status.eng_m2.ticket, '03');
});

test('agent.done walks to the manager desk; ticket.closed sends everyone on that ticket home', () => {
  const { d, crew, places } = setup();
  d.handle(make('board.update', { tickets: [{ id: '01', status: 'in-progress', assignee: 'eng_m1' }] }));
  d.handle(make('agent.start', { agent: 'eng_m1', ticket: '01', brief: 'x' }));
  d.handle(make('agent.start', { agent: 'eng_f2', ticket: '01', brief: 'review' }));
  d.handle(make('agent.done', { agent: 'eng_m1', ticket: '01', result: 'done', summary: 'ok' }));
  assert.ok(places.calls.some(([k, n]) => k === 'approach' && n === 'ManagerDesk'));
  assert.equal(d.status.eng_m1.state, 'done');
  d.handle(make('ticket.closed', { ticket: '01', report: '# ok' }));
  const walksHome = crew.calls.filter(([k, id, x, z]) => k === 'walk' && ((id === 'eng_m1' && x === 1 && z === -1) || (id === 'eng_f2' && x === 4 && z === -4)));
  assert.equal(walksHome.length, 2);
  assert.equal(d.status.eng_m1.state, 'idle');
  assert.equal(d.status.eng_f2.state, 'idle');
});

test('a failed review sends the implementer back to their chair', () => {
  const { d, crew } = setup();
  d.handle(make('review.result', { agent: 'eng_f2', ticket: '02', assignee: 'eng_f1', standards: ['dup'], spec: [], verdict: 'fail' }));
  assert.deepEqual(crew.calls.at(-1), ['seat', 'eng_f1', HOME_SEAT.eng_f1]);
  assert.equal(d.status.eng_f1.state, 'working');
  assert.equal(d.status.eng_f2.state, 'error');
});

test('escalation frees the assignee and the manager carries the warning', () => {
  const { d, bubbles } = setup();
  d.handle(make('board.update', { tickets: [{ id: '03', status: 'in-progress', assignee: 'eng_m2' }] }));
  d.handle(make('agent.start', { agent: 'eng_m2', ticket: '03', brief: 'x' }));
  d.handle(make('ticket.escalated', { ticket: '03', reason: 'stuck twice' }));
  assert.equal(d.status.eng_m2.state, 'idle');
  assert.ok(bubbles.calls.some(([id, text, kind]) => id === 'manager' && kind === 'error' && text.includes('03')));
});

test('feature.report: manager to the TV, everyone else gathers at the meeting table', () => {
  const { d, crew, places, panel } = setup();
  d.handle(make('feature.report', { feature: 'f', report: '# r' }));
  assert.deepEqual(places.calls[0], ['approach', 'TV']);
  const seated = crew.calls.filter(([k]) => k === 'seat').map(([, id, s]) => [id, s]);
  assert.deepEqual(seated, [['eng_m1', 'MC1'], ['eng_f1', 'MC2'], ['eng_m2', 'MC3'], ['eng_f2', 'MC4']]);
  assert.ok(crew.calls.some(([k, id]) => k === 'walk' && id === 'eng_m3'));   // no chair left: stands
  assert.ok(panel.calls.some(([k, a]) => k === 'tv' && a.markdown === '# r'));
});

test('flow.phase done returns everyone to their spawn point and the manager to their chair', () => {
  const { d, crew } = setup();
  d.handle(make('flow.phase', { phase: 'done' }));
  const walks = crew.calls.filter(([k]) => k === 'walk').map(([, id]) => id);
  assert.equal(new Set(walks).size, IDS.length - 1);
  assert.ok(!walks.includes('manager'));
  assert.deepEqual(crew.calls.find(([k, id]) => k === 'seat' && id === 'manager'), ['seat', 'manager', HOME_SEAT.manager]);
  assert.ok(Object.values(d.status).every((s) => s.state === 'idle'));
});

// ---------------------------------------------------------------- money
test('a cost event replaces the running total for its session, it does not accumulate', () => {
  const { d } = setup();
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.42 }));
  assert.equal(d.memberCost('eng_m1'), 0.42);
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.90 }));
  assert.equal(d.memberCost('eng_m1'), 0.90);
});

test('member cost sums the latest running totals across two sessions of one member', () => {
  const { d } = setup();
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.90 }));
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's2', usd: 0.10 }));
  assert.equal(d.memberCost('eng_m1'), 1.00);
});

test('a cost event for an agent id off the roster changes no member figure and does not throw', () => {
  const { d } = setup();
  assert.doesNotThrow(() => d.handle(make('session.cost', { agent: 'someone_else', session: 's9', usd: 5 })));
  assert.equal(d.memberCost('someone_else'), 5);
  for (const id of IDS) assert.equal(d.memberCost(id), undefined);
});

test('members who have received no cost event have no member figure', () => {
  const { d } = setup();
  assert.equal(d.memberCost('eng_f1'), undefined);
});

test('a cost event on a new UTC day starts a fresh bucket and discards the old one', () => {
  const { d } = setup();
  const day1 = Date.UTC(2026, 0, 1, 12);
  const day2 = Date.UTC(2026, 0, 2, 1);
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 3, t: day1 }));
  assert.equal(d.memberCost('eng_m1'), 3);
  d.handle(make('session.cost', { agent: 'eng_f1', session: 's2', usd: 1, t: day2 }));
  assert.equal(d.memberCost('eng_m1'), undefined);
  assert.equal(d.memberCost('eng_f1'), 1);
});

test('a legacy cost event with no session field is still accounted, keyed on the agent id', () => {
  const { d } = setup();
  d.handle(make('session.cost', { agent: 'eng_m1', usd: 0.25 }));
  assert.equal(d.memberCost('eng_m1'), 0.25);
});

test('team cost is zero before any cost event', () => {
  const { d } = setup();
  assert.equal(d.teamCost(), 0);
});

test('team cost sums every session today, including an id off the roster', () => {
  const { d } = setup();
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.42 }));
  d.handle(make('session.cost', { agent: 'someone_else', session: 's9', usd: 5 }));
  assert.equal(d.teamCost(), 5.42);
});

test('breakdown lists every agent id that has spent money, summed across its sessions', () => {
  const { d } = setup();
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 0.9 }));
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's2', usd: 0.1 }));
  d.handle(make('session.cost', { agent: 'someone_else', session: 's9', usd: 5 }));
  assert.deepEqual(d.breakdown(), { eng_m1: 1, someone_else: 5 });
});

test('setBudget stores the budget and republishes the team figure to the panel', () => {
  const { d, panel } = setup();
  d.setBudget(10);
  assert.equal(d.budget, 10);
  const call = panel.calls.find(([k]) => k === 'cost');
  assert.deepEqual(call, ['cost', { team: 0, budget: 10, breakdown: {} }]);
});

test('a session.cost event republishes team, budget and breakdown to the panel', () => {
  const { d, panel } = setup();
  d.setBudget(10);
  d.handle(make('session.cost', { agent: 'eng_m1', session: 's1', usd: 1.5 }));
  const call = panel.calls.filter(([k]) => k === 'cost').at(-1);
  assert.deepEqual(call, ['cost', { team: 1.5, budget: 10, breakdown: { eng_m1: 1.5 } }]);
});
