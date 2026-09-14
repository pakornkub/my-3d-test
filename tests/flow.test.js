import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Flow } from '../server/flow.mjs';

// an empty repo per test: a real .scratch/ would start an fs.watch and keep the runner alive
const emptyRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ube-flow-'));

/** A stand-in for runner.Session: records what was sent, answers with canned text. */
function fakeSession(script = {}) {
  return {
    sent: [], init: { slash_commands: script.commands ?? [] }, closed: false, sessionId: 'sess-1',
    costUsd: 0.5, lastText: '',
    hasCommand(name) { return this.init.slash_commands.includes(name); },
    async start() {},
    async send(text) { this.sent.push(text); this.lastText = script.reply?.(text) ?? 'ถามกลับ: อยากได้แบบไหน?'; return { type: 'result', subtype: 'success' }; },
    async interrupt() {}, close() { this.closed = true; },
  };
}

function setup({ phase = 'implement', feature = null, commands } = {}) {
  const events = [];
  const s = fakeSession({ commands });
  const state = { phase, feature, managerSessionId: null, costUsd: 0 };
  const flow = new Flow({
    project: { id: 'p', path: emptyRepo(), mainBranch: 'main' },
    state, team: { manager: { prompt: 'คุณคือผู้จัดการ', model: 'claude-opus-5', tools: [] } },
    office: null, emit: (e) => events.push(e), approvals: null, save: () => {}, createSession: () => s,
  });
  return { flow, s, state, events, types: () => events.map((e) => e.type) };
}

test('an idea while idle starts the interview: phase grill, grill skill sent, question surfaced as flow.ask', async () => {
  const { flow, s, state, events } = setup();
  await flow.onCommand('อยากได้ X');
  assert.equal(state.phase, 'grill');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /grilling|grill-with-docs/);
  assert.match(s.sent[0], /อยากได้ X/);
  const ask = events.find((e) => e.type === 'flow.ask');
  assert.ok(ask, 'flow.ask emitted');
  assert.equal(ask.kind, 'question');
  assert.match(ask.text, /อยากได้แบบไหน/);
  assert.equal(state.managerSessionId, 'sess-1');
});

test('a registered slash command is preferred over inlining the skill body', async () => {
  const { flow, s } = setup({ commands: ['/mattpocock-skills:grill-with-docs'] });
  await flow.onCommand('idea');
  assert.equal(s.sent[0], '/mattpocock-skills:grill-with-docs idea');
});

test('answering a flow.ask sends the text back as the next turn; an empty answer becomes an OK', async () => {
  const { flow, s, events } = setup({ phase: 'grill', feature: 'f' });
  await flow.onFlowAnswer('x', { text: 'เอาแบบ A' });
  assert.equal(s.sent.at(-1), 'เอาแบบ A');
  await flow.onFlowAnswer('y', { text: '', approved: true });
  assert.match(s.sent.at(-1), /โอเค/);
  assert.equal(events.filter((e) => e.type === 'flow.ask').length, 2);
});

test('next: spec then tickets advance the phase in order and refuse to go backwards', async () => {
  const { flow, s, state, events } = setup({ phase: 'grill', feature: 'f' });
  await flow.onNext('spec');
  assert.equal(state.phase, 'spec');
  assert.match(s.sent.at(-1), /to-spec|Problem Statement/);
  assert.equal(events.filter((e) => e.type === 'flow.ask').at(-1).kind, 'seams');
  await flow.onNext('tickets');
  assert.equal(state.phase, 'tickets');
  assert.match(s.sent.at(-1), /to-tickets|tracer/i);
  const n = s.sent.length;
  await flow.onNext('grill');   // allowed: re-open the interview
  assert.equal(state.phase, 'grill');
  await flow.onNext('spec');    // forward again is fine
  assert.equal(state.phase, 'spec');
  await flow.onNext('grill');
  await flow.onNext('onboard'); // backwards to onboard is refused
  assert.equal(state.phase, 'grill');
  assert.ok(s.sent.length >= n);
});

test('a message during onboarding is refused without touching the session', async () => {
  const { flow, s, events } = setup({ phase: 'onboard' });
  await flow.onCommand('hi');
  assert.equal(s.sent.length, 0);
  assert.match(events.at(-1).text, /onboarding/);
});
