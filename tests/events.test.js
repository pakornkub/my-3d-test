import { test } from 'node:test';
import assert from 'node:assert/strict';
import { make, validate, frontier, SCHEMA, EVENT_VERSION } from '../src/agents/events.js';

test('make() stamps version, time and type', () => {
  const e = make('agent.say', { agent: 'eng_m1', text: 'hi' });
  assert.equal(e.v, EVENT_VERSION);
  assert.equal(typeof e.t, 'number');
  assert.equal(e.type, 'agent.say');
  assert.deepEqual(validate(e), []);
});

test('validate() rejects a missing required field', () => {
  const e = make('agent.tool', { agent: 'eng_m1', tool: 'Edit' });   // no summary
  assert.deepEqual(validate(e), ['summary: missing']);
});

test('validate() rejects an unknown type and a wrong version', () => {
  assert.ok(validate({ v: EVENT_VERSION, t: 1, type: 'nope' }).some((s) => s.startsWith('type: unknown')));
  assert.ok(validate({ ...make('cancel'), v: 99 }).some((s) => s.startsWith('v:')));
});

test('validate() checks phases and ticket statuses', () => {
  assert.ok(validate(make('flow.phase', { phase: 'lunch' })).some((s) => s.startsWith('phase:')));
  const bad = make('board.update', { tickets: [{ id: '01', status: 'weird' }] });
  assert.ok(validate(bad).some((s) => s.includes('status')));
  const good = make('board.update', { tickets: [{ id: '01', status: 'ready' }] });
  assert.deepEqual(validate(good), []);
});

test('every schema entry can be built with its required fields', () => {
  for (const [type, fields] of Object.entries(SCHEMA)) {
    const e = make(type, Object.fromEntries(fields.map((f) => [f, f === 'tickets' ? [] : f === 'phase' ? 'grill' : 'x'])));
    assert.deepEqual(validate(e), [], type);
  }
});

test('frontier() = ready, unclaimed, and every blocker done', () => {
  const tickets = [
    { id: '01', status: 'done', blockedBy: [] },
    { id: '02', status: 'ready', blockedBy: [] },
    { id: '03', status: 'ready', blockedBy: ['01'] },
    { id: '04', status: 'ready', blockedBy: ['02'] },
    { id: '05', status: 'ready', blockedBy: [], assignee: 'eng_m1' },
    { id: '06', status: 'blocked', blockedBy: ['01'] },
  ];
  assert.deepEqual(frontier(tickets).map((t) => t.id), ['02', '03']);
});
